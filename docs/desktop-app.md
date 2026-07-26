# The desktop app

Hearth is an Electron app. One window: conversations on the left, the
conversation and the game pane in the middle and on the right.

## Install

Download from [hearthengine.com/download](https://hearthengine.com/download) or
from the [latest release](https://github.com/echoo19/hearth/releases/latest).

| Platform | Artifacts | Notes |
| --- | --- | --- |
| macOS | `.dmg`, `.zip` — Apple Silicon and Intel | Developer ID signed and notarized; opens normally. |
| Windows | `.exe` installer, `.zip` | Not code-signed yet. SmartScreen shows a warning on first launch: **More info → Run anyway**. |
| Linux | `.AppImage`, `.deb` | Nothing special needed. |

The Windows warning is Microsoft's reputation check on an unsigned installer,
not a detection of anything. It affects the first manual install only — updates
applied by the app itself never show it.

## Updates

The packaged app checks GitHub Releases a few seconds after launch, and again
whenever you use **Help → Check for updates…**. On macOS, Windows and Linux the
update downloads quietly in the background.

When it's ready, a card appears at the bottom of the sidebar: **Relaunch to
update**, with the new version under it. Press it when you're at a good
stopping point; nothing restarts on its own, and no modal interrupts you. An
explicit check also tells you when you're already up to date, or when the check
failed.

Two caveats. macOS self-updates validate the downloaded app's signature against
the running one, so anyone still on an old ad-hoc-signed build needs one manual
download to get onto the signed line. And `.zip` archives are plain downloads —
only the installer formats self-update.

Updates are disabled in development runs and by `HEARTH_DISABLE_UPDATES=1`.

## Running from source

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install && npm run build:packages

npm run dev        # browser mode: http://localhost:5173
npm run app        # the desktop app, from your checkout
npm run app:dist   # package it with electron-builder
```

Node 20 or newer. Browser mode runs the same UI against the same server — the
window is the only difference — which makes it the fastest way to work on
Hearth itself. See [architecture.md](./architecture.md).

## Where things go

Nearly everything Hearth deliberately keeps lives in the project folder's
`.hearth/` directory: conversations, the files you attached to them, settings,
evidence ([projects-and-chats.md](./projects-and-chats.md)).

What is outside it is what belongs to you rather than to one game, all under
`~/.hearth/`:

- `recent-projects.json` — the recents list, twelve entries of path and name.
- `skills/<slug>/` — your skills, one folder each
  ([agents.md](./agents.md)).
- `skills.json` — which of them are switched off.

Electron itself keeps a small amount of app state in the platform default —
`~/Library/Application Support/Hearth` on macOS, `%APPDATA%\Hearth` on Windows,
`~/.config/Hearth` on Linux — along with the updater's download cache. Deleting
those loses nothing but window state and a pending download.

The server the window talks to is bound to `127.0.0.1` on an OS-assigned port
and refuses any request that doesn't come from loopback. Nothing listens
publicly, and no project data leaves the machine except what you send to your
agent's provider.
