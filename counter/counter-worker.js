// Install counter (Cloudflare Worker) - deployed ONCE, by the template's
// maintainer, to their own Cloudflare account. It answers exactly one
// question - "how many people deployed this template?" - and nothing else.
//
// It never sees a trip, an email, a name, or an IP beyond what Cloudflare's
// own edge logs already retain for any request. Each self-hosted travelapp
// instance sends ONE fire-and-forget ping on first-time setup carrying
// nothing but a random id it generated for itself; this worker deduplicates
// by that id and keeps a running total. That id cannot be traced back to a
// person - it is not a trip id, not an email hash, nothing but a coin flip
// done 128 times. This worker stores no other field, ever.
//
// Storage: one KV namespace bound as COUNTER.
//   POST /ping    { id: "<32 hex chars>" }   -> counts once per id, ignored after that
//   GET  /count?key=<READ_KEY>               -> a plain page with the number when opened
//                                                in a browser, or { count } for anything
//                                                else (curl, fetch) via Accept: application/json
//
// Secrets (wrangler secret put NAME):
//   READ_KEY   required to read /count - anything not matching is a 404, not a 401,
//              so the endpoint's existence isn't advertised to a guesser.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === "/ping" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String((body && body.id) || "");
      if (!/^[a-f0-9]{32}$/.test(id)) return json({ ok: false }, 400);
      const seenKey = "seen:" + id;
      if (await env.COUNTER.get(seenKey)) return json({ ok: true, new: false }); // already counted
      await env.COUNTER.put(seenKey, "1");
      const total = parseInt((await env.COUNTER.get("total")) || "0", 10) + 1;
      await env.COUNTER.put("total", String(total));
      return json({ ok: true, new: true });
    }

    if (url.pathname === "/count" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!env.READ_KEY || key !== env.READ_KEY) return new Response("Not found", { status: 404 });
      const total = parseInt((await env.COUNTER.get("total")) || "0", 10);
      // A browser sends Accept: text/html first -> a page you can just look
      // at. Anything asking for JSON explicitly (curl, fetch, a script)
      // still gets { count } - nothing here is meant to be scraped or embedded.
      const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
      if (wantsHtml) return html(total);
      return json({ ok: true, count: total });
    }

    return new Response("Not found", { status: 404 });
  },
};

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, cors()) });
}
function html(count) {
  const page = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>Installs</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;'
    + 'font-family:-apple-system,Segoe UI,sans-serif;background:#16130c;color:#f4efe4}'
    + '.n{font-size:min(22vw,180px);font-weight:800;letter-spacing:-.03em;line-height:1}'
    + '.l{font-family:ui-monospace,monospace;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#8f8878;margin-top:12px}</style>'
    + '<div class="n">' + count + '</div><div class="l">' + (count === 1 ? "install" : "installs") + '</div>';
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
