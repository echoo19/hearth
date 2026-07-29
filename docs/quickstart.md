# Quickstart

Ten minutes from downloading the app to a game you can play, and evidence that
says whether it works. Nothing is scaffolded, nothing is generated for you, and
you don't have to learn a format.

## 1. Get the app

Download it from
[hearthengine.com/download](https://hearthengine.com/download) — macOS,
Windows, or Linux — and open it. On Windows, SmartScreen will ask; **More info
→ Run anyway** ([desktop-app.md](./desktop-app.md)).

## 2. Connect an agent

Hearth doesn't ship an agent, so you bring one. In Settings: paste an Anthropic
API key, or sign in with ChatGPT through the open-source Codex CLI. Or skip
both and run your own CLI in the Terminal tab, which already sits in the
project folder. Send a message with none of them connected and the conversation
answers with those same three options rather than pretending to build anything.

Keys are stored per folder, not globally ([agents.md](./agents.md)).

## 3. Say what you want to play

Type one sentence into the box on the Home screen and send it:

> a small top-down game about sweeping leaves off a courtyard

Hearth asks what to call it, with a name already drafted from what you typed.
Press Enter to accept it or type your own. A folder appears under `~/Hearth`
and the conversation moves into it.

That folder is empty until the agent writes something. There is no project
file, no manifest, no template.

## 4. Watch it build

The agent works in the folder with plain web files, however it likes. The game
pane on the right notices any file changing and reloads the page, so the game
you're looking at is always the newest one. Approvals appear inline when the
agent wants to touch something outside the folder or run something that doesn't
obviously stay inside it.

The game column opens itself the moment there is a game in the folder. Close it
with the **×** in its tab strip when you want the whole window for the
conversation; the play button in the top bar brings it back.

Keep talking to it. "The leaves fall too fast." "Add a wind gust every ten
seconds." Each message is a turn; the pane reloads when the files land. Drop a
screenshot or a reference image onto the composer when a picture says it faster
— an image on its own is a message ([agents.md](./agents.md)).

## 5. Have it played

Press Play on the Tester tab beside your game. A model opens it and plays it
the way a person would: it looks at a picture, decides what to try, and does
that, for as many turns as it takes.

When it stops, it writes up what it made of the game. From the second session
on it also answers the only question you really wanted asked: is this better
than last time, and did anything get worse.

It says what it actually saw and nothing more. Every claim points at a picture
it took, and a claim it cannot point at is dropped and counted rather than
smoothed over. When it could not work something out, it says so instead of
guessing. A tester that overclaims is worse than no tester, because you act on
what it tells you. [tester.md](./tester.md) is the whole story.

## 6. Read the report and pick what to fix

The report opens where you are. Under it is a plan of action: everything the
tester proposed, nothing ticked. Tick what you agree with and start work, and
those items go to your agent in a conversation of their own.

Its notes live in `.hearth/tester/` in your folder, including `memory.md`,
which is what it remembers about your game. That file is yours to correct. A
memory you cannot argue with is one you stop listening to.

There is a second kind of playtest your agent can run on its own: seeded bots
driven headlessly at the game, good for finding crashes rather than for telling
you whether the game is any good. You do not press anything for it and it has
no screen. [playtesting.md](./playtesting.md) covers it.

## Running from source instead

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install && npm run build:packages
npm run dev      # browser mode, http://localhost:5173
npm run app      # the desktop app from your checkout
```

Node 20 or newer. Browser mode is the same UI against the same server, so
everything above works there too.

## Where next

- [projects-and-chats.md](./projects-and-chats.md) — your folders, your files
- [agents.md](./agents.md) — providers, attachments, skills, the model
  selector, approvals
- [tester.md](./tester.md) — what your tester will and will not claim
- [playtesting.md](./playtesting.md) — bot sweeps: policies, verdicts, evidence
- [cli.md](./cli.md) / [mcp.md](./mcp.md) — the probe for agents outside the app
