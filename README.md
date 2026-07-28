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

Type what you want to play. A coding agent builds it, and the game appears in
the pane next to the conversation and keeps running while the agent works. Ask
for a change and watch it land, rather than reading a summary of it.

Nothing about your game has to be shaped for Hearth. There is no project format,
no scene file, no engine to learn. The agent writes plain files into a folder on
your computer, using whatever it thinks fits, and Hearth stays out of the way.
Building here should feel no different from a coding agent in a terminal with
nothing in your way, except that you can see what you are making.

And the agent is whichever one you already pay for.

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

## A playtester who remembers

Every project gets one. It plays your game, keeps notes on what it found, and
reads those notes back before it plays again. So it does not arrive blank each
time. It arrives knowing where it got stuck last week, and goes to see whether
you fixed it.

That memory is what lets it answer the question you actually ask after every
change, and the one nothing without a history can: **did that help?**

Here is a real session, the second one it played on a small platformer, after
the jump height went up:

> **It says your last change helped.**
>
> *What it thought you changed.* The player's jump height was changed.
>
> *Why it says that.* This time I saw the score reach 1 on picture 3, while
> last time I never collected any coins.
>
> *Anything worse.* Nothing got worse.
>
> *Still could not work out.* I could not work out how to reliably land on the
> first platform.

Every claim is pinned to the frame it happened on, so you can go and look. Its
memory is a plain markdown file in your project, so when it gets something wrong
about your game you open it and fix the line. Its old sessions never get
rewritten, so you can catch it changing its mind.

It is not a good player and it will not pretend to be. Anything that wants
reflexes will beat it, and what it writes down is what it tried and where it
failed, never a claim that it finished. It will not tell you whether your game
is fun either. That part is still yours.

Landing in the next release.

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

## Your files, your folder, no lock-in

Every project is an ordinary folder under `~/Hearth`. Move it, back it up, open
it in any editor, put it on GitHub, or walk away from Hearth entirely and take
the game with you. Nothing lives in a database, nothing lives in the cloud, and
there is nothing to export because it was never trapped anywhere.

Your conversations sit in there too, so the history of how the game got made
travels with it. [docs/projects-and-chats.md](docs/projects-and-chats.md) has
the layout if you want it.

## If your game wants to say more about itself

Everything above works on a game that has never heard of Hearth. Open it, press
keys, watch for errors, look at frames.

A game can offer more if it wants to. Drop in a small file, name your entities
and your actions, and the tester can see what it is looking at instead of
guessing from pixels. It is one file you own, with no build step, and it does
nothing at all until something asks. See
[docs/probe-shim.md](docs/probe-shim.md), or
[docs/connect-your-engine.md](docs/connect-your-engine.md) for games that do not
run in a browser.

This is an offer, never a requirement. A game that says nothing is a first-class
game.

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
