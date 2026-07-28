# Admin access and reports

**Status:** design, approved in conversation 2026-07-27
**Builds on:** `2026-07-27-private-tester-design.md`

## The governing constraint

Hearth must support any and all games people want to make with agents. It must
never lock the agent into a mold, a direction, or an assumption. The bar: using
Hearth should be no different from running a coding agent in a terminal and
making a game from nothing. Hearth only helps and provides tools.

Everything below is subordinate to that. If a decision here would make one kind
of game easier to build and another harder, the decision is wrong.

The rule that makes it work: **Hearth never defines the shape of the game's
world.** The game declares its own states, entities and affordances, by name,
and Hearth consumes them without knowing what they mean. Inverting that is what
generalises a capability to 3D, RTS, MOBA, RPG and management sims for free.

`NavGrid` (`{originX, originY, cellSize, cols, rows, solid[]}`) and
`ProbeEntity` (`{id, x, y, alive}`, no `z`) are the existing violations, and are
exactly why the bot fleet only ever worked for 2D action games. Do not add a
third.

## Problem 1: the tester replays your tutorial forever

A tester that can only start from the beginning spends every session on level
one. If your game has twenty levels and you changed level seventeen, it will
never get there, because it is a poor player by design.

Today the contract has `scenes` (read the current scene id) and `reset` (back to
the start). Both are read-or-restart. There is no way to put the game anywhere.

### The capability

Two calls, both optional:

```ts
/** The situations this game can be put into. Names are the game's own. */
listStates?(): Promise<ProbeState[]>;
/** Put the game into one of them. */
enterState?(id: string): Promise<void>;

interface ProbeState {
  id: string;
  /** Human-readable, for the report and the UI. */
  label: string;
  /** Optional free-form detail the game wants a reader to have. */
  detail?: string;
}
```

Hearth never learns what a state means. It asks "where can you put yourself?"
and picks one. What a state is stays entirely the game's business:

- platformer or 3D: a level, a checkpoint
- RPG: a chapter, a town, a party level, a quest flag
- RTS: a scenario, a point on the clock, an economy
- MOBA: a lane, an item build, a game time
- management sim: a year, a budget, a staffing level

Same call every time. The generalisation is free because the game does the work.

### Why the cooperation problem does not bite here

The deep playtest tier died because arbitrary games had to opt in and did not.
Hearth's agent WRITES the game, so the house instructions can ask it to declare
states as it builds. That is help, not a mold, and it stays help only while a
game that declares nothing still works completely. Declaring nothing must remain
a first-class outcome, reported as unavailable, never as a failure.

### Optional, and honest about it

`listStates` absent means the tester plays from the start and the report says
so. It must never be inferred, guessed, or emulated by, for example, mashing at
a menu and hoping. A capability Hearth does not have is a sentence in the
report, not a silent degradation.

## Problem 2: teleporting invalidates the finding, silently

If the tester is placed into level seventeen and reports "level seventeen plays
fine", that says nothing about whether a player can REACH level seventeen.
Level sixteen's exit could be broken and the report would still be glowing.

This is the same class of error as counting a skipped detector as a pass, and it
is worse, because it reads as a positive result.

### The rule

Provenance is recorded **per observation, not per session**, because a single
session will contain both kinds:

```ts
interface TesterObservation {
  frame: number;
  text: string;
  /**
   * How the tester came to be where this happened.
   * 'played'  it got here by playing, so reachability is evidence.
   * 'placed'  it was put here through enterState, so this says nothing
   *           about whether a player can arrive.
   */
  reached: 'played' | 'placed';
}
```

The report must carry this where a reader sees it, not in a footnote. A finding
about content the tester was placed into is a finding about that content only.

The same applies to any other admin power that alters the terms of play. If
invulnerability or granted resources are ever added, anything observed under
them cannot support a claim about difficulty, and the report must say so.

## Problem 3: the report reaches nobody

Findings currently sit in the project folder and wait to be read. Nothing pushes
them at the agent, so the agent only benefits if it goes looking, which it
usually will not unless prompted. That is the single biggest limiter on whether
any of this changes what gets built.

### The loop, end to end

The person triggers a playtest. The tester plays. The report comes back, and at
the bottom of it is a plan of action: discrete, separately selectable proposals
drawn from what the tester actually saw. The person ticks the ones they want and
approves. Approving opens a NEW conversation, already carrying those items and
the evidence behind them, and the agent starts work.

An earlier draft of this document had the report pushed into the agent's context
automatically as soon as a session ended. That is replaced, because it conflicts
with the step above: an agent that receives every report unprompted can begin
acting on findings the person never approved, which is the exact thing the
selection step exists to prevent. **The report reaches the agent only when the
person sends it there.** Nothing here acts on its own.

The person can also just read it. "View report" opens the full session: what it
did, what it concluded, the frames its claims are anchored to, and which
observations were played versus placed.

What the agent receives is prose, not a JSON blob. It is another reader, not a
parser, and a wall of fields costs context while burying the two sentences that
matter.

### The plan of action, and the four ways it can lie

**It must be allowed to be empty.** A tester that produces a plan of action
every single session will start manufacturing work to fill it, and a list of
things to change is the most flattering possible output because it always looks
like value. "Nothing here is worth changing" is a legitimate and frequently
correct result, and the UI must not treat it as a failed run.

**Bugs and opinions are not the same claim.** A crash the tester witnessed and a
suggestion that the second jump feels unfair carry completely different weight,
and the tester cannot judge fun at all. They are separated in the plan, and the
weaker kind is never dressed up as the stronger. A proposal is allowed to say it
is a preference.

**A proposal from a `placed` observation inherits that caveat.** "Fix the timing
on the boss" derived from a fight the tester was dropped into is a claim about
the boss, not about whether anyone can reach it. The proposal carries its
provenance, and approving one must not silently import a false premise.

**Proposals come from what it saw, not from a catalogue.** No genre playbook, no
stock remedies, nothing that assumes the game has checkpoints or lanes or
levels. If a proposal could have been written without playing this particular
game, it does not belong in the list. This is the governing constraint applied
to prose rather than to types.

### What approval actually does

It opens a new conversation seeded with the selected items and the evidence they
rest on, and nothing else. Not the whole report, because unselected proposals in
the agent's context are proposals it may act on. The frames stay attached, so
the agent can see what the tester saw rather than take its word.

The new conversation is a normal conversation. It is not a special mode, it has
no privileged status, and the person can talk to it, redirect it or abandon it
like any other. Approval starts work; it does not hand over control.

## What this does NOT do

- It does not require any game to declare anything.
- It does not define a level, a scene, a stage, a lane or a chapter.
- It does not assume an avatar, a camera, a dimension, a genre or an input
  device.
- It does not make the tester good at playing. Admin access is how it gets
  somewhere, never a claim that it earned its way there.

## Related work this exposes

`ProbeEntity` should gain an optional `z`. It is small, it is additive, and a
position type that cannot express three dimensions is a mold in the exact sense
this document exists to prevent. Generalising `NavGrid` is the larger job and
stays deferred until a real game needs it, but it should be understood as a debt
rather than a design.
