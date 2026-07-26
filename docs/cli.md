# `hearth-probe` CLI

The probe, for an agent (or a person) with a terminal. It plays a web game
with seeded bots and reports what broke, writing the same `.hearth/evidence`
files the Hearth app renders live.

The loop it exists to close:

```
build → hearth-probe sweep → read the findings → fix → sweep again
```

## Getting it

`hearth-probe` lives in `@hearth/probe-tools` in the Hearth monorepo. Today the
way to get it is a source checkout:

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install && npm run build:packages
node packages/probe-tools/dist/cli.js --help     # or npm link -w @hearth/probe-tools
```

It drives the game in headless Chromium through `playwright-core`, which finds
an installed Chrome or Edge, honours `CHROMIUM_PATH`, or uses a browser from
`npx playwright install chromium`. Without one, every command that opens a game
fails with a message saying exactly that.

Each command takes either a directory (served on an ephemeral loopback port) or
`--url` for something already being served, and prints human lines by default —
or the JSON envelope with `--json`, byte-identical to what the MCP tools return
([mcp.md](./mcp.md)).

## `sweep`

```bash
hearth-probe sweep [dir] [options]
```

Runs `policies × seeds` episodes and folds them into one report. What the
policies do, what gets checked, and what the verdicts mean:
[playtesting.md](./playtesting.md).

| Flag | Default | Notes |
| --- | --- | --- |
| `--url <url>` | — | Sweep an already-served URL instead of a directory. |
| `--policies <names>` | `mash` | Comma-separated: `idle`, `mash`, `seek`, `wander`. |
| `--seeds <n>` | `6` | Episodes per policy. |
| `--seed-start <n>` | `1` | First seed. Repros pin this. |
| `--max-steps <n>` | `600` | Steps per episode. |
| `--step-ms <ms>` | `100` | Wall-clock length of one step. |
| `--headed` | off | Show the browser window. Slower, but you can watch. |
| `--out <root>` | the swept dir | Where `.hearth/evidence` is written. |

A sweep costs roughly `step-ms × max-steps × runs` in wall time. `--max-steps
600` is lower than the library's own default on purpose: a sweep an agent will
actually wait for beats a thorough one it cancels. Raise it for a deep pass.
Note that detector windows are counted in steps, so a shorter step also
shortens the game-time a "stuck" window covers.

Output is written for something with a context window: every finding rendered
in full (never "[3 items]"), every failure with a copy-paste repro, the
`not checked` list so a short findings list is never mistaken for a clean bill
of health, and a pointer to `report.json` for the depth that would be wasteful
inline.

### Repro lines

Every failure prints a command that re-runs exactly that one seeded episode:

```
repro: hearth-probe sweep ~/Hearth/tiny-roguelike --policies mash --seeds 1 --seed-start 4
```

Same grammar as the sweep that produced it — one dial narrowed, not a different
mode.

## `report`

```bash
hearth-probe report [dir] [--out <root>]
```

Prints the most recent sweep's summary straight from `.hearth/evidence`. No
browser, no cost. Use it to re-check findings mid-fix, or to read a sweep
someone else ran — the app, a teammate, the MCP server.

## `capabilities`

```bash
hearth-probe capabilities [dir|--url <url>]
```

Opens the game briefly and reports what it lets the probe see: which senses are
declared, which are missing, whether the shim was detected, the input
vocabulary, the viewport, and one line of advice. Run this first when a sweep
comes back with a long `not checked` list.

## `shim`

```bash
hearth-probe shim [dir]
```

Copies the reference `probe-shim.js` into the game and prints the two-line
integration snippet. It becomes your file — no dependency, no version pin. The
contract it implements is [probe-shim.md](./probe-shim.md).

## `screenshot`

```bash
hearth-probe screenshot [dir] [--out shot.png] [--after-steps 30] [--headed]
```

Opens the game, lets it run, saves one PNG. This is one frame, not evidence —
findings come from `sweep`.

## Exit codes

`0` when the command worked and, for `sweep`/`report`, the sweep passed; `1`
otherwise. A sweep that *ran* fine but found real failures — or flagged a
blocker — also exits `1`, so `hearth-probe sweep && deploy` means what it looks
like it means.
