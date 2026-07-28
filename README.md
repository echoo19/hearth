<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/readme-banner-dark.svg">
  <img src="assets/brand/readme-banner-light.svg" alt="Hearth" width="480">
</picture>

### The app for open-ended agentic game dev

[Download](https://hearthengine.com/download) · [Quickstart](docs/quickstart.md) · [How it works](https://hearthengine.com/how-it-works) · [Feedback](https://hearthengine.com/feedback)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/media/hearth-window@2x.png" alt="The Hearth window: a sidebar of project folders on the left, a conversation with a coding agent in the middle, and the game running in a pane on the right" width="900">

</div>

## What it is

You type what you want to play. A coding agent builds it however it likes:
plain web tech, whatever libraries it reaches for, no format Hearth imposes.
Hearth adds what a chat window can't. The game runs beside the conversation and
stays running while the agent edits, and the agent can open it in a real browser
to check its own work. And the agent is yours: a Claude key, a ChatGPT sign-in,
or any CLI you already run.

## Get it

[Download the app](https://hearthengine.com/download) for macOS (`.dmg`),
Windows (`.exe`), or Linux (`.AppImage` / `.deb`), or take it from the
[latest release](https://github.com/echoo19/hearth/releases/latest). The
current release is v1.5.0. macOS
builds are Developer ID signed and notarized; Windows builds aren't code-signed
yet, so SmartScreen wants **More info → Run anyway** the first time. After that
the app updates itself. Details in [docs/desktop-app.md](docs/desktop-app.md).

From source, with Node 20 or newer (`npm run app` for the desktop shell):

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install && npm run dev     # the app at http://localhost:5173
```

## How a session works

**You say it.** The window opens on a greeting and a composer. Type
`a tiny roguelike where the walls move` and send.

**A folder appears.** Hearth names it from your words, creates
`~/Hearth/tiny-roguelike-where-walls`, opens it, and starts the conversation
inside it. Opening a folder you already have is one click in the sidebar.

**The agent builds.** It writes plain files into that folder. Hearth doesn't
care what they are as long as a browser can run them, so there's no project
format to satisfy and no scene file to learn.

**The pane keeps up.** The game runs in the pane on the right while the agent
works, picking up changes as the files land, so you watch the change happen
instead of reading a summary of it.

**The agent checks its own work.** After a change lands it can open the game in
a real browser, press a few keys, and see whether it still runs. You don't have
to ask. This catches the blunt failures: the game throwing an error, drawing
nothing at all, or sitting there while nothing happens. None of that needs any
cooperation from your game, so it holds whatever the agent built.

It won't tell you whether the game is any good. Fun, feel, pacing and difficulty
are still yours to judge. This is a check the agent runs, not a surface you
operate, so there's no button for it. You can run the same thing yourself from a
terminal with `hearth-probe sweep .`; see [docs/playtesting.md](docs/playtesting.md)
and [docs/cli.md](docs/cli.md).

## Bring your own agent

**Claude.** Paste an Anthropic API key and pick a model per message: Opus,
Sonnet, or Haiku. Claude's model binds when a conversation's agent starts, so a
change applies from your next new chat.

**ChatGPT.** Hearth talks to your installed [Codex
CLI](https://github.com/openai/codex), the open-source one, and Codex holds the
sign-in. The credential stays in `~/.codex/auth.json` and Hearth only reads a
status from it. Models come live from the binary, reasoning effort included.

**Anything else.** The sidebar has a Terminal beside Chat, with a real shell in
it. Run `claude`, `codex`, or whatever CLI you like. Hearth watches the folder
either way, so the pane keeps up whichever agent is doing the work.

**Show it something.** Drop an image or a file onto the composer, paste one, or
pick it. A message that is only a picture is a message. Attachments are saved
into the project and handed to the agent as a path; images go to the model as
pixels either way.

**Teach it once.** A skill is a folder with a `SKILL.md` in it, the format
Claude Code and Codex both already read, so one skill works with whichever
agent answers. They live in `~/.hearth/skills`, apply to every project, and
switch on and off in the Skills panel in the sidebar.

Setup, keys, attachments, skills, and approvals:
[docs/agents.md](docs/agents.md). For agents working outside the app, the probe
is also an MCP server and a CLI ([docs/mcp.md](docs/mcp.md),
[docs/cli.md](docs/cli.md)).

## The probe, for game authors

With no cooperation at all, the probe opens your game, sends input, watches for
errors, and takes screenshots. That baseline is what most sweeps run on.

If you want the bots to see more, the game can say so. Drop in `probe-shim.js`,
describe your world (action names, entities, current scene, an event or two),
and you get entity tracking, named events, scene changes, and cheap resets.
It's a single file you own with no build step, and it does nothing until a
probe reads it. See [docs/probe-shim.md](docs/probe-shim.md), or
[docs/connect-your-engine.md](docs/connect-your-engine.md) for games that don't
run in a browser.

## Where things live

Projects are folders under `~/Hearth`, one per game, and they're yours: move
them, back them up, open them in any editor. Inside each, `.hearth/chats` holds
the conversations as JSONL and `.hearth/evidence` holds sweep reports, run
records, and screenshots. The rest is your game, in whatever files the agent
wrote. Nothing lives in a database or in the cloud.
[docs/projects-and-chats.md](docs/projects-and-chats.md) has the layout.

## What's being built now

**The private tester.** A playtester that belongs to your project rather than to
a conversation. It plays the game, and because it remembers every previous time
it played, it can answer the question a fresh pair of eyes never can: did the
change you just made help? It reads its own past notes before it starts, so it
arrives knowing where it got stuck last time, and it forms opinions across
sessions that no single playthrough produces.

Its memory is a plain markdown file in your project folder, so you can read what
it believes about your game and correct it by hand. Its session history is
append-only, so you can catch it contradicting itself.

It will not be good at your game, and it will not pretend to be. It costs model
calls on your own quota. Design notes are in
[apps/editor/docs/superpowers/specs](apps/editor/docs/superpowers/specs). **This
is not shipped yet**, so nothing above is in a release you can download.

## The engine that came before

Hearth used to be a 2D game engine. That engine is preserved (the
[`engine-v1`](https://github.com/echoo19/hearth/tree/engine-v1) branch, final
release [v1.2.1](https://github.com/echoo19/hearth/releases/tag/v1.2.1)) and no
longer developed. What's next is in [docs/roadmap.md](docs/roadmap.md); how the
app fits together is in [docs/architecture.md](docs/architecture.md).

## Contributing & license

Dev setup, ground rules, and the AI contribution policy are in
[CONTRIBUTING.md](CONTRIBUTING.md). Hearth is [MIT](LICENSE) licensed, free,
and open source.
