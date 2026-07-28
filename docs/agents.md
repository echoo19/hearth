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

## Attaching images and files

Drop a file onto the composer, paste one, or pick it from **+ → Add photos &
files…**. All three do the same thing. Up to eight files per message, 12 MB
each and 24 MB in total — one message travels down one socket frame, so the
budget is shared; PNG, JPEG and WebP images longer than 1568 px on their longest edge are
scaled down first, because both APIs would downscale them anyway (an animated
GIF is sent untouched, so it doesn't become one frame). A message that is only
a picture is a message — you don't have to type anything with it.

Attachments are written into the project before the turn starts, under
`.hearth/chats/attachments/<chatId>/`, and the agent is handed the path.
Because the file is a file, the transcript can still show it after a restart.

What the agent receives depends on the file, and only in one way:

- **Images** (PNG, JPEG, GIF, WebP) reach the model as pixels. Codex gets a
  `localImage` input item naming the path, so the bytes never travel through
  its JSON-RPC pipe; Claude gets the bytes as a base64 image block.
- **Everything else** travels as a path — a `mention` item for Codex, a line
  reading `Attached file: <path>` for Claude. The agent is already sitting in
  the folder with its own file tools, so pointing at a PDF or a zip is both
  cheaper and more useful than pushing it through the context window.

## Skills

A skill is a folder with a `SKILL.md` in it: frontmatter giving it a `name` and
a one-sentence `description` of when to use it, then the instructions. That
format is not Hearth's invention — it is the one Claude Code and Codex both
already read, which is why one skill works with whichever agent answers.

Skills live in `~/.hearth/skills/<slug>/`, and they are **global to the
machine, not per project**: something you taught your agent once should still
be known in the next game you start. `~/.hearth/skills.json` records which ones
are switched off.

The **Skills** fold in the sidebar lists what you have, each with a dot for on
or off. Clicking a row — or **Manage skills…** — opens the panel, where every
skill has a switch, an edit and a delete, with a search box above them and a
**+** offering three ways to make one:

- **Create with chat** puts a request in the composer for you to send. The
  agent has file tools and is already in the folder, so it writes the skill
  itself.
- **Create with editor** is three fields: the name, the one sentence about when
  to use it, and the instructions.
- **Upload from your computer** takes a folder you already have. It has to
  contain a `SKILL.md`, and the whole folder has to be under 4 MB and 64 files.

Deleting a skill removes the folder from your computer.

Reaching each backend takes one step, and they are different steps. Both are
re-applied every time a conversation binds, so switching a skill off is felt on
the next message rather than after a restart:

- **Codex** is pointed at the folder with `skills/extraRoots/set`, a method on
  the app-server protocol. A Codex build that predates it simply doesn't see
  the skills; nothing else about the conversation changes.
- **Claude** discovers skills from the filesystem around its working directory
  and offers no way to point it elsewhere, so enabled skills are symlinked into
  `<project>/.claude/skills/` — copied where the platform refuses a symlink,
  such as Windows without developer mode. Links Hearth made and no longer wants
  are removed; a real directory you put there yourself is left alone.

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

## While a turn is running

The foot of the turn carries a live line — a mark, a word, and a clock past a
few seconds — so you never have to guess whether the agent is thinking or
stuck. It says **Running** while a shell command is out, **Thinking** while the
model is reasoning, **Waiting for you** while an approval is unanswered, and
**Working** the rest of the time. A finished thought collapses into
`Thought for 12.3s`, which opens to show the reasoning behind it.

You can keep typing. A message sent while the agent is still answering is
**queued** rather than refused: it appears under the transcript in the place it
will occupy, and goes out on its own the moment the turn ends. Queued messages
leave one at a time, oldest first, and each can be taken back before it is sent.

Pressing **Stop** ends the turn and releases the next queued message, which
makes "stop — do it this way instead" a single motion. A turn that ends in an
*error* does not release anything: one bad turn should not become three. The
queue is emptied when you switch conversations, since it belonged to the one
you left.

## What the transcript shows

The app is meant to be a complete view of what the agent did, not a summary of
it, so the conversation carries more than prose and tool rows:

- **The plan.** Codex streams a plan item; Claude writes a todo list through
  its `TodoWrite` tool. Both become the same card, with a mark per line for
  done, doing and to do. A revision replaces the card in place rather than
  stacking another copy of the list.
- **Images.** An image the agent generated, or one it opened to look at, is
  rendered inline when it sits inside the open folder — a generated sprite you
  cannot see is not a result. An image outside the folder is named instead of
  shown, because the app only serves files from folders you opened.
- **Notices.** One quiet line when earlier turns were summarised to make room,
  when the agent waited, or when it entered or left review mode. These explain
  later behaviour that would otherwise look like a bug.
- **Nested agents.** A Codex subagent, a Codex collab-agent call and a Claude
  `Task` call all open the same subagent card.
- **Anything new.** A Codex item type this build has never heard of is rendered
  as a plain tool row titled with the item's own type. A badly labelled row is
  a much better outcome than an action that vanishes.

One gap, named rather than hidden: an agent can ask you a **structured
question** — Codex's `requestUserInput`, or an MCP elicitation. The question and
its options are written into the transcript, so you can see what was asked. But
Hearth has no picker for *answering* one: the request is answered with an empty
reply so the turn doesn't wedge, and the agent carries on with whatever it
decides that means. Answering in your next message reaches the same
conversation, which is the workaround until there is a real answer surface.

## Where the work lands

Your agent writes ordinary files into the folder; the pane reloads when they
change; the Playtest button plays what's there. Nothing about that requires the
agent's cooperation — but an agent Hearth binds is told the room it is in: a
short block of environment facts rides in its system prompt saying where the
pane looks for a game (`index.html`, then `game/`, `dist/`, `public/`), where
playtest evidence lands (`.hearth/evidence/`), and that `.hearth/context/`
holds the files you added for it. Facts only — what game to make, and how,
still comes entirely from you.

The same goes for tools: `hearth` and `hearth-probe` are on the PATH of the
embedded terminal *and* of every agent Hearth binds, so an agent can run its
own sweeps (`hearth-probe sweep .`) and read the results back without you
pressing anything. [playtesting.md](./playtesting.md) covers what a sweep
does; [probe-shim.md](./probe-shim.md) is the one thing a game can do to make
its own playtests see more.
