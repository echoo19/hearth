# Roadmap

**v1.4.0 is the current release** — the agent-first Hearth app: a conversation
with a coding agent, an always-on game pane, and bot playtesting that leaves
evidence behind. That app began at v1.3.0.

Hearth used to be a 2D game engine. That engine is preserved — the
[`engine-v1`](https://github.com/echoo19/hearth/tree/engine-v1) branch, final
release v1.2.1 — and is no longer developed. Its own roadmap, with the full
0.1 → 1.2.1 history, is
[on that branch](https://github.com/echoo19/hearth/tree/engine-v1/docs/roadmap.md).

This page is the honest list of what's next and what is deliberately missing.
No dates.

## Where the app is now

Shipped and in use:

- Chats become folders under `~/Hearth`; everything is plain files
  ([projects-and-chats.md](./projects-and-chats.md)).
- The game runs beside the conversation and reloads when the agent writes.
- Playtesting at the zero-cooperation tier: seeded bots, crash / stuck /
  black-screen / wall-bump / sealed-region checks, verdicts, screenshots, and
  evidence on disk ([playtesting.md](./playtesting.md)).
- The optional `window.__hearthProbe` shim, for games that choose to say more
  about themselves ([probe-shim.md](./probe-shim.md)).
- Three ways to bring an agent: an Anthropic key, ChatGPT through the
  open-source Codex CLI, or any CLI in the terminal
  ([agents.md](./agents.md)).
- The same probe outside the app, as a CLI and an MCP server
  ([cli.md](./cli.md), [mcp.md](./mcp.md)).

## Next

**Connectors.** The probe drives one engine-blind contract, and web games are
the only implementation of it today. Godot is the named next target, with no
date attached ([connect-your-engine.md](./connect-your-engine.md)). Every
connector inherits the existing policies, verdicts and evidence format
unchanged — that is the point of keeping the contract narrow.

**Richer senses.** More of what a bot can notice without the game's help:
better novelty signals from pixels alone, audio, and more of the reasoning that
currently needs entity positions. The rule stays the same — a sense that isn't
there is declared absent, never faked.

**Harness slots.** The registry already distinguishes what Hearth can reach
(connectors) from what it knows how to do with it (skills), and playtesting is
the only skill wired up. The slot exists so a second one can arrive without a
new architecture.

**Reading evidence back.** The report is written for a context window, but
moving a finding from the rail into the conversation is still a copy. Closing
that loop properly is a small feature that changes how the app feels.

## Further out

Directional, no dates, nothing promised:

- Deeper repro tooling — freezing a failing episode into a test that stays red
  until it's fixed.
- Better shim ergonomics, so opting into deeper senses is a smaller decision.
- Hearth Cloud: hosted services on top of the free local core. Nothing local
  ever gets gated behind it.

## Non-goals

- **Being a game engine again.** Hearth surrounds whatever the agent built; it
  does not supply a runtime, a scene format, or an asset pipeline.
- **A visual logic editor.** Agents write code, and humans get a real editor.
- **Built-in model calls in the probe.** The probe reports facts; judgment is
  the agent's job, and the agent is yours.
- **Cloud project storage.** Projects are local folders; use git.
- **Claiming an integration nobody granted.** ChatGPT works through the
  open-source Codex CLI, and that is exactly how it is described everywhere.
