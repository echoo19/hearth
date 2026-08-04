# Quickstart

Ten minutes from downloading the app to a game you can play, and evidence that
says whether it works. Nothing is scaffolded, nothing is generated for you, and
you don't have to learn a format.

## 1. Get the app

Download it from
[hearthengine.com/download](https://hearthengine.com/download) for macOS,
Windows, or Linux, and open it. On Windows, SmartScreen will ask; **More info
→ Run anyway** ([desktop-app.md](./desktop-app.md)).

## 2. Connect an agent

Hearth doesn't ship an agent, so you bring one, usually the one you already
pay for. If you are signed into the Claude Code CLI on this machine, you are
already connected: Hearth runs the Claude you are signed into, and an API key
is optional. For ChatGPT, sign in once through the open-source Codex CLI, from
Settings. Or run any other agent CLI yourself in a terminal conversation,
which already sits in the project folder. A message sent with nothing
connected comes back naming what is missing rather than pretending to build
anything.

An API key, if you use one, is stored per folder, not globally
([agents.md](./agents.md)).

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
screenshot or a reference image onto the composer when a picture says it
faster. An image on its own is a message ([agents.md](./agents.md)).

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

## 7. Put it somewhere people can play it

Your game is a folder of static web files, which is exactly what a web host
wants. [The Hearth Catalog](https://catalog.hearthengine.com) is one: free
hosting, no account needed to play, and every game runs on an origin of its
own so it is walled off from the rest of the site.

Hearth does not publish for you — there is no button in the app for this yet.
There are three ways in, and the last one is the one to hand your agent:

- The uploader at
  [catalog.hearthengine.com/dashboard/new](https://catalog.hearthengine.com/dashboard/new)
  takes a folder or a zip.
- The HTTP API under `/api/v1`, with a token from `/dashboard/tokens`.
- A dependency-free script. From your project folder:

```bash
curl -fsSL https://catalog.hearthengine.com/publish.mjs -o publish.mjs
node publish.mjs --token hpub_… --title "My Game" --tags "action,arcade"
```

Ask your agent to do that last one and it will: it has a terminal, it is
already sitting in the folder, and the publish docs at
[catalog.hearthengine.com/docs/publish](https://catalog.hearthengine.com/docs/publish)
are written for an agent to follow unassisted.

Anything that runs in a browser is welcome there, whether Hearth made it or
not.

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

- [projects-and-chats.md](./projects-and-chats.md): your folders, your files
- [agents.md](./agents.md): providers, attachments, skills, the model
  selector, approvals
- [tester.md](./tester.md): what your tester will and will not claim
- [playtesting.md](./playtesting.md): bot sweeps, verdicts, evidence
- [cli.md](./cli.md) / [mcp.md](./mcp.md): the probe for agents outside the app
