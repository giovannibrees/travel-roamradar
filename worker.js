// RoamRadar sync worker (Cloudflare)
// One hub. Your app is the only UI. Everything else is headless:
//   - Google Calendar    reads events you already drop in (Booking, Airbnb...) as trip segments, writes one clean event per trip
//   - Gmail + Claude      parses confirmation emails (drivers, transfers) into segments
//   - TripIt API          OPTIONAL drop-in replacement for ingestion (see note in ingestSegments)
//
// Storage: one KV namespace bound as TRIPS, single JSON doc under key "store".
// Secrets (wrangler secret put NAME) - all optional, everything connects in-app too:
//   ANTHROPIC_API_KEY
//   GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET  GOOGLE_REFRESH_TOKEN  GOOGLE_CALENDAR_ID(optional, default "primary")
//   CALENDLY_TOKEN (optional)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // --- Password gate. The password is set in-app and stored hashed in KV; no
    // dashboard secret needed. Once set, /trips and /sync require the X-Auth token.
    if (url.pathname === "/auth/status" && request.method === "GET") {
      return cors(json({ set: !!(await env.TRIPS.get("auth")) }));
    }
    if (url.pathname === "/auth/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const pw = (body && body.password) || "";
      const email = ((body && body.email) || "").trim().toLowerCase();
      if (!pw || !email) return cors(json({ error: "email and password required" }, 400));
      const hash = await sha256(pw);
      const storedHash = await env.TRIPS.get("auth");
      const storedEmail = await env.TRIPS.get("auth_email");
      if (!storedHash) {                                       // first-time setup
        await env.TRIPS.put("auth", hash);
        await env.TRIPS.put("auth_email", email);
        ctx.waitUntil(pingInstallCount(env));                   // one anonymous "an instance exists" ping - see README
        return okLogin(hash);
      }
      if (hash !== storedHash) return cors(json({ error: "wrong email or password" }, 401));
      if (!storedEmail) { await env.TRIPS.put("auth_email", email); } // migrate a password-only setup
      else if (storedEmail !== email) return cors(json({ error: "wrong email or password" }, 401));
      return okLogin(hash);
    }
    // Log out: expire the session cookie. Public (needs no auth) - it only clears.
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const r = cors(json({ ok: true }));
      r.headers.append("Set-Cookie", `tk=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
      return r;
    }
    // --- Google consent flow. These two are plain browser NAVIGATIONS, not app
    // fetches, so they cannot carry the X-Auth header and may lack the session
    // cookie (e.g. a login from before cookies existed, or a PWA's separate
    // cookie jar). /google/connect therefore accepts the session token as ?t=
    // (the app puts it there), and /google/callback is authorised by its
    // single-use state code instead - Google's redirect carries no credentials.
    if (url.pathname === "/google/connect" && request.method === "GET") {
      const stored = await env.TRIPS.get("auth");
      const t = url.searchParams.get("t") || "";
      const cm = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tk=([^;]+)/);
      if (!stored || (t !== stored && (cm ? cm[1] : "") !== stored))
        return new Response("Sign in to the app first, then hit Connect Google again.", { status: 401 });
      const c = await googleClient(env);
      if (!c) return new Response("Save your Google client ID and secret in Settings first.", { status: 400 });
      const state = uid() + uid();
      await env.TRIPS.put("g_state", state, { expirationTtl: 600 });
      const p = new URLSearchParams({
        client_id: c.id, redirect_uri: url.origin + "/google/callback", response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly",
        access_type: "offline", prompt: "consent", state,
      });
      return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p, 302);
    }
    if (url.pathname === "/google/callback" && request.method === "GET") {
      const c = await googleClient(env);
      const state = await env.TRIPS.get("g_state");
      if (!c || !state || url.searchParams.get("state") !== state)
        return new Response("This connection attempt expired - go back to Settings and hit Connect Google again.", { status: 400 });
      await env.TRIPS.delete("g_state");
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.id, client_secret: c.secret, code: url.searchParams.get("code") || "",
          grant_type: "authorization_code", redirect_uri: url.origin + "/google/callback",
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!d.refresh_token)
        return new Response("Google did not hand back a refresh token (" + (d.error_description || d.error || "cancelled") + "). Go back to Settings and try Connect Google again.", { status: 400 });
      await env.TRIPS.put("g_refresh", d.refresh_token);
      return new Response('<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;max-width:520px"><h2>Google connected &#10003;</h2><p>Calendar events and Gmail confirmations will flow into your trips on the next sync.</p><p><a href="/app">Back to the app</a></p>',
        { headers: { "Content-Type": "text/html" } });
    }
    // --- Companion view: a read-only page for ONE trip, authorised by its own
    // unguessable token (128-bit hex minted by POST /trips/share). PUBLIC by
    // design - you send this link to whoever travels with you. Revoking the
    // token (or deleting the trip) kills the page.
    if (url.pathname.startsWith("/t/") && request.method === "GET") {
      const tok = url.pathname.slice(3);
      if (!/^[a-f0-9]{32}$/.test(tok)) return new Response("Not found", { status: 404 });
      const store = await loadStore(env);
      const t = Object.values(store.trips).find((x) => x.shareToken === tok);
      if (!t) return new Response("This trip link is no longer active.", { status: 404 });
      return new Response(shareTripHtml(t), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    // --- Calendar feed: one private ICS URL any calendar app can subscribe to
    // (Apple/Outlook/Google "from URL") - all trips with their plans, no OAuth
    // needed. Authorised by the feed token because calendar apps cannot send
    // headers; the token is minted by POST /ics/token.
    if (url.pathname === "/cal.ics" && request.method === "GET") {
      const tok = url.searchParams.get("t") || "";
      const want = (await env.TRIPS.get("ics_token")) || "";
      if (!want || tok !== want) return new Response("unauthorized", { status: 401 });
      const store = await loadStore(env);
      return new Response(buildIcs(store), { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
    }

    const blocked = await authGuard(request, env);
    if (blocked) return cors(blocked);

    // --- App settings snapshot the front end reads to show connection status.
    // Google and Anthropic connect in-app (keys saved to YOUR OWN KV, used only
    // server-side, never returned to the browser in full) or via dashboard
    // secrets, which always win.
    if (url.pathname === "/settings" && request.method === "GET") {
      const gClient = await googleClient(env);
      const gRefresh = env.GOOGLE_REFRESH_TOKEN || (await env.TRIPS.get("g_refresh")) || "";
      const gIcs = (await env.TRIPS.get("g_ics")) || "";
      return cors(json({
        googleClientSet: !!gClient,
        googleClientId: gClient ? gClient.id : null,
        googleConnected: !!(gClient && gRefresh),
        googleSource: env.GOOGLE_REFRESH_TOKEN ? "secret" : (gRefresh ? "in-app" : "none"),
        gcalIcsSet: !!gIcs,
        gcalIcsMask: gIcs ? maskIcs(gIcs) : null,
        gmailEmail: (await env.TRIPS.get("g_email")) || null,
      }));
    }

    // --- In-app Google connection (self-host friendly).
    // Paste an OAuth client id/secret in Settings, click Connect, approve the
    // consent screen; the refresh token lands in YOUR OWN KV and never leaves
    // the worker. Dashboard secrets (GOOGLE_*), if present, always win.
    if (url.pathname === "/settings/google" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // strip ALL whitespace: Google shows these wrapped over several lines, so copies pick up breaks
      const id = ((body && body.clientId) || "").replace(/\s+/g, "");
      const secret = ((body && body.clientSecret) || "").replace(/\s+/g, "");
      if (!id && !secret) {                                    // disconnect
        await env.TRIPS.delete("g_client");
        await env.TRIPS.delete("g_refresh");
        return cors(json({ ok: true }));
      }
      if (!id || !secret) return cors(json({ error: "Client ID and client secret are both needed." }, 400));
      if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id))
        return cors(json({ error: "That client ID doesn't look right - it should be digits, a dash, letters, ending in .apps.googleusercontent.com (copy it from the Clients page or the JSON's client_id field, not the filename)." }, 400));
      if (!/^GOCSPX-/.test(secret))
        return cors(json({ error: "The client secret starts with GOCSPX- (find it on the client's page or the JSON's client_secret field)." }, 400));
      await env.TRIPS.put("g_client", JSON.stringify({ id, secret }));
      return cors(json({ ok: true }));
    }
    // The Anthropic key that powers email parsing - pasted in-app,
    // self-host friendly. A dashboard secret always wins.
    if (url.pathname === "/settings/anthropickey" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const key = ((body && body.key) || "").replace(/\s+/g, "");
      if (key === "") { await env.TRIPS.delete("anthropic_key"); return cors(json({ ok: true })); }
      if (!/^sk-ant-/.test(key)) return cors(json({ error: "An Anthropic API key starts with sk-ant- (console.anthropic.com -> API Keys)." }, 400));
      await env.TRIPS.put("anthropic_key", key);
      return cors(json({ ok: true }));
    }
    // What can the Google connection actually see? Split by stage, so "no travel
    // info appeared" points at the exact culprit.
    if (url.pathname === "/google/test" && request.method === "GET") {
      const token = await googleToken(env);
      if (!token) return cors(json({ ok: false, error: "Not connected - no refresh token yet." }));
      const out = { ok: true, anthropicKeySet: !!(await anthropicKey(env)) };
      const calId = env.GOOGLE_CALENDAR_ID || "primary";
      try {
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?singleEvents=true&maxResults=250&timeMin=${encodeURIComponent(new Date().toISOString())}&timeMax=${encodeURIComponent(new Date(Date.now() + 400 * 864e5).toISOString())}`,
          { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        out.calendar = r.ok
          ? { ok: true, upcoming: (d.items || []).length,
              sample: (d.items || []).filter((ev) => !(ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.travelSyncTrip))
                .slice(0, 4).map((ev) => (ev.summary || "?") + " (" + ((ev.start && (ev.start.date || ev.start.dateTime)) || "").slice(0, 10) + ")") }
          : { ok: false, error: (d.error && d.error.message) || ("HTTP " + r.status) };
      } catch (e) { out.calendar = { ok: false, error: "unreachable" }; }
      try {
        const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(await gmailQuery(env, token))}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        out.gmail = r.ok ? { ok: true, matches: d.resultSizeEstimate || 0 } : { ok: false, error: (d.error && d.error.message) || ("HTTP " + r.status) };
      } catch (e) { out.gmail = { ok: false, error: "unreachable" }; }
      const store = await loadStore(env);
      out.trips = Object.values(store.trips).filter((t) => t.start && t.end).length;
      out.seenEmails = Object.keys(store.seenEmails || {}).length;
      out.unfiled = (store.unfiled || []).slice(-5);
      return cors(json(out));
    }
    // Forget which emails were already scanned (e.g. after adding the
    // ANTHROPIC_API_KEY). Deliberately does NOT kick a sync: the app follows up
    // with its own /sync passes, and a background run here would race the first
    // of those (two runSyncs on the same store = double Claude spend).
    if (url.pathname === "/gmail/rescan" && request.method === "POST") {
      const store = await loadStore(env);
      store.seenEmails = {};
      await saveStore(env, store);
      return cors(json({ ok: true }));
    }
    // Step-by-step trace of the newest forwarded (+trip) or matching email.
    // Answers "where exactly does my email die" in one call, without marking
    // anything as seen.
    if (url.pathname === "/gmail/trace" && request.method === "GET") {
      const token = await googleToken(env);
      if (!token) return cors(json({ ok: false, error: "Google not connected." }));
      const out = { ok: true };
      try {
        const em = (await env.TRIPS.get("g_email")) || "";
        const plus = em.includes("@") ? em.replace("@", "+trip@") : "";
        out.plusAddress = plus || null;
        let q = plus ? "to:" + plus : "";
        let list = { messages: [] };
        if (q) {
          const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
          list = await r.json().catch(() => ({}));
          out.plusMatches = list.resultSizeEstimate || 0;
        }
        if (!(list.messages || []).length) {
          out.fallbackQueryUsed = true;
          const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(await gmailQuery(env, token))}`, { headers: { Authorization: `Bearer ${token}` } });
          list = await r.json().catch(() => ({}));
        }
        const m = (list.messages || [])[0];
        if (!m) { out.step = "search"; out.result = "No matching email found at all - the search sees nothing."; return cors(json(out)); }
        out.messageId = m.id;
        const store = await loadStore(env);
        out.alreadySeen = !!((store.seenEmails || {})[m.id]);
        const gm = await gmailMessage(token, m.id);
        const text = gm.text;
        out.textLength = text.length;
        if (!text) { out.step = "extract"; out.result = "Found the email but could not read any text from it."; return cors(json(out)); }
        const segs = await extractSegments(env, text, gm.plus);
        if (segs === undefined) { out.step = "parse"; out.result = "Could not reach the Anthropic API (key missing or API down)."; return cors(json(out)); }
        const seg = segs.find((s) => s.start) || (gm.plus && segs[0]) || null;
        if (!seg) { out.step = "parse"; out.result = "The model judged this email is not a real booking."; return cors(json(out)); }
        out.parsed = { type: seg.type, name: seg.name, start: seg.start, end: seg.end, note: seg.note };
        if (segs.length > 1) out.parsedCount = segs.length;
        out.step = "done";
        if (!seg.start) {
          const byCity = await findTripByCity(store, seg.city || seg.name);
          out.result = byCity
            ? "No dates in this email - sync will file it into your \"" + (byCity.label || byCity.to) + "\" trip by destination."
            : "No dates in this email and no trip matches \"" + (seg.city || seg.name) + "\" - add that trip and re-scan.";
          return cors(json(out));
        }
        const trip = await findTripForSeg(store, seg, seg.city || "");
        out.result = (trip
          ? "Would file into trip: " + (trip.label || trip.to) + ". If it isn't there, hit Re-scan inbox (it may be marked seen from before a fix)."
          : (seg.type === "hotel" && seg.end && seg.end > seg.start
            ? "No trip covers these dates - the next sync will CREATE a \"" + (seg.city || seg.name) + "\" trip for this stay."
            : (seg.type === "flight" && segs.filter((s) => s.type === "flight" && s.start).length >= 2
              ? "No trip covers these dates - the next sync will CREATE a trip spanning these flights."
              : "Parsed fine but NO trip covers " + seg.start + " - create or widen a trip around that date.")))
          + (segs.length > 1 ? " (this email holds " + segs.length + " plans - all are imported on sync)" : "");
        return cors(json(out));
      } catch (e) { out.ok = false; out.error = String((e && e.message) || e); return cors(json(out)); }
    }
    // One-time broom: drop every auto-imported plan (calendar/gmail) from every
    // trip and forget scanned emails, then re-import fresh through the current
    // relevance filter. Manual plans are untouched - house rule.
    if (url.pathname === "/plans/reset" && request.method === "POST") {
      // destructive: keep an automatic copy first, restorable from Settings
      const cur = await env.TRIPS.get("store");
      if (cur) await env.TRIPS.put("backup:pre", JSON.stringify({ at: Date.now(), raw: cur }));
      const store = await loadStore(env);
      let removed = 0;
      for (const t of Object.values(store.trips)) {
        const before = (t.segments || []).length;
        t.segments = (t.segments || []).filter((s) => !s.source || s.source === "manual");
        removed += before - t.segments.length;
      }
      store.seenEmails = {};
      await saveStore(env, store);
      // No background sync kick here either - the app runs the re-import passes
      // itself right after this call and reports progress on screen.
      return cors(json({ ok: true, removed }));
    }
    // The easy calendar link: the "Secret address in iCal format" from normal
    // Google Calendar settings. No Google Cloud project, no OAuth, no consent
    // screen - the worker just reads that private feed on every sync.
    if (url.pathname === "/settings/gcalics" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const ics = ((body && body.url) || "").replace(/\s+/g, ""); // long URLs pick up line breaks when copied on mobile
      if (ics === "") { await env.TRIPS.delete("g_ics"); return cors(json({ ok: true })); }
      if (!/^https:\/\//.test(ics)) return cors(json({ error: "That doesn't look like a link - it should start with https://" }, 400));
      if (/\/public\/(basic|full)\.ics/.test(ics)) return cors(json({ error: "That's the PUBLIC address - copy the \"Secret address in iCal format\" instead (same page, a little further down)." }, 400));
      await env.TRIPS.put("g_ics", ics);
      return cors(json({ ok: true }));
    }
    // "Test link" in Settings: what does the worker actually see in the feed,
    // and does any of it land inside a trip? Answers "why didn't my hotel
    // show up" without dashboard access.
    if (url.pathname === "/gcal/test" && request.method === "GET") {
      const icsUrl = (await env.TRIPS.get("g_ics")) || "";
      if (!icsUrl) return cors(json({ ok: false, error: "No calendar linked yet." }));
      let res;
      try { res = await fetch(icsUrl); } catch (e) { return cors(json({ ok: false, error: "Could not reach that address." })); }
      if (!res.ok) return cors(json({ ok: false, error: "Google said " + res.status + " for " + maskIcs(icsUrl) + " - re-copy the Secret address (a reset invalidates old links)." }));
      const text = await res.text();
      const events = parseICS(text);
      const calName = ((text.match(/^X-WR-CALNAME[^:]*:(.*)$/m) || [])[1] || "").trim();
      const store = await loadStore(env);
      const trips = Object.values(store.trips).filter((t) => t.start && t.end);
      const inTrip = events.filter((ev) => ev.start && !/^Trip: /.test(ev.summary || "")
        && trips.some((t) => ev.start <= t.end && (ev.end || ev.start) >= t.start));
      return cors(json({
        ok: true, events: events.length, trips: trips.length, matching: inTrip.length, calName,
        sample: inTrip.slice(0, 5).map((ev) => (ev.summary || "Event") + " (" + ev.start + ")"),
      }));
    }

    // Your app reads the consolidated, segment-enriched trips from here.
    if (url.pathname === "/trips" && request.method === "GET") {
      const store = await loadStore(env);
      return cors(json(Object.values(store.trips).sort((a, b) => (a.start < b.start ? -1 : 1))));
    }
    // Your app creates OR updates a trip here. Manual plans you edit are merged with ingested ones.
    if (url.pathname === "/trips" && request.method === "POST") {
      const store = await loadStore(env);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return cors(json({ error: "invalid trip body" }, 400));
      const id = body.id || uid();
      const existing = store.trips[id];
      if (existing) {
        const ingested = (existing.segments || []).filter((s) => s.source && s.source !== "manual");
        const manual = (body.segments || []).filter((s) => !s.source || s.source === "manual");
        store.trips[id] = { ...existing, from: body.from, to: body.to, start: body.start, end: body.end,
          label: body.label, notes: body.notes || "", segments: dedupeSegs([...ingested, ...manual]),
          photo: body.photo !== undefined ? body.photo : (existing.photo || ""), updatedAt: Date.now() };
      } else {
        store.trips[id] = { id, from: body.from || "", to: body.to || "",
          start: body.start, end: body.end, label: body.label || "", notes: body.notes || "", segments: body.segments || [],
          photo: body.photo || "", updatedAt: Date.now() };
      }
      await saveStore(env, store);
      ctx.waitUntil(debouncedEditSync(env)); // enrich from calendar/email, coalescing rapid edits
      return cors(json(store.trips[id]));
    }
    // Delete a trip from the hub. Without this, a delete in the app only removed
    // the local copy and the worker's copy resurrected it on every refresh.
    if (url.pathname === "/trips/delete" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const store = await loadStore(env);
      const t = body && body.id ? store.trips[body.id] : null;
      if (t) {
        delete store.trips[body.id];
        await saveStore(env, store);
      }
      return cors(json({ ok: true, deleted: !!t }));
    }
    // Delete ONE plan and remember it. You deleted it on purpose (a hotel that
    // replied about an event, not your trip), so it must never come back: the
    // segment's conf is tombstoned in store.deletedSegs, and addSegment refuses
    // to re-add any conf listed there - blocking every source (calendar re-read,
    // Gmail re-scan, Clean re-import). Manual plans are removed too.
    if (url.pathname === "/segments/delete" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const store = await loadStore(env);
      const t = body && body.tripId ? store.trips[body.tripId] : null;
      let removed = 0;
      if (t) {
        store.deletedSegs = store.deletedSegs || {};
        const conf = body.conf || "";
        const sid = body.sid || "";
        const before = (t.segments || []).length;
        t.segments = (t.segments || []).filter((s) => {
          const hit = (conf && s.conf === conf) || (sid && s.sid === sid);
          if (hit && s.conf) store.deletedSegs[s.conf] = Date.now();  // tombstone by conf
          return !hit;
        });
        removed = before - t.segments.length;
        // Also tombstone the conf the app sent even if the stored copy differs,
        // so a re-ingest in flight can't slip it back in.
        if (conf) store.deletedSegs[conf] = Date.now();
        if (removed) t.updatedAt = Date.now();
        await saveStore(env, store);
      }
      return cors(json({ ok: true, removed }));
    }
    // Mint (or revoke) the companion-view token for one trip. The returned URL
    // is the whole credential - share it only with your travel companions.
    if (url.pathname === "/trips/share" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const store = await loadStore(env);
      const t = store.trips[body.id];
      if (!t) return cors(json({ error: "no such trip" }, 404));
      if (body.revoke) { delete t.shareToken; await saveStore(env, store); return cors(json({ ok: true, revoked: true })); }
      if (!t.shareToken) { t.shareToken = randHex(16); await saveStore(env, store); }
      return cors(json({ ok: true, url: url.origin + "/t/" + t.shareToken }));
    }
    // Mint (once) the private calendar-feed URL.
    if (url.pathname === "/ics/token" && request.method === "POST") {
      let tok = (await env.TRIPS.get("ics_token")) || "";
      if (!tok) { tok = randHex(16); await env.TRIPS.put("ics_token", tok); }
      return cors(json({ ok: true, url: url.origin + "/cal.ics?t=" + tok }));
    }
    // Safety net: weekly snapshots (taken Sundays before the daily sync) plus
    // the automatic pre-restore/pre-reset copy. List them / restore one.
    if (url.pathname === "/backups" && request.method === "GET") {
      const out = [];
      for (const slot of ["0", "1", "2", "3", "pre"]) {
        const raw = await env.TRIPS.get("backup:" + slot);
        if (!raw) continue;
        try { const b = JSON.parse(raw); const s = JSON.parse(b.raw);
          out.push({ slot, at: b.at, trips: Object.keys(s.trips || {}).length }); } catch (e) {}
      }
      out.sort((a, b) => b.at - a.at);
      return cors(json({ ok: true, backups: out }));
    }
    if (url.pathname === "/backups/restore" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const raw = await env.TRIPS.get("backup:" + String(body.slot));
      if (!raw) return cors(json({ error: "no such snapshot" }, 404));
      const b = JSON.parse(raw);
      // keep what is being replaced, so a restore is itself restorable
      const cur = await env.TRIPS.get("store");
      if (cur) await env.TRIPS.put("backup:pre", JSON.stringify({ at: Date.now(), raw: cur }));
      await env.TRIPS.put("store", b.raw);
      const s = JSON.parse(b.raw);
      return cors(json({ ok: true, trips: Object.keys(s.trips || {}).length }));
    }
    // Manual trigger (handy while testing). Cron calls runSync on its own.
    // Awaited so the response means the sync actually finished and the store is
    // fresh. ?only=gmail runs a cheap email-only pass and the response carries
    // gmail stats {parsed,failed,filed,unfiled,remaining} so the app can keep
    // draining a backlog until remaining hits zero - no guessing.
    if (url.pathname === "/sync" && request.method === "POST") {
      const stats = await runSync(env, url.searchParams.get("only") || "");
      return cors(json(Object.assign({ ok: true }, stats)));
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // 18:00 daily = the full sync (calendar + email + calendar write). The
    // hourly tick is the cheap email-only drain: it finishes what a closed
    // phone screen started and files fresh forwards within the hour. When
    // nothing new is waiting it costs ~4 subrequests and zero Claude tokens.
    const full = event.cron === "0 18 * * *";
    ctx.waitUntil((async () => {
      if (full) await maybeSnapshot(env);   // Sundays: keep a weekly copy BEFORE the day's sync touches anything
      await runSync(env, full ? "" : "gmail");
    })());
  },
};

// Every trip create/edit kicks a sync so the new trip is enriched from your
// calendar and inbox, but a burst of edits used to fire one full sync EACH. So
// per-edit syncs debounce: each save schedules the run 4s out and supersedes
// any earlier pending one, so mashing Save five times costs one sync cycle.
// (Isolate-local state - separate isolates can't coalesce, but one person
// editing hits one isolate.)
let editSyncGen = 0;
async function debouncedEditSync(env) {
  const gen = ++editSyncGen;
  await new Promise((r) => setTimeout(r, 4000));
  if (gen !== editSyncGen) return;   // a newer edit superseded this one
  try { await runSync(env); } catch (e) { console.error("edit sync", e); }
}

async function runSync(env, only) {
  const store = await loadStore(env);
  const stats = { gmail: null };
  const full = only !== "gmail";
  // Email runs BEFORE the calendar work. A Worker request has a hard cap on
  // outbound calls (~50 on the free plan) and a calendar-heavy sync used to
  // spend them all before a single email was parsed - forwarded bookings
  // silently never arrived. Bookings outrank calendar polish; and the app can
  // drain a big backlog with cheap /sync?only=gmail passes that skip the rest.
  // Email-only passes have the request almost to themselves, so they read 20
  // emails instead of 10 (2 calls each + overhead still fits the free cap).
  try { stats.gmail = await ingestFromGmail(store, env, full ? 10 : 20); } catch (e) { console.error("gmail", e); }
  if (full) {
    try { await ingestFromCalendar(store, env); } catch (e) { console.error("calendar", e); }
    try { await writeTripsToCalendar(store, env); } catch (e) { console.error("cal write", e); }
  }
  await saveStore(env, store);
  return stats;
}

/* ------------------------------- geocoder ------------------------------ */
function maskIcs(u) { u = (u || "").split("?")[0]; return u.length > 56 ? u.slice(0, 30) + "…" + u.slice(-18) : u; }
// Free geocoder (same one the app uses) to match a booking's city to the right
// trip even when the names differ (e.g. "Funchal" -> a "Madeira" trip).
async function geocodeName(name) {
  try {
    const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(name));
    if (r.ok) { const d = await r.json(); const g = (d.results || [])[0]; if (g) return { name: g.name, admin1: g.admin1, country: g.country }; }
  } catch (e) {}
  return null;
}

/* --------------------------- Calendar ingest --------------------------- */
// Reads Google Calendar events overlapping each trip and attaches them as segments.
// This is the cleanest source: the Booking.com / Airbnb items you already add to your calendar.

async function ingestFromCalendar(store, env) {
  const token = await googleToken(env);
  if (!token) return ingestFromICS(store, env);                // easy path: secret iCal address, no OAuth
  const calId = env.GOOGLE_CALENDAR_ID || "primary";
  for (const t of Object.values(store.trips)) {
    if (!t.start || !t.end) continue;
    const timeMin = new Date(t.start + "T00:00:00Z").toISOString();
    const timeMax = new Date(t.end + "T23:59:59Z").toISOString();
    const u = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
      + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const ev of data.items || []) {
      if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.travelSyncTrip) continue; // skip events we wrote
      const type = guessType(ev.summary || "");
      const hasGuests = (ev.attendees || []).length > 1;
      const timed = !!(ev.start && ev.start.dateTime);
      // travel-relevant only: bookings by type, anything with a place, or a real
      // timed invite with guests - never bare all-day agenda titles
      if (type === "other" && !ev.location && !(hasGuests && timed)) continue;
      const seg = {
        type,
        name: ev.summary || "Event",
        start: norm(ev.start && (ev.start.dateTime || ev.start.date)),
        end: norm(ev.end && (ev.end.dateTime || ev.end.date)),
        address: cleanLoc(ev.location),
        note: evNote(ev),
        conf: "gcal:" + ev.id,
        source: "calendar",
      };
      addSegment(t, seg, store);
    }
  }
}

// The no-OAuth path: the calendar's "Secret address in iCal format" pasted in
// Settings (Google Calendar -> your calendar -> Integrate calendar). Read-only,
// but Gmail auto-adds flights/hotels to the calendar, so most bookings arrive
// here anyway. Same segment mapping and dedupe keys as the API path above, so
// upgrading to full OAuth later never duplicates a segment.
async function ingestFromICS(store, env) {
  const icsUrl = (await env.TRIPS.get("g_ics")) || "";
  if (!icsUrl) return;
  const res = await fetch(icsUrl);
  if (!res.ok) return;
  const events = parseICS(await res.text());
  for (const t of Object.values(store.trips)) {
    if (!t.start || !t.end) continue;
    for (const ev of events) {
      if (!ev.start || ev.start > t.end || (ev.end || ev.start) < t.start) continue;
      if (/^Trip: /.test(ev.summary || "")) continue;          // our own write-back events
      const type = guessType(ev.summary || "");
      if (type === "other" && !ev.location && !(ev.att > 1 && ev.time)) continue; // agenda noise, not travel
      addSegment(t, {
        type,
        name: ev.summary || "Event",
        start: ev.start,
        end: ev.end || ev.start,
        note: [ev.time, cleanDesc(ev.desc).slice(0, 160)].filter(Boolean).join(" \u00b7 "),
        address: cleanLoc(ev.location),
        conf: "gcal:" + (ev.uid || "").replace(/@google\.com$/, ""),
        source: "calendar",
      }, store);
    }
  }
}
function parseICS(text) {
  const lines = text.replace(/\r/g, "").split("\n"), unfolded = [];
  for (const l of lines) {                                     // RFC 5545 line unfolding
    if ((l.startsWith(" ") || l.startsWith("\t")) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const out = []; let ev = null;
  const day = (v) => { const m = v.match(/(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };
  const unesc = (s) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  for (const l of unfolded) {
    if (l === "BEGIN:VEVENT") { ev = {}; continue; }
    if (l === "END:VEVENT") { if (ev) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const key = l.slice(0, i).split(";")[0], val = l.slice(i + 1);
    if (key === "UID") ev.uid = val;
    else if (key === "SUMMARY") ev.summary = unesc(val);
    else if (key === "LOCATION") ev.location = unesc(val);
    else if (key === "DESCRIPTION") ev.desc = unesc(val);
    else if (key === "ATTENDEE") ev.att = (ev.att || 0) + 1;
    else if (key === "DTSTART") { ev.start = day(val); const tm = val.match(/T(\d{2})(\d{2})/); if (tm) ev.time = tm[1] + ":" + tm[2]; }
    else if (key === "DTEND") ev.end = day(val);
  }
  return out;
}

// Normalise a city name for loose matching (lowercase, strip accents).
function normCity(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/* ----------------------------- Gmail ingest ---------------------------- */
// For confirmations that only land in email (drivers, transfers). Claude does the extraction.
// SWAP TO TRIPIT: if you would rather not maintain extraction, replace this whole function with a
// single GET https://api.tripit.com/v1/list/object/traveler/true/format/json (OAuth) and map the
// air/lodging/car objects into segments. Same downstream code.

// One year of lookback, multilingual keywords, and the common booking senders.
// Shared by the ingest and by /google/test's match count.
const GMAIL_TERMS = 'from:booking.com OR from:airbnb.com OR from:hotels.com OR from:expedia.com '
  + 'OR from:agoda.com OR from:trip.com OR from:uber.com OR from:bolt.eu '
  + 'OR subject:(confirmation OR itinerary OR reservation OR booking OR hotel OR "check-in" '
  + 'OR reserva OR confirmacao OR "confirma\u00e7\u00e3o" OR boeking OR bevestiging OR reservering OR pickup)';
// Forward-to-ingest: anything sent to you+trip@your-address is always picked
// up, whatever the sender or subject - forward a confirmation to yourself
// with "+trip" added before the @ and the next sync files it.
async function gmailQuery(env, token) {
  let plus = "";
  try {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const em = ((await r.json()).emailAddress || "");
      if (em.includes("@")) { plus = em.replace("@", "+trip@"); await env.TRIPS.put("g_email", em); }
    }
  } catch (e) {}
  if (!plus) {   // profile call hiccuped: fall back to the cached address so +trip forwards are NEVER dropped from the search
    const em = (await env.TRIPS.get("g_email")) || "";
    if (em.includes("@")) plus = em.replace("@", "+trip@");
  }
  return "newer_than:1y (" + GMAIL_TERMS + (plus ? " OR to:" + plus : "") + ")";
}

// Returns honest stats so the caller can SEE what happened instead of
// guessing: parsed / failed (parser unreachable, will retry) / filed into
// trips / unfiled (no trip covers the dates) / remaining (matching emails
// still unread - the app keeps running passes until this is 0).
async function ingestFromGmail(store, env, maxEmails) {
  const out = { parsed: 0, failed: 0, filed: 0, unfiled: 0, remaining: 0 };
  const token = await googleToken(env);
  if (!token) return out;                                      // Google not connected yet
  // Page through matches (newest first) so older bookings are reachable even
  // when newer emails also match - the old top-25 window could never get past
  // them. Cap per-page and total to stay inside Workers subrequest limits.
  const q = await gmailQuery(env, token);
  let ids = [], pageToken = "";
  for (let page = 0; page < 2 && ids.length < 200; page++) {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listRes.ok) return out;
    const list = await listRes.json();
    ids = ids.concat((list.messages || []).map((m) => m.id));
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  store.seenEmails = store.seenEmails || {};
  let budget = maxEmails || 10;   // new emails parsed per sync; the rest drain on later syncs (keeps total fetches inside Workers limits)
  for (const id of ids) {
    if (store.seenEmails[id]) continue;
    if (budget-- <= 0) break;
    const gm = await gmailMessage(token, id);
    if (!gm.text) { store.seenEmails[id] = 1; continue; }
    const segs = await extractSegments(env, gm.text, gm.plus);
    if (segs === undefined) { out.failed++; continue; }   // extractor unavailable (no key / API down): leave unseen so a later sync retries
    store.seenEmails[id] = 1;
    out.parsed++;
    // Hotels first, so a stay can create its trip and the flights/transfers in
    // the same email file straight into it instead of landing in "unfiled".
    segs.sort((a, b) => (b.type === "hotel" ? 1 : 0) - (a.type === "hotel" ? 1 : 0));
    const pending = [], dateless = [];
    let n = 0;
    for (const seg of segs) {
      seg.source = "gmail";
      if (!seg.conf) seg.conf = "mail:" + id + ":" + (n++);   // dedupe key even when no confirmation number exists
      const city = seg.city || ""; delete seg.city;   // trip-level info, not part of the segment shape
      if (!seg.start) { if (gm.plus) dateless.push({ seg, city }); continue; }
      const trip = await findTripForSeg(store, seg, city);
      if (trip) { addSegment(trip, seg, store); out.filed++; }
      else if (seg.type === "hotel" && seg.end && seg.end > seg.start) {
        // A hotel stay with no covering trip IS a trip. Parking it in
        // "unfiled" purgatory was why forwarded bookings kept "never
        // arriving" - now the stay creates the trip itself (destination =
        // the hotel's city, dates = the stay) and syncs onward like any
        // hand-made trip (calendar block).
        const tid = uid();
        store.trips[tid] = { id: tid, from: "", to: city || seg.name || "Trip",
          start: seg.start, end: seg.end, label: "", notes: "", segments: [], updatedAt: Date.now() };
        addSegment(store.trips[tid], seg, store);
        out.filed++; out.tripsCreated = (out.tripsCreated || 0) + 1;
      } else pending.push({ seg, city });
    }
    // A forwarded return ticket IS a trip too: two or more uncovered flights in
    // one email span the trip, outbound arrival city is the destination.
    const legs = pending.filter((p) => p.seg.type === "flight");
    if (legs.length >= 2) {
      legs.sort((a, b) => (a.seg.start < b.seg.start ? -1 : 1));
      const tid = uid();
      store.trips[tid] = { id: tid, from: "", to: legs[0].city || legs[0].seg.name || "Trip",
        start: legs[0].seg.start, end: legs.map((p) => p.seg.end || p.seg.start).sort().pop(),
        label: "", notes: "", segments: [], updatedAt: Date.now() };
      for (const p of legs) { addSegment(store.trips[tid], p.seg, store); out.filed++; }
      out.tripsCreated = (out.tripsCreated || 0) + 1;
    }
    for (const p of pending.filter((x) => !(legs.length >= 2 && x.seg.type === "flight"))) {
      // parsed fine but no trip covers the date - keep a visible trace so
      // "why isn't my hotel showing" is answerable from Test connection
      store.unfiled = (store.unfiled || []).slice(-19);
      store.unfiled.push({ name: p.seg.name || "Booking", start: p.seg.start, end: p.seg.end || "" });
      out.unfiled++;
    }
    // Deliberate forwards without dates (a hotel's chat message, a note): file
    // by destination so the info still lands inside the right trip.
    for (const p of dateless) {
      const trip = await findTripByCity(store, p.city || p.seg.name);
      if (trip) { p.seg.start = trip.start; addSegment(trip, p.seg, store); out.filed++; }
      else { store.unfiled = (store.unfiled || []).slice(-19); store.unfiled.push({ name: p.seg.name || "Forwarded note", start: "", end: "" }); out.unfiled++; }
    }
  }
  out.remaining = ids.filter((id) => !store.seenEmails[id]).length;
  return out;
}

// Anthropic key: dashboard secret wins, else the one pasted in-app (KV).
async function anthropicKey(env) {
  if (env._akey !== undefined) return env._akey;
  return (env._akey = env.ANTHROPIC_API_KEY || (await env.TRIPS.get("anthropic_key")) || "");
}
// Returns an ARRAY of segment objects (a return ticket = one per flight, so
// nothing in the email is lost; empty = "this email is not a booking"), or
// undefined ("could not ask" - no key / API down; caller retries later).
async function extractSegments(env, emailText, deliberate) {
  const akey = await anthropicKey(env);
  if (!akey) return undefined;
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",   // cheapest current model - plenty for short JSON extraction
      max_tokens: 700,
      messages: [{
        role: "user",
        content: "From this travel confirmation email, return ONLY a JSON array of objects "
          + '[{"type":"flight|hotel|car|ride|rail|other","name":"","city":"","start":"YYYY-MM-DD","end":"YYYY-MM-DD","address":"","conf":"","note":""}]. '
          + "One object per bookable item: a return ticket = one object per flight (outbound AND return), a hotel stay = ONE object for the whole stay. Max 5 objects. "
          + "city = the destination city of the booking (for a flight: the arrival city). "
          + 'note = the ONE line a traveller needs at a glance: flights -> flight number, route and times incl. layovers (e.g. "TP1479 OPO-LIS 07:10 \u00b7 LIS-GIG 09:55"); '
          + 'hotels -> check-in time and any door/PIN/keyless entry code; transfers -> pickup time, meeting point, driver name/phone; restaurants/meetings -> time and who/what. '
          + (deliberate
            ? "The traveller forwarded this email ON PURPOSE to file it into their travel app. Even if it is not a standard confirmation (a message from a hotel, an itinerary, a reminder), return one object with everything known: the venue/hotel name, city, any dates, and the useful details in note. Leave start/end empty rather than guessing. Return [] only if there is truly nothing travel-related. "
            : "If it is not a real booking, return []. ")
          + "No prose.\n\n" + emailText.slice(0, 6000),
      }],
    }),
    });
  } catch (e) { return undefined; }
  if (!res.ok) return undefined;
  const data = await res.json();
  const txt = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  let parsed;
  try { parsed = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch (_) { return []; }
  const list = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter((o) => o && typeof o === "object");
  const dup = {};
  for (const o of list) {
    o.start = norm(o.start); o.end = norm(o.end);
    // Both legs of one ticket share a confirmation code; suffix the copies so
    // addSegment's conf-dedupe cannot collapse the return flight into the outbound.
    if (o.conf) { if (dup[o.conf]) o.conf = o.conf + "#" + (++dup[o.conf]); else dup[o.conf] = 1; }
  }
  return list;
}

/* --------------------------- Calendar write ---------------------------- */
// One tidy "Trip: X" event per trip, so the trip shows up on your calendar as a single block.

async function writeTripsToCalendar(store, env) {
  const token = await googleToken(env);
  if (!token) return;                                          // Google not connected yet
  const calId = env.GOOGLE_CALENDAR_ID || "primary";
  for (const t of Object.values(store.trips)) {
    if (!isDate(t.start) || !isDate(t.end)) continue;   // never hand Google (or addDay) a garbage date
    const body = {
      summary: `Trip: ${t.label || (t.to || "Travel")}`,
      start: { date: t.start },
      end: { date: addDay(t.end) }, // all-day end is exclusive
      description: (t.segments || []).map((s) => `${s.type}: ${s.name}`).join("\n"),
      extendedProperties: { private: { travelSyncTrip: t.id } },
    };
    const method = t.calEventId ? "PATCH" : "POST";
    const u = t.calEventId
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${t.calEventId}`
      : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
    const res = await fetch(u, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) { const ev = await res.json(); t.calEventId = ev.id; }
  }
}

/* ----------------------------- Calendly (optional) --------------------- */
// If you meant Calendly rather than Google Calendar, finish this and call it inside runSync.
// async function ingestFromCalendly(store, env) {
//   const res = await fetch("https://api.calendly.com/scheduled_events?user=YOUR_USER_URI",
//     { headers: { Authorization: `Bearer ${env.CALENDLY_TOKEN}` } });
//   const data = await res.json();
//   for (const ev of data.collection || []) { /* map ev to a segment, addSegment(trip, seg) */ }
// }

/* ------------------------------- helpers ------------------------------- */
// OAuth client: dashboard secrets win, else the pair saved in-app (KV).
async function googleClient(env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
  try {
    const kv = JSON.parse((await env.TRIPS.get("g_client")) || "null");
    if (kv && kv.id && kv.secret) return kv;
  } catch (e) {}
  return null;
}
async function googleToken(env) {
  if (env._gtok !== undefined) return env._gtok;               // one refresh per invocation
  const c = await googleClient(env);
  const refresh = env.GOOGLE_REFRESH_TOKEN || (await env.TRIPS.get("g_refresh")) || "";
  if (!c || !refresh) return (env._gtok = null);               // not connected: ingest steps no-op
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.id, client_secret: c.secret,
      refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  const d = await res.json();
  return (env._gtok = d.access_token || null);
}

// Fetch one email: readable text PLUS whether it was deliberately sent to the
// traveller's +trip address - those get the lenient extraction (a forwarded
// "the hotel sent you a message" still yields the hotel name and details).
async function gmailMessage(token, id) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { text: "", plus: false };
  const msg = await res.json();
  const heads = ((msg.payload && msg.payload.headers) || [])
    .filter((h) => /^(to|cc|bcc|delivered-to|x-forwarded-to|x-original-to)$/i.test(h.name || ""))
    .map((h) => h.value || "").join(" ");
  const plus = /\+trip@/i.test(heads);
  const parts = [], htmlParts = [];
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body && p.body.data) parts.push(b64(p.body.data));
    else if (p.mimeType === "text/html" && p.body && p.body.data) htmlParts.push(b64(p.body.data));
    (p.parts || []).forEach(walk);
  })(msg.payload);
  if (parts.length) return { text: parts.join("\n"), plus };
  // Booking confirmations (and many forwards) are HTML-only - strip to text
  // instead of silently skipping them.
  if (htmlParts.length) return { text: htmlParts.join("\n")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(), plus };
  return { text: "", plus };
}

function dedupeSegs(segs) {
  const seen = {}, out = [];
  for (const s of segs) {
    const key = s.conf || (s.type + "|" + s.name + "|" + s.start);
    if (seen[key]) continue;
    seen[key] = 1; out.push(s);
  }
  return out.sort((a, b) => ((a.start || "") < (b.start || "") ? -1 : 1));
}
function addSegment(trip, seg, store) {
  // Deleted on purpose stays deleted: if this conf was tombstoned, never re-add
  // it, whatever source is trying (calendar, Gmail, re-import).
  if (seg.conf && store && store.deletedSegs && store.deletedSegs[seg.conf]) return;
  trip.segments = trip.segments || [];
  const ex = seg.conf ? trip.segments.find((s) => s.conf === seg.conf) : null;
  if (ex) {
    // same booking seen again: refresh the ingested copy with the richer
    // details (note, cleaned address) - manual plans are NEVER touched
    if (ex.source !== "manual") {
      if (seg.note) ex.note = seg.note;
      if (seg.address) ex.address = seg.address;
      if (seg.name) ex.name = seg.name;
    }
    return;
  }
  trip.segments.push(seg);
  trip.segments.sort(segCmp);
  trip.updatedAt = Date.now();
}
// Same-day plans order by their TIME, which lives in the note ("TP1328
// OPO-LGW 09:00-11:20", "18:00-21:30 · dinner"): first clock time found is
// the sort key, no time = midday. When neither side has a time, travel logic
// breaks the tie: flight, then transfers, then hotel, then the rest.
// Keep in lockstep with the app's copy.
function segSortKey(s) {
  const m = /([01]?\d|2[0-3]):([0-5]\d)/.exec(s.note || "");
  return (s.start || "") + "T" + (m ? ("0" + m[1]).slice(-2) + ":" + m[2] : "12:00");
}
const SEG_RANK = { flight: 0, rail: 1, car: 2, ride: 3, hotel: 4 };
function segCmp(a, b) {
  const ka = segSortKey(a), kb = segSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : (SEG_RANK[a.type] !== undefined ? SEG_RANK[a.type] : 5) - (SEG_RANK[b.type] !== undefined ? SEG_RANK[b.type] : 5);
}
function findTripForDate(store, dateISO) {
  return Object.values(store.trips).find((t) => t.start && t.end && dateISO >= t.start && dateISO <= t.end);
}
// "Funchal" must land in a trip called "Madeira": geocode the booking's city
// once (free geocoder, cached in the store) so island/region names match too.
async function cityGeo(store, city) {
  const key = normCity(city);
  if (!key) return null;
  store.geoCache = store.geoCache || {};
  if (store.geoCache[key] !== undefined) return store.geoCache[key];
  const g = await geocodeName(city);
  return (store.geoCache[key] = g ? { name: g.name || "", admin1: g.admin1 || "", country: g.country || "" } : null);
}
function cityMatchesTrip(t, city, geo) {
  const cityN = normCity(city);
  if (!cityN) return false;
  const dest = normCity(t.to) + " " + normCity(t.label);
  if (dest.includes(cityN)) return true;
  if (normCity(t.to).length > 2 && cityN.includes(normCity(t.to))) return true;
  return !!(geo && ((geo.admin1 && geo.admin1.length > 2 && dest.includes(normCity(geo.admin1)))
    || (geo.name && dest.includes(normCity(geo.name)))));
}
// Date decides, destination referees: of the trips covering the date, prefer
// the one matching the booking's city, so overlapping trips don't steal each
// other's hotels.
async function findTripForSeg(store, seg, city) {
  const covering = Object.values(store.trips).filter((t) => t.start && t.end && seg.start >= t.start && seg.start <= t.end);
  if (covering.length > 1 && city) {
    const geo = await cityGeo(store, city);
    const m = covering.find((t) => cityMatchesTrip(t, city, geo));
    if (m) return m;
  }
  return covering[0];
}
// For deliberately forwarded emails WITHOUT dates (e.g. "the hotel sent you a
// message"): file by destination - the next trip matching the city, else the
// most recent past one.
async function findTripByCity(store, city) {
  if (!normCity(city)) return null;
  const geo = await cityGeo(store, city);
  const matches = Object.values(store.trips)
    .filter((t) => t.start && cityMatchesTrip(t, city, geo))
    .sort((a, b) => ((a.start || "") < (b.start || "") ? -1 : 1));
  const today = new Date().toISOString().slice(0, 10);
  return matches.find((t) => (t.end || t.start) >= today) || matches.pop() || null;
}
function guessType(s) {
  s = s.toLowerCase();
  if (/flight|airlines?|\b[a-z]{2}\d{2,4}\b/.test(s)) return "flight";
  if (/hotel|airbnb|booking|stay|inn|resort/.test(s)) return "hotel";
  if (/car|rental|hertz|avis|sixt/.test(s)) return "car";
  if (/uber|bolt|ride|pickup|driver|transfer/.test(s)) return "ride";
  if (/train|rail|sncf|trenitalia/.test(s)) return "rail";
  return "other";
}
function norm(d) { return d ? String(d).slice(0, 10) : ""; }
// Strip map links / HTML from calendar fields; keep the human-readable part.
function cleanLoc(s) { return (s || "").replace(/https?:\/\/\S+/g, "").replace(/[\s,\u00b7|\u2013-]+$/g, "").trim(); }
function cleanDesc(s) {
  return (s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
// The one line a traveller needs on the card: time of day + the useful part
// of the description (door codes, flight numbers, who/what - not the essay).
function evNote(ev) {
  const bits = [];
  const st = ev.start && ev.start.dateTime, en = ev.end && ev.end.dateTime;
  if (st) bits.push(st.slice(11, 16) + (en ? "-" + en.slice(11, 16) : ""));
  const d = cleanDesc(ev.description);
  if (d) bits.push(d.length > 160 ? d.slice(0, 157) + "\u2026" : d);
  return bits.join(" \u00b7 ");
}
// A real YYYY-MM-DD, not just a non-empty string. The app validates dates,
// but POST /trips stores whatever it is handed, so anything reading dates back
// out (ICS feed, calendar write) must not assume they parse.
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(new Date(s + "T00:00:00Z").getTime()); }
function addDay(iso) { const dt = new Date(iso + "T00:00:00Z"); if (isNaN(dt.getTime())) return iso; dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); }
function sig(t) { return [t.from, t.to, t.start, t.end].join("|").toLowerCase(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function b64(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); }

function randHex(bytes) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Anonymous install count. Fires exactly ONCE per instance, the moment its
// password is first set (the one universal "this is now a real install"
// moment). The wire body is { id } and NOTHING else - no trip, no key, no
// email, no IP beyond what Cloudflare's own edge logs already keep for any
// request. `id` is 128 random bits generated by THIS instance and stored in
// its own KV; it cannot be reversed to anything about you or your trips, and
// exists only so a re-run of setup can't be double-counted. Full mechanics
// and the exact code that receives this ping: counter/counter-worker.js.
//
// Off by default: with TELEMETRY_URL blank (see wrangler.toml), this
// function returns immediately and no network call is ever made. Blank that
// line (or delete this whole block) to opt any instance out completely -
// nothing else in the app depends on it.
async function pingInstallCount(env) {
  try {
    const dest = env.TELEMETRY_URL || "";
    if (!dest) return;
    let id = await env.TRIPS.get("install_id");
    if (!id) { id = randHex(16); await env.TRIPS.put("install_id", id); }
    await fetch(dest.replace(/\/+$/, "") + "/ping", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
  } catch (e) { /* a counter hiccup must never affect setup */ }
}
// Weekly rotating snapshot (4 slots = ~a month of history). Runs Sundays only.
async function maybeSnapshot(env) {
  try {
    if (new Date().getUTCDay() !== 0) return;
    const raw = await env.TRIPS.get("store");
    if (!raw) return;
    const slot = Math.floor(Date.now() / (7 * 86400000)) % 4;
    await env.TRIPS.put("backup:" + slot, JSON.stringify({ at: Date.now(), raw }));
  } catch (e) { console.error("snapshot", e); }
}
function hesc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
// The companion page: everything a travel buddy needs, nothing they can break.
function shareTripHtml(t) {
  const segs = (t.segments || []).slice().sort(segCmp);
  const rows = segs.map((s) => {
    const when = (s.start || "") + (s.end && s.end !== s.start ? " – " + s.end : "");
    return '<div class="p"><div class="t">' + hesc(s.type || "plan") + '</div><div class="b"><b>' + hesc(s.name || "Booking") + "</b>"
      + (s.note ? "<br>" + hesc(s.note) : "") + (s.address ? '<br><span class="a">' + hesc(s.address) + "</span>" : "")
      + '</div><div class="w">' + hesc(when) + "</div></div>";
  }).join("");
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + "<title>" + hesc(t.label || t.to || "Trip") + "</title>"
    + "<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#f4efe4;color:#16130c;margin:0;padding:28px 18px;display:flex;justify-content:center}"
    + "main{max-width:560px;width:100%}h1{font-size:30px;margin:0 0 4px}.d{color:#756d5e;margin:0 0 22px;font-size:15px}"
    + ".p{display:flex;gap:12px;background:#fff;border:1px solid #e5decd;border-radius:14px;padding:14px 16px;margin-bottom:10px;align-items:flex-start}"
    + ".t{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1b8a57;background:rgba(27,138,87,.1);padding:3px 8px;border-radius:999px;flex:0 0 auto;margin-top:2px}"
    + ".b{flex:1;line-height:1.5;font-size:15px}.a{color:#756d5e}.w{flex:0 0 auto;font-size:13px;color:#756d5e;white-space:nowrap}"
    + "footer{margin-top:22px;color:#a9a190;font-size:12px}</style>"
    + "<main><h1>" + hesc(t.label || t.to || "Trip") + "</h1><p class='d'>" + hesc(t.to || "") + " · " + hesc(t.start || "") + " – " + hesc(t.end || "") + "</p>"
    + (rows || "<p class='d'>No plans on this trip yet.</p>")
    + "<footer>Shared read-only · plans update live as the trip owner adds them</footer></main>";
}
// Minimal, standards-happy ICS: one all-day event per trip, plans in the description.
function icsEscape(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function buildIcs(store) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ev = Object.values(store.trips).filter((t) => isDate(t.start) && isDate(t.end)).map((t) => {
    const desc = (t.segments || []).slice().sort(segCmp)
      .map((s) => (s.type || "plan") + ": " + (s.name || "") + (s.note ? " — " + s.note : "")).join("\n");
    return ["BEGIN:VEVENT",
      "UID:" + t.id + "@travel-hub",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + t.start.replace(/-/g, ""),
      "DTEND;VALUE=DATE:" + addDay(t.end).replace(/-/g, ""),   // all-day DTEND is exclusive
      "SUMMARY:" + icsEscape("Trip: " + (t.label || t.to || "Travel")),
      desc ? "DESCRIPTION:" + icsEscape(desc) : "",
      "END:VEVENT"].filter(Boolean).join("\r\n");
  }).join("\r\n");
  return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RoamRadar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:RoamRadar\r\n" + ev + "\r\nEND:VCALENDAR\r\n";
}

async function loadStore(env) {
  const raw = await env.TRIPS.get("store");
  return raw ? JSON.parse(raw) : { trips: {}, seenEmails: {}, deletedSegs: {} };
}
async function saveStore(env, store) { await env.TRIPS.put("store", JSON.stringify(store)); }

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Successful login: return the token AND set a durable HttpOnly session cookie
// (survives iOS localStorage eviction, so you stay signed in ~30 days).
function okLogin(hash) {
  const r = cors(json({ ok: true, token: hash }));
  r.headers.append("Set-Cookie", `tk=${hash}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return r;
}
// Returns a 401 Response if a password is set and the request has neither a valid
// X-Auth header nor a valid session cookie, else null.
// SCOPE: this gate is sized for a SELF-HOSTED, single-user worker - one person,
// their own Cloudflare account, their own keys. The password hash doubles as
// the session token, API keys live in plaintext KV, and CORS is open. That is
// fine for this template; do NOT turn this worker into a hosted multi-tenant
// service without replacing auth (salted/derived tokens), key storage
// (encryption), and CORS first.
async function authGuard(request, env) {
  const stored = await env.TRIPS.get("auth");
  // Fail CLOSED: until a password has been set, /trips, /sync and /settings are
  // locked (401), never open. The front end reads /auth/status (which is public)
  // and shows the "create your password" screen; /auth/login (also public) sets
  // it. Only after that does any trip data become reachable, and then only with
  // a matching X-Auth header or tk cookie. No password => no data, ever.
  if (!stored) return json({ error: "setup required - create your password first" }, 401);
  const header = request.headers.get("X-Auth") || "";
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tk=([^;]+)/);
  const cookie = m ? m[1] : "";
  return (header === stored || cookie === stored) ? null : json({ error: "unauthorized" }, 401);
}

function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } }); }
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
