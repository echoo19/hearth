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

A folder appears under `~/Hearth`, named from your words —
`~/Hearth/small-top-down-sweeping` — and the conversation moves into it. That
folder is empty until the agent writes something. There is no project file, no
manifest, no template.

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

## 5. Press Playtest

The button under the game pane sends bots in. They press real keys, move a real
mouse, take screenshots and collect errors — with no cooperation from the game
at all, because the probe treats it as a page rather than a project.

Verdicts stream into the Playtests rail as each episode finishes:

```
6 runs: error 1, ran-clean 5 — 1 failing
  [blocker] crash: game threw: Cannot read properties of null (leaf.js:31)
```

## 6. Read the evidence

Every run leaves files under `.hearth/evidence/` in the folder: a report per
sweep, one file per episode, and the screenshots the findings point at. Open
the rail, or hand the report back to the agent — "the playtest found a crash in
leaf.js, fix it and run it again" — and the loop closes.

Read the `not checked` list next to the findings. A sweep of a game that says
nothing about itself can only check for crashes and blank screens; that isn't a
failure, it's the honest floor. When you want more,
[probe-shim.md](./probe-shim.md) is the twenty lines a game adds to let the
bots see where things are. [playtesting.md](./playtesting.md) is the whole
story.

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
- [playtesting.md](./playtesting.md) — policies, verdicts, evidence
- [cli.md](./cli.md) / [mcp.md](./mcp.md) — the probe for agents outside the app
