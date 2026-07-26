# Connecting an engine

Hearth playtests **web games** today. If the folder holds something a browser
can open, the probe can play it — no engine, no format, no cooperation
required. That is the only connector that is wired up right now, and this page
is the honest account of what it would take to add another.

## What a connector is

The probe is deliberately engine-blind. It drives one interface,
`GameUnderTest`, and everything downstream — policies, detectors, verdicts,
evidence — is written against that and nothing else. A connector is an
implementation of it for something that isn't a web page.

The contract, in full:

```ts
interface GameUnderTest {
  readonly capabilities: ProbeCapabilities;

  start(): Promise<void>;          // ready to accept input
  stop(): Promise<void>;
  step(): Promise<StepObservation>; // advance/sample one unit of game time

  setActionDown(name): Promise<void>;
  setActionUp(name): Promise<void>;
  setAxis(name, value): Promise<void>;
  sendPointer(x, y, kind): Promise<void>;

  listEntities?(): Promise<ProbeEntity[]>;   // if senses.entities
  findEntity?(ref): Promise<ProbeEntity>;    // if senses.entities
  screenshot?(): Promise<Uint8Array>;        // if senses.screenshot
  navGrid?(): Promise<NavGrid | null>;       // if senses.nav
  reset?(): Promise<void>;                   // if senses.reset
}
```

Four things it must get right:

1. **Declare capabilities honestly.** `capabilities.senses` says what this
   implementation can see; the optional methods must be present exactly when
   the matching sense is true. A sense you claim but can't deliver turns a
   skipped check into a false pass, which is the one failure mode the whole
   design exists to prevent.
2. **Keep `step()` roughly uniform.** It can be a fixed tick when the
   implementation controls time, or a sample window when it doesn't. Detector
   windows are counted in steps, so the unit has to stay stable within a run.
3. **Report in its own world units.** Positions are numbers in whatever space
   the game thinks in. Nothing downstream assumes pixels, an origin corner, a Y
   direction, or 2D.
4. **Don't promise determinism.** The bot is seeded and replays exactly; the
   game is treated as a distribution. A connector that can't reproduce a run
   bit-for-bit is still a perfectly good connector.

The web adapter is the worked example: zero-cooperation input, screenshots and
errors out of the box, upgraded when the page exposes the optional shim
([probe-shim.md](./probe-shim.md), [architecture.md](./architecture.md)).

## Status

The app's harness registry lists what Hearth can currently reach, with a status
per entry:

| Connector | Status |
| --- | --- |
| Web games | **active** — playtested by the built-in probe today |
| Godot | **coming soon** — named, not built |

"Coming soon" here means exactly that: it is a named intention with no
implementation, no branch, and no date. When it is real, it will be a
`GameUnderTest` implementation like the web adapter, and everything on
[playtesting.md](./playtesting.md) will apply to it unchanged — the same
policies, the same verdicts, the same evidence files.

If you want to connect something yourself, the contract above is the whole
requirement. There is nothing else to register and no plugin API to learn.
