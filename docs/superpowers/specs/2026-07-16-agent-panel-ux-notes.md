# Agent panel UX — relocation + zero-friction launch (notes for planning)

Status: **NOTES ONLY — not a design.** Raised by Jake 2026-07-16 after driving
the v1.1.0 editor by hand. A follow-up session should brainstorm this properly
(`superpowers:brainstorming` first — there are real design decisions here) and
produce an actual design doc + plan. Do not implement straight from this file.

Scope split: the contained bugs (PATH detection, empty-state overfill,
permission-blurb length, centering) are being fixed NOW, separately, as
v1.1.1. **This file is only the layout + launch-flow work**, which is a design
question, not a patch.

## The core complaint (Jake, verbatim intent)

> "the agent part feels very cramped. should it be a side editor next to
> inspector on the right column as a new tab? this feels very ux unfriendly"

> "upon first opening shouldn't the agent screen just say 'launch your agent'
> then they choose an option and the editor launches it via claude or codex or
> etc. — commands (just like how my jakeos does it)? idk what's a good flow to
> ensure there's little to zero friction in getting the agent set up and
> starting."

Two distinct problems, related but separable:

### 1. Wrong shape — the panel is in the wrong dock

The Agent panel is a terminal + an activity timeline + a toolbar + a
permission blurb, crammed into a **horizontal bottom dock**. A terminal wants
HEIGHT; the bottom dock gives it WIDTH. The timeline and the terminal fight
for horizontal space, and every empty state inside was written for a
full-width panel but renders into a ~400px column.

Proposal to evaluate: move it to the **right column beside the Inspector, as
a tab**. That yields a tall narrow shape — the shape Cursor, Zed, and Copilot
Chat all converged on, which is corroborating evidence rather than proof.

Open questions for the brainstorm:
- Right column beside Inspector, or its own full-height right dock? The
  Inspector is heavily used *while* an agent works; a tab hides one to see
  the other. Is that a real cost or imagined?
- What happens to the activity timeline in a narrow column? Does it stay
  beside the terminal, stack below it, or move out to the Changes panel
  (where Review/Checkpoint arguably already belong)?
- Saved dockview layouts from v1.1 and earlier must self-heal (Wave L already
  built layout self-healing — reuse it, don't reinvent).
- Does the bottom dock keep a plain terminal, or does Agent leave entirely?

### 2. Wrong flow — setup friction before first value

Today the first-open Agent panel shows: an agent dropdown, a permission-mode
dropdown, an Install/Re-detect button, a Stop button, an Idle indicator, a
paragraph of permission text, an empty terminal, an empty timeline, and a
"Manual setup" disclosure. That is a configuration screen, not an invitation.

Jake's proposal: first open should just say **"Launch your agent"**, offer the
choices, and the editor launches it. Everything else (permission mode, manual
setup, re-detect) is progressive disclosure — reachable, not upfront.

Reference: Jake's "jakeos" does this via commands; ask him for a walkthrough
before designing, since the whole point is to match a flow he already likes.

Open questions:
- What is the true minimum first-run surface? Probably: a row of agents
  (Claude Code / Codex / OpenCode / Hermes) + one Launch. Permission mode
  defaults to Safe edit and moves into a settings affordance.
- If an agent isn't installed, what shows? Today it wrongly says "Install
  Claude Code" even when installed (the PATH bug, fixed separately). Once
  detection is honest, an uninstalled agent should offer install *inline*
  without becoming the default state.
- Does launching need a project-prepare step surfaced at all, or should it be
  invisible (it already merge-writes `.mcp.json` automatically)?
- Zero-friction target to design against: **open editor → click Launch →
  typing to an agent that already knows the project.** Count the clicks in
  any proposal against that.

## Binding constraints (do not design around these)

- **Subscription safety is non-negotiable** and shapes the whole feature: the
  panel embeds the user's own genuine CLI in a real PTY (`@lydell/node-pty` +
  xterm), and Hearth never touches its stream, credentials, or flags beyond
  `cwd` and standard MCP config. See `docs/agent-panel.md`'s position section.
  A custom chat UI is NOT an option here (API-key/Agent-SDK only, terms) —
  that is already a documented post-1.0 parallel-track item.
- House rules: no raw-JSON surfaces; shared Tooltip/Menu/Button primitives and
  `--text-*` tokens; single-theme dark; the "Reveal idiom" block in
  primitives.css governs hover/focus reveals; keyboard accessibility is not
  optional.
- Launcher parity already exists across Claude Code / Codex / OpenCode+Ollama
  / Hermes, each with a native MCP config writer and already-configured
  detection (v0.15 Wave L2). **Reuse it.** The flow is the problem, not the
  plumbing.
- Anti-bloat is binding. This is a UX rework of an existing feature, not a
  new feature; it must not grow the surface.

## Why this was missed (worth knowing before re-auditing)

None of this is exotic — it's what anyone sees in the first 30 seconds of
using the panel. It survived a 16-surface live audit (121-entry ledger, 100
fixed) and a full tightening wave because **the audits drove the editor
programmatically, not by hand**. Same root cause as the trackpad-pan gap and
the PATH bug: automated checks confirm a thing renders, not that it feels
usable or that it works outside a dev shell. Whoever plans this should drive
the panel manually on a real machine, from a packaged app (not `npm run dev`
— that difference IS the PATH bug).

## Related, already logged elsewhere

- Scene view has no trackpad pan: two-finger scroll zooms instead of panning
  (`SceneView.tsx` wheel handler ignores `deltaX`/`ctrlKey`). Same family of
  "nobody drove it by hand" gap. Fix independently.
- `findPath` nav-cache staleness (see the v1.1 run notes) — unrelated, also
  pending.
