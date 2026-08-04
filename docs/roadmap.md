# Roadmap

**v1.9.0 is the current release**: the agent-first Hearth app, a conversation
with a coding agent, an always-on game pane, and a private tester that plays
your game and tells you what it made of it. That app began at v1.3.0.

Hearth used to be a 2D game engine. That engine is preserved on the
[`engine-v1`](https://github.com/echoo19/hearth/tree/engine-v1) branch, final
release v1.2.1, and is no longer developed. Its own roadmap, with the full
0.1 → 1.2.1 history, is
[on that branch](https://github.com/echoo19/hearth/tree/engine-v1/docs/roadmap.md).

This page is the honest list of what's next and what is deliberately missing,
with no dates attached.

## Where the app is now

Shipped and in use:

- Chats become folders under `~/Hearth`; everything is plain files
  ([projects-and-chats.md](./projects-and-chats.md)).
- The game runs beside the conversation and reloads when the agent writes.
- The private tester: a model opens your game and plays it the way a person
  would, taps and holds real keys, keeps notes across sessions, and reports
  only what it actually saw, with every claim anchored to a picture it took
  ([tester.md](./tester.md)). Its plan of action arrives with nothing ticked,
  and approving sends the work to your agent in a conversation of its own.
- Bot sweeps at the zero-cooperation tier: seeded bots, crash / stuck /
  black-screen / wall-bump / sealed-region checks, verdicts, screenshots, and
  evidence on disk. The agent's tool, not the person's, and good at finding
  crashes rather than at telling you whether the game is any good
  ([playtesting.md](./playtesting.md)).
- The optional `window.__hearthProbe` shim, for games that choose to say more
  about themselves ([probe-shim.md](./probe-shim.md)).
- Three ways to bring an agent: the Claude Code CLI you are signed into (an
  API key is optional), ChatGPT through the open-source Codex CLI, or any CLI
  in a terminal. The conversation drives the two CLIs Hearth integrates;
  anything else you run yourself in the terminal, in the same folder
  ([agents.md](./agents.md)).
- Conversations that survive: each chat resumes its backend's own session
  across reloads and restarts, Stop ends the turn without ending the agent,
  and the model, agent and effort can change between two messages in the same
  chat ([agents.md](./agents.md)).
- Permission modes, per project: ask before every write, work freely inside the
  folder and ask outside it, or skip the checks. Honoured by every harness
  Hearth drives, and stored on your machine rather than in the project, so a
  repository you push never carries it ([agents.md](./agents.md)).
- Images and files attached to a message, by drop, paste or picker, and handed
  to either backend as a path ([agents.md](./agents.md)).
- Structured questions, MCP forms, and each provider's real approval choices,
  answered in the transcript without flattening them into a generic prompt
  ([agents.md](./agents.md)).
- Continue in CLI hands the exact Claude Code or Codex session to a terminal
  and returns ownership to Hearth when that process exits ([agents.md](./agents.md)).
- Skills: `SKILL.md` folders in `~/.hearth/skills/`, in the format Claude Code
  and Codex both read, switched on and off in the sidebar's Skills panel
  ([agents.md](./agents.md)).
- The same probe outside the app, as a CLI and an MCP server
  ([cli.md](./cli.md), [mcp.md](./mcp.md)).

## Next

**Connectors.** The probe drives one engine-blind contract, and web games are
the only implementation of it today. Godot is the named next target, with no
date attached ([connect-your-engine.md](./connect-your-engine.md)). Every
connector inherits the existing policies, verdicts and evidence format
unchanged; that is the point of keeping the contract narrow.

**Richer senses.** More of what a bot can notice without the game's help:
better novelty signals from pixels alone, audio, and more of the reasoning that
currently needs entity positions. The rule stays the same: a sense that isn't
there is declared absent, never faked.

**Per-project skills.** Skills are global to the machine today, which is right
for "how I like sprites drawn" and wrong for "how this game's save format
works". Scoping some of them to a folder is the obvious next shape.

**Reading evidence back.** The report is written for a context window, and an
agent that ran the sweep already has it. Getting a finding in front of a person
without making them open files is still unsolved. Closing that loop properly is
a small feature that changes how the app feels.

## Further out

Directional, no dates, nothing promised:

- Deeper repro tooling: freezing a failing episode into a test that stays red
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
