# Shipping to itch.io

How to take a Hearth export and put it on itch.io — both the browser-playable
web build and native desktop builds. Hearth produces itch.io-ready zips for
both; getting them onto your itch.io project page is a few manual steps this
page walks through. Hearth doesn't call itch.io's API or wrap
[butler](https://itch.io/docs/butler/) — that's a deliberate non-goal (see
the [roadmap](./roadmap.md)) — but butler works fine against Hearth's output
if you want scripted pushes, covered [below](#scripted-uploads-with-butler).

## Web: the HTML5 upload

```bash
hearth export web --zip --allow build
```

This writes `export/web/` plus `export/<project-slug>-web.zip`, with
`index.html` at the zip root — exactly what itch.io's uploader expects. On
your itch.io project's edit page:

1. Upload the zip as a new file.
2. Check **"This file will be played in the browser"** next to it. Itch.io
   only shows this checkbox for `.zip` uploads, which is why Hearth's web
   export writes one.
3. Under **Embed options**, set the viewport width/height to match your
   project's `buildSettings.width`/`buildSettings.height` (`hearth inspect
   project --json` shows them) so the game isn't scaled or letterboxed
   inside a mismatched iframe. Fullscreen button and scroll bars are up to
   you; Hearth's export itself always letterbox-scales to whatever frame it
   ends up in, so a slightly different viewport size still looks correct,
   just not pixel-exact.
4. Save, then use itch.io's own preview to confirm it boots — the exported
   game has no Hearth chrome, so the first thing a player sees is your
   initial scene.

Single-file exports (`--single-file`) also work here since itch.io just
needs one zip with `index.html` at the root, but the plain folder build's
zip is usually smaller (assets aren't inlined as base64) and loads faster.

## Desktop: one channel per platform

```bash
hearth export desktop --allow build
```

This writes one zip per platform to `export/desktop/`: `<project-slug>-
darwin-arm64.zip`, `<project-slug>-darwin-x64.zip`,
`<project-slug>-win32-x64.zip`, `<project-slug>-linux-x64.zip` (narrow with
repeated `--platform` flags — see [export.md](./export.md#desktop-export-electron)
for the full flag reference, the signing ladder, and the honest
cross-platform verification limits before you ship a build you can't run
yourself).

Upload each platform's zip as a separate file on the edit page and check
the matching platform box (Windows / macOS / Linux) next to it — itch.io
uses those checkboxes to show visitors the right download button and to
group builds in the desktop app (itch's own launcher). Suggested per-file
naming/classification:

| Hearth platform id | itch.io platform checkbox |
| --- | --- |
| `darwin-arm64`, `darwin-x64` | macOS |
| `win32-x64` | Windows |
| `linux-x64` | Linux |

Both `darwin-arm64` and `darwin-x64` map to itch's single "macOS" checkbox
— upload both zips and check macOS on each; a player's browser/OS
detection on the store page picks whichever download itch thinks fits, so
uploading both architectures covers Apple Silicon and Intel Macs without
you needing to guess.

## Scripted uploads with butler

[butler](https://itch.io/docs/butler/) is itch.io's own CLI for pushing
builds to channels; Hearth's zips work with it unmodified, but running it
is on you — Hearth doesn't shell out to butler or manage your itch.io API
key. After `butler login` once:

```bash
# Web (butler diffs a folder, not a zip — push export/web/ directly)
butler push export/web <user>/<game>:html5

# Desktop: one channel per platform, pushing the zips exportDesktop wrote
butler push export/desktop/<slug>-darwin-arm64.zip <user>/<game>:mac-arm64
butler push export/desktop/<slug>-darwin-x64.zip   <user>/<game>:mac-x64
butler push export/desktop/<slug>-win32-x64.zip    <user>/<game>:windows
butler push export/desktop/<slug>-linux-x64.zip    <user>/<game>:linux
```

Channel names are yours to choose; the ones above are a common convention.
For the `html5` channel, set "This file will be played in the browser" and
the index file (`index.html`) once in the itch.io dashboard — butler only
handles the file transfer, not itch's playability/classification settings,
so that one-time setup still happens through the web UI even when every
later push is scripted.

## Signing before you ship

Desktop builds are unsigned by default (ad-hoc on macOS, nothing on
Windows/Linux) — itch.io accepts unsigned builds fine, but players will see
a Gatekeeper/SmartScreen warning on first launch. See
[export.md#signing-macos-only](./export.md#signing-macos-only) for the
`HEARTH_MAC_IDENTITY`/notarization env vars if you have an Apple developer
account and want to avoid that.
