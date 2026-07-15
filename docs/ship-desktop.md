# Distributing a Downloadable Desktop Game

`hearth export desktop` packages your game as a native app (one zipped app
per platform) that a player downloads and double-clicks. This page is about
getting those builds to players and being honest with them about what an
*unsigned* build looks like on first launch. For the export command itself
(flags, platforms, the signing ladder, icons), see
[export.md](./export.md#desktop-export-electron). For putting these builds on
itch.io specifically, see [shipping-to-itch.md](./shipping-to-itch.md).

> This page is about signing and shipping **games you make with Hearth**. It
> is a different thing from signing the **Hearth editor app itself**: that's
> [desktop-app.md](./desktop-app.md). The environment variables and workflows
> are separate.

## What you're shipping

```bash
hearth export desktop --allow build       # all four platforms → export/desktop/
```

You get one zip per platform, named `<project-slug>-<platform>.zip`:

| Zip | For |
| --- | --- |
| `<slug>-darwin-arm64.zip` | macOS, Apple Silicon |
| `<slug>-darwin-x64.zip` | macOS, Intel |
| `<slug>-win32-x64.zip` | Windows 64-bit |
| `<slug>-linux-x64.zip` | Linux 64-bit |

Each zip contains the packaged app with its executable bit preserved, so the
binary inside runs straight after the player unzips it: no `chmod` needed on
macOS or Linux. (The editor's Export dialog shows each zip's path with a copy
button and next-step hints once the export finishes.) Narrow the set with
repeated `--platform` flags if you only want to ship some, but read the
[honest verification limits](./export.md#honest-verification-limits) first: a
build packaged from a Mac for Windows or Linux is packaging-verified, not
execution-verified. Smoke-test on real hardware for any platform you can't
launch yourself before you publish it.

## The unsigned-build reality

**Preview Hearth builds are unsigned by default** (ad-hoc on macOS, nothing
on Windows or Linux). Unsigned builds run fine, but the OS shows a scary
warning on first launch, because from its point of view an unknown developer
is shipping an app it can't verify. This is not a Hearth bug and not
something wrong with your game; it's what every unsigned app triggers. You
have two honest choices: **tell your players how to get past the warning**
(below), or **sign your builds** so the warning never appears
([signing, below](#signing-to-remove-the-warnings)).

Whichever you pick, be upfront on your download page. A one-line "this build
isn't code-signed yet, here's how to open it" note next to the download
buys more trust than a player hitting an unexpected "damaged app" dialog.

### macOS: what your players will see

macOS quarantines anything downloaded from the internet, so the exact
first-launch experience depends on the player's macOS version:

- **macOS 15 Sequoia and later.** Double-clicking shows *"Apple could not
  verify 'YourGame' is free of malware"* with only **Move to Trash / Done**.
  The old right-click → Open trick no longer works here. Tell players to:
  click **Done**, open **System Settings → Privacy & Security**, scroll to
  the **"'YourGame' was blocked from use"** row, click **Open Anyway**, and
  confirm once. After that it opens normally every time.
- **macOS 14 Sonoma and earlier.** **Right-click (or Control-click) the app →
  Open → Open** in the dialog. One time; it's trusted afterward.
- **"'YourGame' is damaged and can't be opened."** This appears when the
  quarantine flag is set and Gatekeeper won't offer an override. The fix is
  to strip the quarantine attribute:
  ```bash
  xattr -cr /path/to/YourGame.app
  ```
  then open it normally. Worth putting verbatim on your download page for Mac
  players, since the wording ("damaged") sounds alarming but is routine for
  unsigned downloads.

### Windows: what your players will see

An unsigned `.exe` trips **SmartScreen**: a blue *"Windows protected your
PC"* dialog that only shows a **Don't run** button at first. Tell players to
click **More info**, then the **Run anyway** button that appears. SmartScreen
reputation also builds with download volume, so the warning softens over time
for a build that many people fetch, but a fresh unsigned build always starts
with it.

### Linux: what your players will see

No Gatekeeper equivalent. The zip preserves the executable bit, so after
unzip the player runs the app directly. Some desktop environments ask for a
confirmation the first time an executable from a download is launched; that's
the whole friction.

## Signing to remove the warnings

Signing is the only way to make the warnings actually go away: no amount of
instructions removes them, it just teaches players to click through. If you
have (or are willing to get) developer credentials, `hearth export desktop`
reads signing config from environment variables at export time:

- **macOS.** With an Apple Developer account ($99/yr), set
  `HEARTH_MAC_IDENTITY` to your *Developer ID Application* identity for a
  signed build, and add `HEARTH_APPLE_ID` + `HEARTH_APPLE_PASSWORD` +
  `HEARTH_TEAM_ID` to also **notarize** it. A notarized build opens with
  **zero** warnings: no Open Anyway, no `xattr`. See
  [export.md#signing-macos-only](./export.md#signing-macos-only) for the full
  table and what each variable does.
- **Windows.** Authenticode signing (an OV/EV certificate, or Azure Trusted
  Signing) removes the SmartScreen prompt as reputation builds. Hearth's
  `export desktop` doesn't wire up Windows signing yet; it's on the
  [roadmap](./roadmap.md), so today a Windows game ships unsigned and you
  rely on the "More info → Run anyway" instructions above.
- **Linux.** Nothing to sign.

If you have no signing setup, that's a legitimate way to ship a preview or a
jam game: just lead with the honesty note and the per-platform instructions
above.

## Where to host the downloads

The zips are ordinary files; host them like any download:

- **itch.io** classifies each platform zip with a checkbox and shows players
  the right download button, the smoothest path for a game. See
  [shipping-to-itch.md](./shipping-to-itch.md#desktop-one-channel-per-platform).
- **GitHub Releases** attach the four zips to a tagged release; players pick
  their platform. Good for open-source or repo-hosted games.
- **Your own site.** Link each platform's zip and put the unsigned-build note
  and per-OS "how to open" instructions right next to the links (see
  [ship-web-hosting.md](./ship-web-hosting.md) for hosting a page).

## Checklist before you publish

1. You exported the platforms you actually intend to support (`--platform` or
   the default four).
2. You **smoke-tested** each platform you can run yourself, and did at least
   one manual launch on real hardware/VM for any you can't (see
   [honest verification limits](./export.md#honest-verification-limits)).
3. Your download page states the builds are unsigned (if they are) and gives
   the per-OS "how to open" steps, or you signed/notarized and can drop that
   note.
4. Filenames make the platform obvious to a player choosing a download.
