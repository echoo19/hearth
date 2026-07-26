# Projects and chats

Everything Hearth makes is a plain file in a plain folder. There is no library,
no database, no cloud account. If you want to know what Hearth has done, you
can `ls` it.

## Chats become folders

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
  app.json                  this folder's agent settings (see below)
  evidence/journal.jsonl    the playtest event stream
  evidence/sweeps/<id>/     report.json, runs/, shots/
  evidence/capabilities.json  what the last sweep found the game could sense
  harness.json              connectors and skills you registered
```

Chat records are appended to disk *before* they are broadcast, so a transcript
survives a crash, a quit, or an agent that dies mid-turn. Each line is either
`{role: "user", ts, text}` or `{role: "agent", ts, event}` — the same event
vocabulary the live stream uses, which is why reopening a chat renders exactly
what you saw the first time. Titles come from the first message, trimmed to 60
characters.

The evidence layout is described in [playtesting.md](./playtesting.md).

## Where keys live

`.hearth/app.json` holds this folder's provider choice and, if you typed one, an
API key — **per folder, not global**. Hearth never sends a key to the UI; the
settings dialog only ever learns whether one exists and whether it came from the
file or the environment. A ChatGPT sign-in isn't stored by Hearth at all: that
credential belongs to the Codex CLI, in its own `~/.codex/auth.json`, which
Hearth reads a status from and nothing more. See [agents.md](./agents.md).

`.hearth/app.json` is not gitignored, so if you plan to commit the folder,
prefer the environment variable to the key field.

## Opening a folder you already have

**Open a folder…** on the Home screen takes any directory. There is no
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

- `.hearth/chats/` is your transcript history. Keep it if you want the record;
  delete it if you'd rather not publish your conversations.
- `.hearth/evidence/` grows with every playtest, mostly PNGs. It is safe to
  delete at any time — the next sweep starts a new numbered directory and the
  app simply shows an empty rail until then.
