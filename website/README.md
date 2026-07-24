# RoamRadar - marketing website

A single self-contained `index.html` landing page for the app. No build step,
no framework, no runtime - just open it or drop it on any static host.

Hand-built static page: plain HTML with real CSS `:hover` rules and the two
decorative flags (iOS note, stickers) baked in. Copy, colors, spacing and
layout match the app's design.

## Deploy
It's one static file. Easiest options:
- **GitHub Pages**: repo Settings -> Pages -> serve this `website/` folder (or
  add a Pages workflow). It's live at `https://<user>.github.io/travel-roamradar/`.
  (This does not affect the app - the Cloudflare Worker deploys separately.)
- **Cloudflare Pages**: new project -> point at this repo, build command none,
  output directory `website`.
- **Netlify / Vercel**, or host `website/index.html` at your own domain (e.g.
  giovannibrees.com) with the app keeping its `travel.` subdomain.

The **Download** buttons and the giant CTA already point at the live app
(`https://travel.giovannibrees.com`). The footer credits link to
`giovannibrees.com`.

## Before going wide: swap the photos
The past-trip and travel-log thumbnails are **hotlinked** from Unsplash and
one Wikimedia Commons image (Funchal, CC BY-SA - needs attribution if kept).
Fine for a preview; for a public launch, replace them with images you own or
have licensed. They're the only external images in the file (search `img src`).

Fonts load from Google Fonts (Bricolage Grotesque, Archivo, JetBrains Mono).
