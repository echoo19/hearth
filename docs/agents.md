# Bring your own agent

Hearth does not ship an agent and does not resell one. It gives a coding agent
a place to work — a folder, a running game, and playtests — and lets you pick
which agent that is. There are three doors, and they can all be open at once in
the same folder.

## 1. An Anthropic API key

Settings → paste an API key. Hearth runs Claude through the Anthropic Agent
SDK, rooted at the folder, with the transcript streaming into the conversation
pane.

The key is stored **per folder**, in `.hearth/app.json`. Hearth never sends it
back to the UI — the settings dialog only knows whether a key exists and
whether it came from that file or from `ANTHROPIC_API_KEY` in your environment.
Clear the field and save to remove it.

## 2. ChatGPT through the open-source Codex CLI

Hearth talks to [Codex](https://github.com/openai/codex), OpenAI's open-source
CLI, by spawning it as a child process (`codex app-server`) and driving it over
stdio. Sign in once with your ChatGPT account through Codex's own browser flow,
started from Hearth's settings.

Say that precisely, because it matters: **this is Codex doing the work, and
Codex holds the credential.** The sign-in token lives in `~/.codex/auth.json`,
which belongs to the Codex CLI. Hearth reads a status from it and nothing else —
it never reads the token, never proxies it, never forwards it anywhere. There is
no partnership here and no official integration; it is one open-source tool
launching another. An OpenAI API key works too, in the same place as the
Anthropic one.

## 3. Any CLI, in the terminal

The Terminal tab is a real shell at the folder root. Type `claude`, `codex`,
`opencode`, `hermes`, or whatever you use. Hearth detects nothing and installs
nothing; if the command works in your terminal it works here, because the shell
starts with your login shell's `PATH` merged in (a GUI-launched app otherwise
only inherits a minimal system `PATH`).

Terminals are independent of the conversation: a chat failure never takes the
terminal down, and vice versa. A terminal you leave stays alive for an hour, so
reloading the window reattaches to the same session with its scrollback
replayed rather than killing your agent mid-task.

For agents working outside the app entirely, the probe has its own MCP server
and CLI — see [mcp.md](./mcp.md) and [cli.md](./cli.md).

## The model selector

The composer carries a model choice with every message, so it can change
between two messages in the same conversation. What happens next depends
honestly on the backend:

- **ChatGPT / Codex: per message.** The model and the reasoning effort
  (low / medium / high) are sent with the turn and apply from that turn on.
- **Claude: per conversation.** The Agent SDK runs one long-lived query for the
  whole session, and its options — model included — are fixed when that stream
  opens. Picking a different Claude model applies to the next new chat, not the
  one you're in. Hearth doesn't fake it, because faking it would mean silently
  restarting your agent mid-conversation.

The Claude list is curated (Opus 5, Sonnet 5, Haiku 4.5). The ChatGPT list comes
live from your installed Codex binary, with a "Default" row that lets Codex use
whatever it is configured for. Reasoning effort only appears for Codex, because
only Codex exposes it.

The provider that answers is the one your choice names; if you haven't chosen,
Hearth uses whichever is configured, preferring an Anthropic key over a Codex
sign-in. With neither, the conversation replies with a short note telling you
about these three doors.

## Approvals

Agents work inside the folder without asking. Hearth interrupts you in two
cases:

- **A file change outside the project folder.** Edits inside are automatic;
  anything above it asks first, and shows you the path.
- **A command that doesn't obviously stay inside the folder.** Anything with
  `sudo`, `ssh`, `curl`, `wget`, `systemctl`, a root `rm`, or a path resolving
  outside the folder asks first, and shows you the command. The heuristic errs
  toward asking: a false "ask" is a small interruption, a false "allow" is
  someone's home directory.

An approval genuinely blocks the turn until you answer, and either window open
on that conversation can answer it. Enter allows, Escape denies. Nothing is
remembered as a standing policy — there is no "always allow" — but the question
and your answer are both written into the transcript, so the record of what you
let an agent do is permanent.

## Where the work lands

Your agent writes ordinary files into the folder; the pane reloads when they
change; the Playtest button plays what's there. Nothing about that requires the
agent to know Hearth exists. If you want to *tell* it, point it at
[playtesting.md](./playtesting.md) and [probe-shim.md](./probe-shim.md) — the
shim is the one thing a game can do to make its own playtests see more.
