# Bring your own agent

Hearth does not ship an agent and does not resell one. It gives a coding agent
a place to work (a folder, a running game, and playtests) and lets you pick
which agent that is. There are three doors, and they can all be open at once in
the same folder. The conversation pane drives the two CLIs Hearth integrates;
everything else runs in a terminal.

If you already pay for Claude or ChatGPT, you are most of the way there:

- **Claude.** Hearth runs the Claude Code CLI. If you are signed into it on
  this machine, there is nothing to set up; your first message answers on that
  account. An API key is optional.
- **ChatGPT.** Sign in once through the open-source Codex CLI, from Settings.
  The credential stays with Codex.
- **Anything else.** Open a terminal conversation and run your own CLI. It is
  a real shell in the project folder.

## 1. Claude, through the Claude Code CLI

Hearth runs Claude through the Anthropic Agent SDK, which runs the Claude Code
CLI with the project folder as its working directory. The CLI authenticates
with whatever you already signed into, so a Claude subscription that works in
your terminal works in Hearth with no key at all. Settings shows the signed-in
account and plan, read from `claude auth status` and nothing deeper: the
credential is the CLI's, and Hearth never reads the token, never proxies it,
and never sends it anywhere.

It is the installed CLI, with its normal user, project, and local settings
sources enabled. That means `CLAUDE.md`, hooks, plugins, skills, feature flags,
dynamic workflows, Ultracode keywords, slash commands, subagents, background
tasks, MCP questions, and permission choices are not replaced by Hearth
versions. The command menu is read from the live CLI and updates when Claude
reports that its catalogue changed.

Not signed in yet? The row in Settings runs `claude auth login` in a terminal
and the browser flow finishes there, between you and Anthropic.

An API key is the other way in, for turns you want billed to a key rather than
answered on a subscription, or for a machine without the sign-in. Paste one in
Settings. It is stored **per folder**, in `.hearth/app.json`, and never sent
back to the UI; the settings dialog only knows whether a key exists and whether
it came from that file or from `ANTHROPIC_API_KEY` in your environment. Clear
the field and save to remove it. The key never reaches git either way: Hearth
writes `.hearth/.gitignore` when a project opens, and it ignores the whole
folder, key included.

## 2. ChatGPT through the open-source Codex CLI

Hearth talks to [Codex](https://github.com/openai/codex), OpenAI's open-source
CLI, by spawning it as a child process (`codex app-server`) and driving it over
stdio. Sign in once with your ChatGPT account through Codex's own browser flow,
started from Hearth's settings. If the binary is not on the machine, the same
row offers to install it (`npm i -g @openai/codex`).

Say that precisely, because it matters: **this is Codex doing the work, and
Codex holds the credential.** The sign-in token lives in `~/.codex/auth.json`,
which belongs to the Codex CLI. Hearth reads a status from it and nothing else.
It never reads the token, never proxies it, never forwards it anywhere. There
is no partnership here and no official integration; it is one open-source tool
launching another. An OpenAI API key works too, in the same place as the
Anthropic one.

Hearth uses Codex's app-server protocol for the native transcript: exact
approval choices, questions and MCP elicitations, skills, reasoning, plans,
tool output, images, subagents, compaction, and review are mapped into the
conversation. Its slash menu is read from `skills/list`; `/compact` and
`/review` call the corresponding Codex protocol methods, and skill commands
retain Codex's `$skill` semantics.

Some capabilities belong to a full-screen terminal UI rather than either
agent's machine-readable protocol. **Continue in CLI** in a conversation's
header covers those without starting a stranger: Hearth shuts down the native
adapter, waits for it to release the provider session, then resumes that exact
Claude session or Codex thread in the embedded terminal with the project's
configured executable and permission mode. The terminal exclusively owns the
session until it exits, so two front ends can never drive it at once.

## 3. Any CLI, in a terminal

**New terminal**, in the sidebar or on a project's own screen, opens a real
shell at the folder root. Type `claude`, `codex`, `opencode`, `hermes`, or
whatever you use. Hearth detects nothing and installs nothing; if the command
works in your terminal it works here, because the shell starts with your login
shell's `PATH` merged in (a GUI-launched app otherwise only inherits a minimal
system `PATH`).

Terminals are independent of the conversation: a chat failure never takes the
terminal down, and vice versa. A terminal you leave stays alive for an hour, so
reloading the window reattaches to the same session with its scrollback
replayed rather than killing your agent mid-task.

For agents working outside the app entirely, the probe has its own MCP server
and CLI. See [mcp.md](./mcp.md) and [cli.md](./cli.md).

The terminal is where every other agent goes. The conversation pane drives the
two CLIs above and only those two, because a transcript with tool rows and
approval prompts means Hearth knowing what each event of that agent's stream
means, and it only knows that for the harnesses it integrates. Running your
agent in the terminal gives it the same folder, the same shell and the same
game reloading beside it; what you give up is the transcript, not the work.

## Attaching images and files

Drop a file onto the composer, paste one, or pick it from **+ → Add photos &
files…**. All three do the same thing. Up to eight files per message, 12 MB
each and 24 MB in total. Files stream as raw HTTP bodies into bounded temporary
storage; the chat socket carries only short, opaque, project-scoped,
single-use tokens. Large PNG, JPEG and WebP previews may be scaled down in the
composer, but the original file is what gets uploaded and handed to the
agent. An animated GIF is never flattened. A message that is only a picture
is a message; you don't have to type anything with it.

Attachments are written into the project before the turn starts, under
`.hearth/chats/attachments/<chatId>/`, and the agent is handed the path.
Staging uses a temporary file and an atomic move; expired, reused, or
other-project tokens are refused. Because the final file is a file, the
transcript can still show it after a restart.

What the agent receives depends on the file, and only in one way:

- **Images** (PNG, JPEG, GIF, WebP) reach the model as pixels. Codex gets a
  `localImage` input item naming the path, so the bytes never travel through
  its JSON-RPC pipe; Claude gets the bytes as a base64 image block.
- **Everything else** travels as a path: a `mention` item for Codex, a line
  reading `Attached file: <path>` for Claude. The agent is already sitting in
  the folder with its own file tools, so pointing at a PDF or a zip is both
  cheaper and more useful than pushing it through the context window.

## Skills

A skill is a folder with a `SKILL.md` in it: frontmatter giving it a `name` and
a one-sentence `description` of when to use it, then the instructions. That
format is not Hearth's invention. It is the one Claude Code and Codex both
already read, which is why one skill works with whichever agent answers.

Skills live in `~/.hearth/skills/<slug>/`, and they are **global to the
machine, not per project**: something you taught your agent once should still
be known in the next game you start. `~/.hearth/skills.json` records which ones
are switched off.

**Skills** in the sidebar opens a screen listing what you have, one row per
skill: its name, the sentence saying when to use it, and a note naming who
installed it when that was not you. An off skill says so. Each row's menu has
open or edit, turn on or off, and delete for the ones Hearth owns. Above the
rows are a search box and a **+** offering three ways to make one:

- **Create with chat** puts a request in the composer for you to send. The
  agent has file tools and is already in the folder, so it writes the skill
  itself.
- **Create with editor** is three fields: the name, the one sentence about when
  to use it, and the instructions.
- **Upload from your computer** takes a folder you already have. It has to
  contain a `SKILL.md`, and the whole folder has to be under 4 MB and 64 files.

Deleting a skill removes the folder from your computer. The ones found in
Claude Code's and Codex's own folders open read-only: they are those tools'
files, and Hearth does not edit or delete them on their behalf.

Reaching each backend takes one step, and they are different steps. Both are
re-applied every time a conversation binds, so switching a skill off is felt on
the next message rather than after a restart:

- **Codex** is pointed at the folder with `skills/extraRoots/set`, a method on
  the app-server protocol. A Codex build that predates it simply doesn't see
  the skills; nothing else about the conversation changes.
- **Claude** discovers skills from the filesystem around its working directory
  and offers no way to point it elsewhere, so enabled skills are symlinked into
  `<project>/.claude/skills/`, copied where the platform refuses a symlink,
  such as Windows without developer mode. Links Hearth made and no longer wants
  are removed; a real directory you put there yourself is left alone.

## The model selector

The pill beside the composer names one agent at a time, and its menu lists that
agent's models and nothing else. Changing agent is a row of its own, under
**Switch agent**, so picking a model can never silently move the conversation
to a different vendor. A backend that cannot answer still lists its models
(hiding them answers "why isn't Opus in here?" with silence), but picking one
opens Settings instead of pretending the choice took.

Both lists are read from the backends rather than written by hand. The Claude
catalogue comes from the CLI you are signed into, so it is your account's list;
a short curated list stands in until that read lands or when nobody is signed
in. The ChatGPT list comes from your installed Codex binary. There is no
"Automatic" model row: the pill says which model would answer, or "Choose a
model" until you pick one.

**Switching model or agent mid-chat takes effect on your next message.** Both
backends fix their model when a session opens, so a switch rebinds the agent
before the next turn goes out. Each backend resumes its own session across the
rebind (Codex its thread, Claude its session), so the switch costs a restart,
not the agent's memory of the conversation.

### The effort dial

Next to the model pill is an **Effort** control, shown only when the active
model declares effort levels; a model without a dial gets no control rather
than an invented one. The choice travels with each message.

- **Claude** models declare their levels through the CLI's own catalogue
  (`low`, `medium`, `high`, `xhigh`, `max`, per model and per account). The
  effort is applied to the live session just before your turn goes out, so
  turning the dial changes the very next message, and **Automatic** hands the
  choice back to the model's default.
- **Codex** takes the effort with the turn itself, with whatever vocabulary
  your binary reports.

If you have chosen nothing at all, Hearth uses whichever agent is connected,
preferring Claude when both are. With neither, the conversation replies with a
short note about the three doors instead of pretending to build anything.

## Permission modes

Beside the model pill in the composer is a second pill saying how much your
agent may do without stopping to ask. Three answers, in the order they loosen:

- **Ask before writing or running.** Every file change, every command, and
  every MCP tool call waits for you, wherever it points. Reading is not
  interrupted, and the menu row says so rather than burying it: an approval in
  Hearth is a command or a file change, and a read or a search has no kind it
  could be raised as. An MCP tool call is raised as a command, because it is
  somebody else's code reaching whatever the server behind it reaches. The
  pill reads "Ask first".
- **Work in this folder.** The default, and what Hearth has always done. Work
  inside the open project goes ahead, and anything reaching outside it asks.
  This is the behaviour the section below describes. The pill reads "Ask
  outside".
- **Skip all checks.** Nothing asks, anywhere. The pill reads "No checks".

The third one is worth stating exactly. It does not mean fewer prompts, and it
does not mean prompts only for the dangerous things. It means the agent runs
commands and writes files anywhere your account can reach, without telling you
first, until you set it back. Choosing it puts a confirmation in front of you
the first time, with Cancel focused rather than the confirm, and the project
remembers you accepted so it will not ask there again.

### Where the choice is stored

Per project, in `~/.hearth/permissions.json`: one entry per folder, on this
machine, beside your skills.

It is deliberately not in `.hearth/project.json`, the file inside the project
that travels with the folder. A repo shipping `skip` would hand everyone who
clones it an agent running with no sandbox on their own computer. A permission
decision is a person deciding about their own machine, so a pushed repo carries
no permission decision at all and a folder you clone opens on the default.

That is also why there is no single machine-wide switch. `skip` in a scratch
folder you made this morning is a different statement from `skip` in a checkout
of somebody else's repository, and one global answer would carry the loosest
one you ever gave into every folder you open next.

Everything that can go wrong reading that file reads as the default: no entry,
no file, an unreadable one, a malformed one. There is no state in which failing
to read it leaves an agent more permissive than it is out of the box.

### What each backend is told

One vocabulary for you, two different sets of parameters underneath. Both
backends fix the policy when the conversation binds, so moving the pill during
a conversation rebinds the agent before your next message goes out. Each
backend resumes its own session across that rebind, the same way a model
switch does, so the control is honest without costing the conversation. The
alternative is a switch that silently does nothing until the next session,
which for this particular control is the difference between a preference and a
lie.

- **Claude, through the Agent SDK.** `ask` runs the SDK in `default`. `auto`
  runs `acceptEdits`, with Hearth's own check on top raising anything that
  reaches outside the folder. `skip` runs `bypassPermissions`, and Hearth's
  approval seam allows everything, so the two levers cannot disagree.
- **ChatGPT through the open-source Codex CLI.** An approval policy and a
  sandbox ride on every thread start and every resume: `ask` is `untrusted`
  with a `workspace-write` sandbox, `auto` is `on-request` with
  `workspace-write`, and `skip` is `never` with `danger-full-access`. Under
  `skip`, anything Codex raises anyway (a permissions request, an MCP
  elicitation) is answered allow rather than shown to you, because an Allow /
  Deny prompt under a pill reading "No checks" is the app contradicting itself.

The Codex sandbox stays `workspace-write` under `ask` for the same reason it
does under `auto`. The point of asking is that you see each step, not that a
step you approved then fails.

### What it does not reach

The menu says this itself, because neither half is obvious: the setting is for
chats in this project, and the tester and the terminal keep their own limits.

The tester binds its agent on the default whatever you have chosen here, and
denies any approval it is asked for. Nobody is watching a tester session, so
under `ask` every step would raise an approval into an empty room and the
session would wedge, and under `skip` an unattended agent would be running with
no sandbox at all ([tester.md](./tester.md)).

A CLI you start in a terminal owns its permissions from the moment it starts.
`claude` and `codex` have their own flags and their own settings files, and
Hearth neither hands them this setting nor overrides what they decide.

## Approvals

On the default setting, agents work inside the folder without asking. Hearth
interrupts you in two cases:

- **A file change outside the project folder.** Edits inside are automatic;
  anything above it asks first, and shows you the path.
- **A command that doesn't obviously stay inside the folder.** Anything with
  `sudo`, `ssh`, `curl`, `wget`, `systemctl`, a root `rm`, or a path resolving
  outside the folder asks first, and shows you the command. The heuristic errs
  toward asking: a false "ask" is a small interruption, a false "allow" is
  someone's home directory.

An approval genuinely blocks the turn until you answer, and either window open
on that conversation can answer it. Enter allows, Escape denies. Answering one
never becomes a standing policy: there is no "always allow" on an approval, and
the only standing decision is the permission mode above. The question and your
answer are both written into the transcript, so the record of what you let an
agent do is permanent.

A question can also become moot: you press Stop, the session ends, or the
backend dies while an approval is still open. The record then says
**Withdrawn**, with a line saying the session ended before you answered,
rather than a Deny you never pressed. The agent underneath is still refused
(nothing may run on a question nobody answered); only the record tells the two
apart, and the difference matters when you are reading back why an agent
skipped a step.

## While a turn is running

The foot of the turn carries a live line (a mark, a word, and a clock past a
few seconds) so you never have to guess whether the agent is thinking or
stuck. It says **Running** while a shell command is out, **Thinking** while the
model is reasoning, **Waiting for you** while an approval is unanswered, and
**Working** the rest of the time. A finished thought collapses into
`Thought for 12.3s`, which opens to show the reasoning behind it.

You can keep typing. A message sent while the agent is still answering is
**queued** rather than refused: it appears under the transcript in the place it
will occupy, and goes out on its own the moment the turn ends. Queued messages
leave one at a time, oldest first, and each can be taken back before it is sent.

Pressing **Stop** ends the turn and leaves the agent bound, so the next message
picks up with everything it already knows. It also releases the next queued
message, which makes "stop, do it this way instead" a single motion. A turn
that ends in an *error* does not release anything: one bad turn should not
become three. The queue is emptied when you switch conversations, since it
belonged to the one you left.

## Conversations survive restarts

A conversation is more than its transcript: the agent holds working memory of
the session, and Hearth keeps hold of it. Each chat remembers its backend's own
continuation handle (the Codex thread, the Claude session), and reopening the
chat, after a window reload, an app restart, or days away, resumes that session
rather than handing a fresh agent a transcript to read.

When a remembered Claude session cannot be resumed (its file pruned, a chat
copied to another machine), the conversation falls back to a fresh session and
says so with a notice, because a transcript that reads as continuous over an
agent that silently lost its context would be a transcript lying about the
conversation it was in.

## What the transcript shows

The app is meant to be a complete view of what the agent did, not a summary of
it, so the conversation carries more than prose and tool rows:

- **The plan.** Codex streams a plan item; Claude writes a todo list through
  its `TodoWrite` tool. Both become the same card, with a mark per line for
  done, doing and to do. A revision replaces the card in place rather than
  stacking another copy of the list.
- **Images.** An image the agent generated, or one it opened to look at, is
  rendered inline when it sits inside the open folder, because a generated
  sprite you cannot see is not a result. An image outside the folder is named
  instead of shown; the app only serves files from folders you opened.
- **Notices.** One quiet line when earlier turns were summarised to make room,
  when the agent waited, or when it entered or left review mode. These explain
  later behaviour that would otherwise look like a bug.
- **Nested agents.** A Codex subagent, a Codex collab-agent call and a Claude
  `Task` call all open the same subagent card.
- **Anything new.** A Codex item type this build has never heard of is rendered
  as a plain tool row titled with the item's own type. A badly labelled row is
  a much better outcome than an action that vanishes.

One gap, named rather than hidden: an agent can ask you a **structured
question** through Codex's `requestUserInput` or an MCP elicitation. The
question and its options are written into the transcript, so you can see what
was asked. But Hearth has no picker for *answering* one: the request is
answered with an empty reply so the turn doesn't wedge, and the agent carries
on with whatever it decides that means. Answering in your next message reaches
the same conversation, which is the workaround until there is a real answer
surface.

## Where the work lands

Your agent writes ordinary files into the folder; the pane reloads when they
change. Nothing about that requires the agent's cooperation. An agent Hearth
binds is told the room it is in: a short block of environment facts rides in
its system prompt saying where the pane looks for a game (`index.html`, then
`game/`, `dist/`, `public/`), where playtest evidence lands
(`.hearth/evidence/`), and that `.hearth/context/` holds the files you added
for it. Facts only. What game to make, and how, still comes entirely from you.

The same goes for tools: `hearth` and `hearth-probe` are on the PATH of the
embedded terminal *and* of every agent Hearth binds, so an agent can run its
own sweeps (`hearth-probe sweep .`) and read the results back without you
pressing anything. [playtesting.md](./playtesting.md) covers what a sweep
does; [probe-shim.md](./probe-shim.md) is the one thing a game can do to make
its own playtests see more.
