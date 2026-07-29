# Bot sweeps

A sweep is the headless half of playtesting. Seeded bots drive your game many
times over, watchers look for the failures a person would notice, and
everything they saw lands on disk as files you and your agent can read.

There is nothing to press. A sweep is a tool your agent reaches for, run with
`hearth-probe sweep .` ([cli.md](./cli.md)), and its evidence is plain files
you can open yourself. Nothing about it needs a person or a model, which is
what makes it the playtest an agent can run as often as it likes.

The half a person presses is the private tester: a model that plays the game
the way a player would, remembers every session, and tells you whether your
last change helped ([tester.md](./tester.md)). The two answer different
questions and neither stands in for the other. Bots give you evidence at volume
and no opinions. The tester gives you one opinion with the pictures behind it.

The part that matters: this works **no matter what the agent built**. The
probe opens the game like a browser would, presses real keys, moves a real
mouse, captures frames, and collects errors. That tier needs nothing from the
game — no engine, no format, no cooperation. When the game chooses to say more
about itself ([probe-shim.md](./probe-shim.md)), the same sweep sees more and
checks more.

## What a sweep is

A sweep runs `policies × seeds` episodes against one live game, sequentially,
and folds them into a single report. The bot's RNG is seeded, so one
`(policy, seed)` pair is a re-runnable experiment. **The game is not assumed
to be deterministic** — the same policy and seed can trace differently twice —
so read the tally as a distribution. One clean run proves nothing.

### Policies

| Policy | What it does | What it needs |
| --- | --- | --- |
| `mash` | Random weighted-persistence input on every declared action, axis and pointer. The default. | At least one declared action, axis, or pointer. |
| `idle` | No input at all. Catches games that break when the player does nothing. | Nothing. |
| `wander` | Steers toward unvisited walkable cells. Coverage. | Entities **and** a nav grid. |
| `seek` | Heads for a target (the entity tagged `objective` unless you name one). Verification. | Entities. A nav grid upgrades it. |

A policy the game can't support does not run and does not quietly pass: it is
recorded in `skipped` with a reason naming the missing sense, and the report's
`policyStatus` carries one row per requested policy: `ran` or `skipped`, the
reason when skipped, and the mode when it ran.

`seek` is the one policy that degrades instead of skipping. With a nav grid it
paths to its target; without one it runs in `direct` mode, walking the straight
line and mashing when it stops getting closer. That mode is recorded on every
run and in `policyStatus`, because a `direct` seek that never arrives means the
bot could not get there, not that the target is unreachable.

### Seeds

`--seeds N` runs seeds `seedStart … seedStart + N - 1` (default: 6 seeds from
1). Extend a prior sweep with `--seed-start` instead of re-running seeds you
already cleared.

## What is watched

Five per-step detectors plus one probe that runs once, before the first
episode:

| Check | Fires when | Needs |
| --- | --- | --- |
| `crash` | the game throws or logs an uncaught error | error stream |
| `stuck` | nothing new happens for 180 steps (a novelty drought) | any one of entities, screenshots, scenes, events — and a policy that presses something (`idle` is exempt) |
| `black-screen` | the frame stays dark and flat for 60 steps | screenshots |
| `wall-bump` | the avatar pushes in one direction and goes nowhere | entities |
| `sealed-region` | a fifth or more of the walkable area is cut off from spawn | nav grid **and** entities |
| `unresponsive-input` | holding a control does nothing a no-input window doesn't already do | at least one declared action or axis, plus entities or screenshots to measure with |

Findings carry a severity — `blocker`, `issue`, or `note` — a frame, and often
a screenshot path.

## Verdicts

Every run gets exactly one verdict. Worst to best, and that order is the
precedence when several apply:

`error` → `stuck` → `objective-failed` → `completed` → `ran-clean`

`ran-clean` is the best a sweep with no declared objectives can report: the cap
was reached, nothing threw, nothing stalled. A sweep **passes** only when no
run failed *and* nothing was flagged as a blocker — a blocker finding on
otherwise clean runs still means don't ship.

## Skipped is not passed

This is the rule the whole design rests on. Capabilities are declared by the
game, never guessed at, and a check that needs a sense the game doesn't declare
is skipped with an explicit reason:

```
  not checked (3):
    - sealed-region: needs nav grid + entity enumeration, which this game does not declare
    - wall-bump: needs entity enumeration, which this game does not declare
    - stuck: no sense that can show progress (needs entities, screenshots, scenes, or events)
```

"No findings" never means "nothing was wrong" on its own. Read the `skipped`
list next to it, and if it's long, that's the argument for the shim.

## Evidence

Everything a sweep learns is written under the project, in plain files:

```
.hearth/evidence/
  journal.jsonl                          append-only event stream (the live feed)
  sweeps/0001/report.json                the folded report
  sweeps/0001/runs/<policy>-<seed>.json  one file per episode
  sweeps/0001/shots/*.png                frames the findings point at
```

Sweep ids are zero-padded sequence numbers (`0001`), not timestamps, so a path
stays stable and can be pasted into a conversation. The journal is appended as
the sweep runs, so anything following along has something to read before it
finishes; the same files are there afterwards.

The report is deliberately small: findings are deduped and capped at 8 total
and 3 per kind, failures at 5, worst-first. Per-episode depth lives in
`runs/*.json` — reach for it for diagnosis, not by default.

## Reading a report back

The CLI and the MCP server print the same folded summary from the same files
([cli.md](./cli.md), [mcp.md](./mcp.md)), so your agent reads a sweep the same
way you would:

```
✗ sweep 0003 — ~/Hearth/tiny-roguelike
  6 runs: error 1, ran-clean 5 — 1 failing
  policies: mash · seeds: 1-6
  findings (1):
    - [blocker] crash: game threw: Cannot read properties of null (reading 'x') (player.js:31)
        frame 218 · shot sweeps/0003/shots/mash-4-00210.png
  failures (1):
    - mash/4 error at frame 218 — Cannot read properties of null
        repro: hearth-probe sweep ~/Hearth/tiny-roguelike --policies mash --seeds 1 --seed-start 4
  evidence: ~/Hearth/tiny-roguelike/.hearth/evidence/sweeps/0003
  full detail: ~/Hearth/tiny-roguelike/.hearth/evidence/sweeps/0003/report.json
```

Every failure carries its own repro line, so the next step is never a guess.

## What sweeps don't do

Bots produce evidence, not judgment. A sweep can say the game crashed, stalled,
went black, or ignored a control. It cannot say whether the game is fun,
whether the difficulty is right, or whether a mechanic is satisfying. Use a
sweep to clear the floor.

The tester gets nearer to the ceiling and stops well short of it. It can tell
you what it tried, what it could not work out, and whether this session felt
better than the last one, and it is required to say plainly that it cannot
judge fun ([tester.md](./tester.md)). The last read is still yours.
