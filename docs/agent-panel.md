# Agent Panel

The Agent panel is the editor's built-in home for a coding agent: a real
embedded terminal running your own copy of the agent's CLI, pre-wired to the
open project via MCP, next to a live timeline of every structured command it
runs. The onboarding story it exists for is: download Hearth → open a
project → click **Start Claude Code** → describe your game.

It is not a chat UI, and it does not run any model. Hearth never calls an
LLM, never holds an API key, and the panel's terminal is exactly the
official `claude` CLI you'd run in any terminal — just spawned inside the
editor with its working directory set to your project. Everything the panel
shows is either that CLI's own terminal output, or facts read back from
Hearth's own on-disk command journal.

## Why a terminal, not a custom chat UI

Anthropic's June 2026 billing change draws a clear line: the official
`claude` CLI running in a terminal — **including a terminal embedded in an
editor** (Zed's embedded terminal is the named precedent) — draws from the
user's existing Claude Pro/Max subscription like any other terminal session
would. What does not: ACP-style integrations, third-party UIs that wrap
Claude Code's protocol, and piping `claude -p` through a custom
non-terminal front end.

Hearth's embedded panel stays on the safe side of that line deliberately:

- It spawns a genuine, unmodified `claude` binary in a real PTY
  (`@lydell/node-pty`) — the same binary `which claude` finds on your
  machine, not a fork or a wrapped subprocess with a scripted stdin/stdout.
- Hearth never touches the CLI's stream, its credentials, or its flags,
  beyond setting the working directory (`cwd`) to your project root and
  writing standard MCP server configuration (`.mcp.json`) — the same kind of
  file you'd hand-write to wire up any MCP server yourself.
- There is no token or cost readout anywhere in the panel. Hearth does not
  parse the CLI's stream to extract that information, on purpose — doing so
  would mean depending on the internal shape of output that isn't a
  supported integration surface.
- The **activity timeline** next to the terminal is fed exclusively by
  Hearth's own command journal (`.hearth/log/commands.jsonl`, see
  [project-format.md](./project-format.md#hearthlogcommandsjsonl)) — a
  record of engine commands the CLI happened to run through Hearth's MCP
  server, not anything read out of the agent's own process.
- Login is entirely the CLI's own business: clicking **Start Claude Code**
  never touches your credentials. If the CLI needs you to authenticate, it
  prompts for it inside the terminal exactly as it would from any shell,
  and whatever it persists to your machine is between you and the CLI.

A custom chat UI over the agent — one that isn't just a terminal — is
explicitly out of scope until it can be built against an API-key path (the
Claude Agent SDK) instead of a subscription session, or until Anthropic
clarifies that subscription use through a wrapped UI is fine. Until then,
this doc and the panel itself describe things as "works with Claude Code"
descriptively — no logos, no implied partnership or endorsement.

## What's in the panel

- **Permission mode selector** — a 4-tier ladder (`Read-only` / `Safe edit`
  / `Full (no build)` / `All (incl. build)`) above the terminal, defaulting
  to Safe edit. See [Permission modes](#permission-modes) below.
- **Start Claude Code** — writes/merges a `hearth` entry into the project's
  `.mcp.json` at the selected mode, then spawns `claude` in the terminal
  pane. Claude Code discovers `.mcp.json` itself, asks you to approve the
  server on first use, and handles its own login if needed — all inside the
  terminal.
- **Install Claude Code** — shown instead of Start when `claude` isn't found
  on `PATH`. Runs the official install command visibly in the terminal (no
  hidden installs happen anywhere), then re-detects.
- **Open Terminal** — always available: a plain shell (`$SHELL` on
  macOS/Linux, PowerShell on Windows) in the project root, for Codex or any
  other agent/tool. This is also where the install command above actually
  runs.
- **Stop** — kills the current terminal session.
- **Activity timeline** — the right-hand rail: one row per journaled
  command (icon by kind, summary, ok/✗, relative time), newest first.
  Playtest rows show pass/fail and assertion counts; validate rows show
  error/warning counts.
- **Snapshot / Review changes / Revert session** — the timeline's header
  actions: `snapshotProject`, focusing the Diff panel (`Review changes`),
  and `revertProject` with a confirm dialog (`Revert session`, disabled
  when there's nothing to revert). A link to the History panel covers
  granular per-command undo instead of a whole-session revert.
- **Manual setup** — a collapsible section with the CLI/MCP copy-paste
  snippets and the permission-mode table, for anyone not using the embedded
  terminal at all (see [Manual setup](#manual-setup-non-claude-agents)).

One PTY session per open project at a time in this release; switching
projects always kills the old terminal (see
[Troubleshooting](#troubleshooting)).

## Permission modes

The panel's 4-tier picker maps onto the CLI/MCP server's real permission
modes (see [cli.md](./cli.md#global-options) and
[mcp.md](./mcp.md#choosing-modes-per-session)); `full` and `all` are
composed from the tiers they actually grant, not separate claims:

| Panel label | Grants |
| --- | --- |
| Read-only | Inspect project, scenes, entities; validate; diff; run non-mutating playtests. |
| Safe edit | Create/modify/delete scenes and entities; add/remove components; set component properties; snapshot. |
| Full (no build) | Safe edit, plus create/edit/attach scripts, and import/create/modify assets. Explicitly **not** build/export. |
| All (incl. build) | Everything above, plus build/export the project. |

Selecting a mode and clicking **Start Claude Code** rewrites `.mcp.json`
with that mode and restarts the CLI so the change takes effect immediately.
Denied tool calls return a structured `PERMISSION_DENIED` error the agent
can relay to you, rather than failing silently — same behavior as the CLI
and MCP server outside the panel.

## Manual setup (non-Claude agents)

Codex gets detection ("is it on `PATH`") in the panel, but not automatic
`.mcp.json` wiring in this release — its configuration story is TOML-based
and first-class wiring is future work. Use **Open Terminal** and wire it
yourself, or use the Manual setup section's snippets, which cover:

- The plain CLI loop (`hearth snapshot` → `hearth inspect` → edit → `hearth
  validate` → `hearth diff`) for any agent that just gets a shell.
- `claude mcp add hearth -- node <mcp path> --project <project path>` for
  Claude Code from outside the panel.
- A raw `.mcp.json` block for any other MCP-capable client.
- The same permission-mode table as above.

This is exactly the content that used to be the whole Agent panel before
the embedded terminal shipped; it hasn't gone away, just moved to a
collapsible section underneath the live terminal.

## The external-change model

The editor now live-follows changes made *outside* itself — from the
embedded terminal, a separate CLI invocation, or another MCP session —
using the same journal that feeds the timeline:

- The project server watches `.hearth/log/commands.jsonl` for the open
  project (`fs.watch` plus a polling fallback) and pushes new entries to
  every connected editor over one WebSocket endpoint.
- When a pushed batch contains an entry whose `source` isn't `editor`, the
  server drops its in-memory session for that project so the next command
  re-reads from disk, and the editor bumps its own refresh signal — every
  panel that already reacts to that signal (Hierarchy, Inspector, Diff,
  History, Assets) picks up the change automatically. You don't need to
  reopen the project or hit refresh.
- Entries the editor's own UI produced still show up in the timeline, but
  don't trigger this reload (there's nothing external to catch up on).

**Conflict model:** this is last-writer-wins per file, same as before —
the editor only ever *re-reads* on an external change, it never auto-writes
over one. If you and an agent edit genuinely overlapping state in the same
narrow window, whichever write lands last on disk wins, and the editor will
faithfully show you that state once it reloads. There's no merge and no
lock; `snapshot`/`diff`/`revert` (or per-command undo/redo, see
[cli.md](./cli.md#command-tour)) are your safety net if that ever surprises
you, not this refresh mechanism.

## Troubleshooting

**"Install Claude Code" instead of "Start Claude Code."** The panel didn't
find `claude` on `PATH`. Click **Install Claude Code** (runs the official
install command in the terminal so you can see exactly what it does), then
**Re-detect** once it finishes. If you installed it in a way that doesn't
land on the `PATH` the editor's process sees (e.g. a shell-specific rc file
change, or a version manager) `Re-detect` still won't see it until you
restart the editor from a shell that has the updated `PATH`.

**"Agent setup failed: ... exists but is not valid JSON" (409).** The
project's `.mcp.json` already exists but doesn't parse as JSON. Hearth
refuses to overwrite a file it can't safely merge into rather than
clobbering whatever's there — fix or delete the file and click **Start
Claude Code** again. (This surfaces as HTTP 409 from the panel's
`/api/agent/prepare` call if you're driving it directly.)

**Terminal shows "Exited" after switching projects.** Expected: this
release supports one PTY per open project, and switching projects tears
down the old project's WebSocket connection, which kills its terminal
session with it. Click **Start Claude Code** or **Open Terminal** again in
the new project — the old session isn't recoverable, but nothing about it
was silently lost either (its work is exactly what's on disk plus whatever
the timeline/journal recorded).

**Nothing happens when I click Start Claude Code.** Check for an inline
"Agent setup failed: …" message under the toolbar — the panel deliberately
refuses to launch `claude` if writing `.mcp.json` failed, since a stale
`.mcp.json` from an earlier session could otherwise grant a more permissive
mode than the one you just picked without telling you.

**The terminal looks frozen / stopped updating.** Check the WebSocket
status implicitly via whether other live panels (Hierarchy, Console) are
still updating from external changes; a dropped connection reconnects
automatically with backoff. If the whole editor lost its connection to the
project server (e.g. the dev server or app process restarted), reload the
editor.
