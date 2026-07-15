# Hosting a Web Build on Your Own Site

A Hearth web export is a static, self-contained folder: no server code, no
build step on the player's machine, no external requests. That means you can
host it anywhere that serves plain files: your own domain, a static host, a
subfolder of an existing site, or a shared link. This page covers everything
except itch.io, which has its own upload flow (see
[shipping-to-itch.md](./shipping-to-itch.md)).

## What you're shipping

```bash
hearth export web --allow build          # folder build → export/web/
```

`export/web/` is four things and nothing else:

| File | What it is |
| --- | --- |
| `index.html` | Boot page, titled from `buildSettings.title` |
| `hearth-player.js` | The runtime + renderer as one script |
| `project.bundle.json` | Scenes, scripts, and settings |
| `assets/` | Your sprites, sounds, music, and fonts |

Upload that folder as-is. The game boots straight into your first scene with
no Hearth branding, letterbox-scaled to whatever space it's given. There is
nothing to configure on the host. Any static file server works.

> **One catch: don't double-click `index.html`.** Because the boot page
> `fetch`es `project.bundle.json`, browsers block it when opened from a
> `file://` path. For a build you can open by double-clicking (or email, or
> a USB stick), use the single-file export instead:
> `hearth export web --single-file --allow build` inlines the player and every
> asset into one `index.html` that runs from anywhere. It's a bigger file but
> needs zero requests. For a hosted site the folder build is smaller and
> loads faster. The `file://` limit only bites local double-clicks.

## Hosting options

### Any static host (Netlify, Cloudflare Pages, GitHub Pages, Vercel, S3…)

Point the host at `export/web/` as the publish directory (or drag-and-drop
the folder into their dashboard). No framework preset, no build command:
it's already built. A few host-specific notes:

- **GitHub Pages**: push `export/web/`'s contents to a `gh-pages` branch or a
  `/docs` folder on `main`. Because the game lives at a subpath
  (`username.github.io/repo/`), confirm it still boots. Hearth's export uses
  only relative paths (`./hearth-player.js`, `./project.bundle.json`,
  `./assets/…`), so a subpath is fine as long as you upload the whole folder
  together.
- **Netlify / Cloudflare Pages / Vercel**: set the publish/output directory
  to `export/web` and leave the build command empty. Drag-and-drop deploy
  works too.
- **S3 / any bucket + CDN**: upload the folder, enable static website
  hosting, set `index.html` as the index document. Serve `.json` and `.js`
  with sensible content types (most hosts infer them from the extension).

### A subfolder of an existing site

Drop the whole `export/web/` folder somewhere under your web root, say
`yourdomain.com/games/star-catcher/`, and link to it. Everything the export
references is relative, so it doesn't care what path it lives at. Keep the
four items together; don't split `assets/` off from `index.html`.

### Embedding in a page you control (`<iframe>`)

To put the game inside one of your own pages rather than linking out to it,
host the folder and point an iframe at its `index.html`:

```html
<iframe
  src="/games/star-catcher/index.html"
  width="960" height="540"
  style="border:0"
  allow="fullscreen; gamepad; autoplay"
></iframe>
```

Match `width`/`height` to your project's `buildSettings.width`/`height`
(`hearth inspect project --json` prints them) so the game isn't scaled inside
a mismatched frame. The `allow` attribute matters: `gamepad` lets controller
input reach the game across the frame boundary, and `autoplay` lets music
start on the first player interaction. (Hearth's player resumes audio
silently on the first pointer/key/touch. Browsers block sound until then, so
there's always at least one gesture before audio.)

## Custom domain & HTTPS

Serve over HTTPS. Beyond audio, Gamepad API access and some input paths are
gated to secure contexts in modern browsers, so a plain `http://` host can
quietly disable controller support. Every static host above gives you HTTPS
by default; if you're on your own box, terminate TLS (Caddy, a reverse proxy,
or your CDN) rather than serving `http://`.

## Loading screen

While the bundle and assets download, players see only what you set in
`buildSettings.loading`: a background color, an optional centered image, and
an optional minimal spinner. Set them with `updateSettings` (or the editor's
**Game Settings → Loading** section); no hand-editing of `hearth.json`. See
[export.md](./export.md#loading-visuals-buildsettingsloading) for the fields.

## Quick checklist before you link it out

1. `hearth validate --json` is clean (export already refuses on validation
   errors, but check first).
2. You uploaded the **whole** `export/web/` folder, together.
3. The page is served over **HTTPS**.
4. You opened the hosted URL yourself and it booted into your first scene:
   itch.io-style preview isn't available on a bare host, so this manual boot
   is your smoke test.
5. If you embedded it, the iframe `allow` list includes `gamepad` and
   `fullscreen`, and the dimensions match `buildSettings`.

For the browser-playable itch.io upload (the `.zip` with the "played in the
browser" checkbox), see [shipping-to-itch.md](./shipping-to-itch.md). For a
downloadable native app instead of a web build, see
[ship-desktop.md](./ship-desktop.md).
