# Architecture

Hearth is a desktop app around three things a chat window can't give you: a
pane where the game runs while the agent edits it, bots that play it and leave
evidence, and folders on your disk that are just folders. This page is how
those are actually built.

## One local server, one window

Electron's main process starts a plain Node HTTP server on `127.0.0.1` with an
OS-assigned port, then loads the window at that URL. The server serves the
built UI, a small JSON API under `/api`, and two static mounts. In development
the exact same handler runs as a Vite plugin, so the renderer is byte-identical
in both modes.

It is one server per app process, not one per folder: a project root is named
per request (`?project=<abs path>`, a body field, or an encoded path segment),
and folders you have deliberately opened this run form the jail every file
route checks against. Requests are refused unless the `Origin` and `Host` are
loopback — a request with no `Origin` at all is allowed, because that is what a
CLI or an MCP server looks like.

The two mounts:

- `/game/<key>/<rel>` — the folder itself, which is what the game pane's iframe
  loads. The root is encoded into the *path* rather than a query parameter so a
  game's own relative URLs (`./main.js`, `assets/sprite.png`) resolve correctly
  from inside the iframe.
- `/evidence/<key>/<rel>` — the folder's `.hearth/evidence`, so screenshots the
  probe captured can be shown without copying them anywhere.

## One multiplexed socket

Everything live rides a single WebSocket at `/api/ws`, subscribed to one
project via `?project=`. Sockets sharing a root share one channel — one journal
watcher, one evidence watcher — which is disposed when the last of them leaves.

Frames, by family:

- **chat** — `chat-send`, `chat-open`, `chat-new`, `chat-cancel`,
  `chat-interrupt`, `chat-approval` up; `chat-ready`, `chat-event`,
  `chat-opened`, `chat-list`, `chat-providers` down.
- **evidence / journal** — batched watcher output, broadcast to every socket on
  the root.
- **pty** — `pty-start/input/resize/stop` up, `pty-data/exit/attach/error` down.
  These are per-socket, never broadcast, and a detached terminal lingers for an
  hour so a reload reattaches to the same shell instead of killing it.
- **export** — progress, done, error.

Approvals ride this socket rather than an HTTP round trip because the agent's
turn is genuinely blocked until one arrives.

## Chat drivers

One `ChatDriver` interface, three implementations, selected per turn:

- `agent-sdk` — the Anthropic Agent SDK, one long-lived streaming query per
  conversation, rooted at the folder.
- `codex` — the open-source Codex CLI spawned as `codex app-server`, driven
  over stdio JSON-RPC.
- `stub` — no provider configured; it explains the three ways to connect one.

Every provider's output is folded into one provider-agnostic event vocabulary
(`message-delta`, `tool-begin`, `tool-end`, `file-change`, `approval-request`,
`turn-complete`, …), so the transcript renderer knows nothing about who
answered. Adding a third backend means writing a mapping, not a renderer.

Drivers are keyed by `(root, chatId)`, so two windows on one conversation share
its agent and the driver only dies when the last of them leaves. Every turn and
tool event is appended to `.hearth/chats/<id>.jsonl` as it streams — history
survives anything the live driver doesn't. See [agents.md](./agents.md).

## The probe contract

The probe knows nothing about engines, formats, or 2D pixels. It drives one
interface — `GameUnderTest` — whose implementations declare what they can do:

```ts
interface GameUnderTest {
  readonly capabilities: ProbeCapabilities;   // input vocabulary + senses
  start(); stop(); step();                    // sample one unit of game time
  setActionDown/Up(); setAxis(); sendPointer();
  listEntities?(); findEntity?(); screenshot?(); navGrid?(); reset?();
}
```

Two rules are structural, not conventions. **Capabilities are declared, never
assumed**: the optional methods are literally absent unless the matching
capability is true, and a check that needs a missing sense is skipped with a
reason instead of silently passing. **Nothing assumes determinism**: the bot's
RNG is seeded and replays exactly; the game's response is treated as a
distribution.

`@hearth/adapter-web` is the implementation that ships, and it has two tiers:

- **Zero cooperation.** Point it at a directory or a URL. It opens the page in
  headless Chromium, injects real keyboard and pointer input, captures PNGs,
  and collects console errors. Senses it can honestly claim: `errors`,
  `screenshot`, and `reset` by full page reload.
- **Shim.** If the page exposes `window.__hearthProbe`, the adapter upgrades
  the declared capabilities to match what the shim provides: entities, scene
  ids, an event stream, a nav grid, a cheap in-page reset
  ([probe-shim.md](./probe-shim.md)).

A connector for anything else — an engine, a device — is the same contract
implemented differently ([connect-your-engine.md](./connect-your-engine.md)).

## The evidence bus

`.hearth/evidence` is the neutral bus between whatever ran the probe and
whatever renders it. A sweep started by the Playtest button, by the CLI, or by
an agent over MCP writes the same files: an append-only `journal.jsonl`, a
folded `report.json` per sweep, per-episode JSON, and screenshots.

The app tails that journal and broadcasts new lines to every socket on the
root. There is no second progress channel — **the journal is the progress**, so
what the rail shows and what an agent reads back can never disagree. The
watcher uses a directory `fs.watch` as its primary signal with a 2-second poll
as a fallback, debounced, and treats a missing or half-written file as the
normal case rather than an error — delivery is keyed on a sequence number, not
a byte offset, so a line written while it reads is picked up on the next pass.

## Reload, by polling

The game pane refreshes by polling `/api/game/status` every 1.5 seconds and
comparing a timestamp: the newest file mtime under the game's directory, from a
bounded walk that skips `node_modules`, `.git`, `.hearth` and friends. When it
moves, the iframe URL's cache-buster changes and the pane reloads.

This is deliberately a poll and deliberately a timestamp. The agent writes files
through whatever toolchain it likes, so there is no reliable "I finished" signal
to subscribe to, and "something changed" is all the pane needs to know.

## The harness registry

A folder's registry is the honest answer to "what can this Hearth reach, and
what does it know how to do?" — connectors (things it can talk to) and skills
(things it knows how to do with them). Built-ins are facts about the binary and
are never written to disk; anything you register lands in `.hearth/harness.json`.
Every entry carries a status the app assigns: `active` (wired up and used now),
`available` (registered, nothing consumes it yet), or `coming-soon` (named, not
built).
