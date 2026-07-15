# Agent Panel

The Agent panel is the editor's built-in home for a coding agent: a real
embedded terminal running your own copy of the agent's CLI, next to a live
timeline of every structured command it runs. The onboarding story it exists
for is: download Hearth → open a project → choose your agent → describe your
game. Claude Code, Codex, OpenCode, and Hermes all get automatic MCP setup —
the panel detects each on `PATH`, writes the `hearth` server into that tool's
own config format, and launches it directly; any other shell-native agent
uses the project terminal plus the same Hearth CLI/MCP surfaces.

It is not a chat UI, and it does not run any model. Hearth never calls an
LLM, never holds an API key, and the panel's terminal is exactly the
official CLI you'd run in any terminal — just spawned inside the editor with
its working directory set to your project, with the `hearth` CLI already
guaranteed on that terminal's `PATH` (a small shim Hearth writes into a temp
dir and prepends, so a bare shell or any agent CLI finds a working `hearth`
with zero manual alias/install step). Everything the panel shows is either
that CLI's own terminal output, or facts read back from Hearth's own on-disk
command journal.

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
  (The same holds for Codex, OpenCode, and Hermes when you pick those
  launchers — real PTY, real binary, no wrapping.)
- Hearth never touches the CLI's stream, its credentials, or its flags,
  beyond setting the working directory (`cwd`) to your project root and
  writing standard MCP server configuration in that tool's own format
  (`.mcp.json` for Claude Code; `opencode.json` for OpenCode; Codex's and
  Hermes's own global config for those two) — the same kind of file you'd
  hand-write to wire up any MCP server yourself.
- There is no token or cost readout anywhere in the panel. Hearth does not
  parse the CLI's stream to extract that information, on purpose — doing so
  would mean depending on the internal shape of output that isn't a
  supported integration surface.
- The **activity timeline** next to the terminal is fed exclusively by
  Hearth's own command journal (`.hearth/log/commands.jsonl`, see
  [project-format.md](./project-format.md#hearthlogcommandsjsonl)) — a
  record of engine commands the CLI happened to run through Hearth's MCP
  server, not anything read out of the agent's own process.
- Login is entirely the CLI's own business: starting Claude Code
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

- **Launcher selector** — choose **Claude Code**, **Codex**, **OpenCode**,
  **Hermes**, or a plain **Terminal / other CLI**. The panel detects each of
  the first four on `PATH` (plus a local `ollama`, for OpenCode's provider
  step) and shows an honest state per tool: ready to start, not found, or
  still checking.
- **Permission mode selector** — a 4-tier ladder (`Read-only` / `Safe edit`
  / `Full (no build)` / `All (incl. build)`) above the terminal, defaulting
  to Safe edit. It applies to whichever tool is selected — Claude Code,
  Codex, OpenCode, and Hermes all write the chosen mode into their own MCP
  config — and is only inert for the plain terminal, which launches no MCP
  server. See [Permission modes](#permission-modes) below.
- **Start agent** — for any of Claude Code / Codex / OpenCode / Hermes, first
  runs that tool's *prepare* step, then spawns the real CLI in the terminal
  pane:
  - **Claude Code** → merges a `hearth` entry into the project's
    `.mcp.json`.
  - **Codex** → runs `codex mcp get hearth` to check, then `codex mcp add
    hearth -- …` if it isn't already correct, writing `~/.codex/config.toml`
    (a **global** config — see [connect-codex.md](./connect-codex.md)).
  - **OpenCode** → merges a `hearth` entry into the project's
    `opencode.json`, and adds an Ollama provider block automatically when
    local models are found and none is configured yet (see
    [connect-opencode.md](./connect-opencode.md)).
  - **Hermes** → merges a `mcp_servers.hearth` entry into
    `~/.hermes/config.yaml` (also **global** — see
    [connect-hermes.md](./connect-hermes.md)).

  Every prepare is idempotent (a no-op if the entry is already correct at
  that mode) and also backfills the project's `.claude/skills/` if missing.
  Claude Code discovers `.mcp.json` itself, asks you to approve the server
  on first use, and handles its own login if needed — all inside the
  terminal; Codex/OpenCode/Hermes do the same in their own way.
- **Install Claude Code** — shown instead of Start when `claude` isn't found
  on `PATH`. Runs the official install command visibly in the terminal (no
  hidden installs happen anywhere), then re-detects.
- **Open Terminal** — a plain shell (`$SHELL` on macOS/Linux, PowerShell on
  Windows) in the project root, for any other shell-native agent/tool or
  manual installs. `hearth` is already on its `PATH`.
- **Stop** — kills the current terminal session.
- **Activity timeline** — the right-hand rail: one row per journaled
  command (icon by kind, summary, ok/✗, relative time), newest first.
  Playtest rows show pass/fail and assertion counts; validate rows show
  error/warning counts.
- **Checkpoint / Review changes / Revert session** — the timeline's header
  actions: `snapshotProject` (`Checkpoint`), focusing the Changes panel
  (`Review changes`), and `revertProject` with a confirm dialog (`Revert
  session`, disabled when there's nothing to revert). A link to the
  History panel covers granular per-command undo instead of a
  whole-session revert.
- **Manual setup** — a collapsible section with the CLI/MCP copy-paste
  snippets and the permission-mode table, for anyone not using the embedded
  terminal at all (see [Manual setup](#manual-setup-fallback-for-any-tool)).

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

Selecting a mode and starting an agent rewrites that tool's own config with
the selected mode and (re)launches the CLI so the change takes effect
immediately, whichever of the four tools you picked. Denied tool calls return
a structured `PERMISSION_DENIED` error the agent can relay to you, rather
than failing silently — same behavior as the CLI and MCP server outside the
panel.

## Manual setup (fallback for any tool)

Every tool in the launcher dropdown is one-click from the panel now, so
manual setup is a fallback, not a requirement — useful if you're driving an
agent outside the editor entirely, want to see exactly what gets written
before trusting the automatic path, or are wiring up any other MCP-capable
client. The Manual setup section's snippets cover:

- The plain CLI loop (`hearth snapshot` → `hearth inspect` → edit → `hearth
  validate` → `hearth diff`) for any agent that just gets a shell.
- `claude mcp add hearth -- node <mcp path> --project <project path>` for
  Claude Code from outside the panel.
- A raw `.mcp.json` block for any other MCP-capable client that reads the
  same shape (Cursor, Cline, Windsurf, and others — see
  [connect-any-agent.md](./connect-any-agent.md)).
- The same permission-mode table as above.

Per-tool config formats and exact commands for Codex (`~/.codex/config.toml`
via `codex mcp add`), OpenCode (`opencode.json` + Ollama provider), and
Hermes (`~/.hermes/config.yaml`) are in their own connect guides:
[connect-codex.md](./connect-codex.md), [connect-opencode.md](./connect-opencode.md),
[connect-hermes.md](./connect-hermes.md).

This manual section is exactly the content that used to be the whole Agent
panel before the embedded terminal (and, later, per-tool auto-wiring)
shipped; it hasn't gone away, just moved to a collapsible section
underneath the live terminal.

## The external-change model

The editor now live-follows changes made *outside* itself — from the
embedded terminal, a separate CLI invocation, or another MCP session —
using the same journal that feeds the timeline:

- The project server watches `.hearth/log/commands.jsonl` for the open
  project (`fs.watch` plus a polling fallback) and pushes new entries to
  every connected editor over one WebSocket endpoint.
- Every `/api/*` request and the `/api/ws` upgrade enforce Origin/Host
  before doing anything else: a request with no `Origin` header is allowed
  (non-browser clients like the CLI/MCP server never send one), but a
  present `Origin` must resolve to a loopback hostname
  (`localhost`/`127.0.0.1`/`::1`), and a present `Host` header is checked
  the same way as a DNS-rebinding backstop. This is what stops a hostile
  webpage from driving the local project server just by pointing a
  browser tab at its port — there's no auth token to check, so Origin/Host
  is the only defense a loopback dev server has.
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

**"Install Claude Code" instead of "Start agent."** The panel didn't find
`claude` on `PATH`. Click **Install Claude Code** (runs the official
install command in the terminal so you can see exactly what it does), then
**Re-detect** once it finishes. If you installed it in a way that doesn't
land on the `PATH` the editor's process sees (e.g. a shell-specific rc file
change, or a version manager) `Re-detect` still won't see it until you
restart the editor from a shell that has the updated `PATH`.

**"Install Claude Code" hangs or doesn't respond.** Agent detection times out after 3 seconds per CLI. If your shell is slow to start, the detection may fail silently. Click **Re-detect** to try again, or check your shell startup files for expensive operations that might be slowing things down.

**"Agent setup failed: ... exists but is not valid JSON/YAML" (409).** The
selected tool's config file already exists but doesn't parse — `.mcp.json` or
`opencode.json` not valid JSON, or `~/.hermes/config.yaml` not valid YAML (or
not a mapping). Hearth refuses to overwrite a file it can't safely merge into
rather than clobbering whatever's there — fix or delete the file and start
the agent again. (This surfaces as HTTP 409 from the panel's
`/api/agent/prepare` call if you're driving it directly.) Codex is the one
exception: it doesn't hand-merge TOML at all, so a config problem there
instead surfaces as a `codex mcp add` failure with Codex's own error text.

**Terminal shows "Exited" after switching projects.** Expected: this
release supports one PTY per open project, and switching projects tears
down the old project's WebSocket connection, which kills its terminal
session with it. Start the agent or terminal again in the new project — the
old session isn't recoverable, but nothing about it was silently lost either
(its work is exactly what's on disk plus whatever the timeline/journal
recorded).

**Nothing happens when I click Start agent.** Check for an inline
"Agent setup failed: …" message under the toolbar — the panel deliberately
refuses to launch the selected tool if writing its config failed, since a
stale config from an earlier session could otherwise grant a more permissive
mode than the one you just picked without telling you.

**The terminal looks frozen / stopped updating.** Check the WebSocket
status implicitly via whether other live panels (Hierarchy, Console) are
still updating from external changes; a dropped connection reconnects
automatically with backoff. If the whole editor lost its connection to the
project server (e.g. the dev server or app process restarted), reload the
editor.
