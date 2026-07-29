# Projects and chats

Everything Hearth makes is a plain file in a plain folder. There is no library,
no database, no cloud account. If you want to know what Hearth has done, you
can `ls` it.

## Projects are made by describing one

The Home screen has no project picker, because the first message *is* the
project. Send one, and Hearth makes a folder under `~/Hearth` named after what
you asked for, opens it, and starts the conversation there.

The name comes from your words. Hearth lowercases them, drops filler
(`a`, `the`, `make`, `me`, `game`, `build`, `please`, and forty-odd others),
keeps the first four words that survive, and joins them with dashes, trimming
to 40 characters at a word boundary:

```
"make me a little platformer with slimes"  →  ~/Hearth/little-platformer-slimes
"a game about a lighthouse"                →  ~/Hearth/lighthouse
"make me a new game"                       →  ~/Hearth/new-game
```

A folder is a project is a game — one of each, never a folder holding several.
On disk it is a folder; in the app it is only ever a project.

**The folder name is not the project's name.** When Hearth asks what to call
the game, what you type is kept exactly as you typed it, in any script, with
any punctuation, and that is what the rail, the title bar and every list show.
The folder is a plainer version of it, because a folder name has to survive
every filesystem, shell and git remote: `Café Adventure` lives in
`~/Hearth/cafe-adventure`, and a name written in a script with no ASCII in it
gets a folder derived from the name (`~/Hearth/project-1f0ac33e`) rather than a
generic one. The name is stored in `.hearth/project.json` and travels with the
folder. A project that has no stored name is shown as its folder, which is what
every project made before this behaved like, so nothing needed migrating.

**New chat** and the Home screen are the same surface: a greeting, a composer,
and a chip saying which project the message lands in. It starts on whatever you
worked on last, so carrying on with the same game takes no interaction at all;
the chip's menu switches project, and its last item is **New project**, which
arms the composer so your first sentence names and creates the folder.

Every project carries a mark — one glyph in one colour, taken from its path so
it exists before anyone chooses anything and never changes on its own. Change
it from the project's row menu under **Appearance**; the choice is written to
`.hearth/project.json`, which is plain, safe to commit, and travels with the
folder. Each chat wears its project's mark too, because the chat list spans
every project on the machine.

If that name is taken, it gets a numeric suffix (`lighthouse-2`). Set
`HEARTH_PROJECTS_DIR` to put the whole workspace somewhere other than
`~/Hearth`.

The folder starts **empty**. Nothing is scaffolded, no template, no manifest —
whatever the agent builds is the only thing in it. That is why Hearth doesn't
care what your agent chose to write.

## What `.hearth/` holds

The one folder Hearth writes for itself:

```
.hearth/
  chats/index.json          every conversation: id, title, timestamps
  chats/<chatId>.jsonl      one conversation, one JSON record per line
  chats/attachments/<chatId>/  files you sent with a message
  app.json                  this project's agent settings (see below)
  project.json              its name, mark and colour — plain, safe to commit
  tester/memory.md          what your tester remembers about this game
  tester/sessions/<n>/      note.json plus the pictures it cited
  evidence/journal.jsonl    the bot sweep event stream
  evidence/sweeps/<id>/     report.json, runs/, shots/
  evidence/capabilities.json  what the last sweep found the game could sense
  log/commands.jsonl        what ran here, so a session can say what changed
  harness.json              connectors you registered
```

Playtests live here, under the project, because a playtest is a fact about one
game. Chats are the same. The only thing Hearth keeps about you rather than
about a game is skills, which is why those are the one thing in `~/.hearth/`.

Chat records are appended to disk *before* they are broadcast, so a transcript
survives a crash, a quit, or an agent that dies mid-turn. Each line is either
`{role: "user", ts, text}` or `{role: "agent", ts, event}` — the same event
vocabulary the live stream uses, which is why reopening a chat renders exactly
what you saw the first time. Titles come from the first message, trimmed to 60
characters; a first message that was only a file is titled from the filename.

A user record carrying files also has an `attachments` array of
`{name, mimeType, relPath}`, pointing at the copies under
`chats/attachments/<chatId>/`. The files are written down before the turn
starts — that is what lets the agent be handed a path instead of a blob, and
what lets the transcript show the picture again after a restart. Names are
flattened to one safe segment and prefixed, so two files called
`screenshot.png` in one conversation stay apart
([agents.md](./agents.md)).

The evidence layout is described in [playtesting.md](./playtesting.md).

## Skills live outside the folder

Skills belong to you, not to a game, so they live in `~/.hearth/skills/` and
apply to every project on the machine ([agents.md](./agents.md)). The one thing
they leave in a project folder is `<project>/.claude/skills/`, where Hearth
symlinks (or copies) the enabled ones so the Anthropic Agent SDK can discover
them. It is regenerated on every bind and safe to delete; anything you put in
that folder yourself is left alone.

## Where keys live

`.hearth/app.json` holds this folder's provider choice and, if you typed one, an
API key — **per folder, not global**. Hearth never sends a key to the UI; the
settings dialog only ever learns whether one exists and whether it came from the
file or the environment. A ChatGPT sign-in isn't stored by Hearth at all: that
credential belongs to the Codex CLI, in its own `~/.codex/auth.json`, which
Hearth reads a status from and nothing more. See [agents.md](./agents.md).

`.hearth/app.json` is not gitignored, so if you plan to commit the folder,
prefer the environment variable to the key field.

## Opening a project you already have

**File → Open a project…** (⌘O) takes any directory. There is no
requirement — no manifest, no marker file, not even any contents. A folder with
no `.hearth/` simply has no chats yet; the directory is created the first time
one is saved.

That works both ways: a game an agent built somewhere else opens in Hearth and
gets a game pane and playtests, and a folder Hearth created is an ordinary
project you can open in an editor, run a dev server in, or push to GitHub.

Recently opened folders are remembered globally in
`~/.hearth/recent-projects.json` (twelve of them, path and name only).

## Moving, copying, backing up

Move the folder. Zip it. Commit it. Nothing outside it points in except the
recents list, which is cosmetic. Copies carry their conversations and their
evidence with them, because those are files inside the folder like everything
else.

Two things worth knowing before you commit one:

- `.hearth/chats/` is your transcript history, and `chats/attachments/` holds a
  copy of every file you sent with a message. Keep them if you want the record;
  delete them if you'd rather not publish your conversations.
- `.hearth/tester/` grows with every session your tester plays, mostly PNGs.
  `memory.md` is the one file in there worth committing if you commit any of
  it: it is prose, you can edit it, and it is what the tester knows about your
  game.
- `.hearth/evidence/` grows with every bot sweep, mostly PNGs. It is safe to
  delete at any time — the next sweep starts a new numbered directory and the
  app simply shows an empty rail until then.
