# Quickstart: your first Hearth game

Ten minutes from clone to a playable, playtested game. Everything below also
works for a coding agent. That's the point.

## 1. Install & build

Node ≥ 20 (macOS, Linux, Windows).

```bash
git clone <repo> hearth && cd hearth
npm install
npm run build:packages
alias hearth="node $PWD/packages/cli/dist/main.js"   # or: npm link -w @hearth/cli
```

## 2. Create a project

```bash
cd ~ && hearth init "Star Catcher"
cd star_catcher
```

You get a `Main` scene with a camera, ground, and a blue player box that
already falls and lands (dynamic physics body + static ground), plus
`AGENTS.md`/`CLAUDE.md` for any agent that visits.

## 3. Make the player move

Scripts are Lua by default (JavaScript works too: `--language js`); the
same `ctx` API in either language, always called with a dot
(`ctx.log("hi")`, never `ctx:log("hi")`).

```bash
hearth create script player-move --source-file /dev/stdin <<'EOF'
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local vx = 0
  if ctx.input.isDown("left") then vx = vx - 220 end
  if ctx.input.isDown("right") then vx = vx + 220 end
  body.velocity.x = vx
  if ctx.input.justPressed("jump") and ctx.isGrounded() then
    body.velocity.y = -420
  end
end

return script
EOF
hearth attach script Main Player scripts/player-move.lua
```

Default input mappings already bind `left/right` to arrows+AD and `jump` to
Space (`hearth inspect project --json` shows them).

## 4. Add something to catch

```bash
hearth create asset sprite star --shape star --color yellow --width 24 --height 24
# the output includes the new asset id (ast_…); use it below
hearth create entity Main Star --position 500,480 --tags star --components \
  '{"SpriteRenderer":{"assetId":"<ast_id>","width":24,"height":24},"Collider":{"shape":"circle","radius":14,"isTrigger":true}}'

hearth create script star-catch --source-file /dev/stdin <<'EOF'
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Player" then return end
  ctx.log("caught a star!")
  ctx.destroySelf()
end

return script
EOF
hearth attach script Main Star scripts/star-catch.lua
```

## 5. Validate, playtest, review

```bash
hearth validate --json
hearth run Main --frames 120 --json     # smoke: zero script errors?

# a real behavioral test:
cat > steps.json <<'EOF'
[
  { "type": "wait", "frames": 30 },
  { "type": "press", "action": "right", "frames": 60 },
  { "type": "assertProperty", "entity": "Player", "property": "Transform.position.x", "greaterThan": 420 },
  { "type": "assertNoErrors" }
]
EOF
hearth create playtest reach-the-star --scene Main --steps-file steps.json
hearth test                              # validate + all playtests
```

## 6. See it

From the hearth repo: `npm run dev`, open http://localhost:5173, open your
project folder in the launcher, press **Play**. The Changes panel (toolbar:
**Review**) shows exactly what you (or an agent) changed since the last
checkpoint (`hearth snapshot`) — see [docs/editor.md](./editor.md) for the
rest of the editor's chrome and shortcuts.

## 7. Hand it to an agent

```bash
claude mcp add star-catcher -- node <hearth repo>/packages/mcp-server/dist/main.js \
  --project ~/star_catcher
```

Ask the agent to *"add three more stars in an arc and a score counter, then
prove it with a playtest."* It has instructions (`AGENTS.md`), tools, tests,
and a diff you'll review. That's Hearth.

## 8. Ship it

```bash
hearth export web --zip --allow build
```

A static playable build lands in `export/web/`, plus an itch.io-ready zip.
See [export.md](./export.md).

## Where next

- [Scripting guide](./scripting.md): the full `ctx` API
- [CLI guide](./cli.md): everything `hearth` can do
- [Prefabs](./prefabs.md): reusable entity templates, `ctx.scene.spawnPrefab`
- [Editor guide](./editor.md): chrome, shortcuts, transform handles
- [Web export](./export.md): folder vs single file, itch.io
- [Examples](../packages/examples): platformer, top-down, visual novel,
  Ember Trail (an all-Lua two-scene game), and Glow Caves (an all-Lua
  lighting/particles/animation showcase)
