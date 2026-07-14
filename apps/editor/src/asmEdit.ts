/**
 * Pure draft-document reducers for the Animator editor (AnimatorEditor.tsx).
 *
 * The on-disk state-machine document (`StateMachineData`) stores params as a
 * Record and everything else as arrays. That shape is awkward to edit
 * directly — renaming a param key, reordering rows, or tracking an in-progress
 * row is all easier against ordered arrays. So the editor works on an
 * `AsmDraft` (params flattened to an ordered `{name,...}[]` array), and only
 * converts back to the strict document at save time (`draftToDoc`).
 *
 * Everything here is side-effect free and DOM-free so the edit logic is unit
 * testable in node — same split as tileAssetsList.ts / vec2List.ts.
 */
import type {
  StateMachineData,
  StateMachineParam,
  StateMachineTransition,
} from '@hearth/core';

export type ParamType = StateMachineParam['type'];
export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface DraftParam {
  name: string;
  type: ParamType;
  /** Absent for trigger params (and optional for bool/number). */
  default?: boolean | number;
}

export interface DraftState {
  name: string;
  /** Animation asset id. Empty until the user picks one. */
  animation: string;
  speed: number;
}

export interface DraftCondition {
  param: string;
  op?: ConditionOp;
  value?: boolean | number;
}

export interface DraftTransition {
  /** A state name, or the literal 'any'. */
  from: string;
  to: string;
  conditions: DraftCondition[];
  exitTime?: number;
}

export interface AsmDraft {
  params: DraftParam[];
  states: DraftState[];
  initial: string;
  transitions: DraftTransition[];
}

export const ANY_STATE = 'any';

const NUMBER_OPS: ConditionOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const BOOL_OPS: ConditionOp[] = ['eq', 'neq'];

/** The operators a condition on a param of this type may use. Trigger = none. */
export function opsForParamType(type: ParamType): ConditionOp[] {
  if (type === 'number') return [...NUMBER_OPS];
  if (type === 'bool') return [...BOOL_OPS];
  return [];
}

// ---------------------------------------------------------------------------
// doc <-> draft
// ---------------------------------------------------------------------------

export function docToDraft(data: StateMachineData): AsmDraft {
  return {
    params: Object.entries(data.params).map(([name, p]) => ({
      name,
      type: p.type,
      ...(p.default !== undefined ? { default: p.default } : {}),
    })),
    states: data.states.map((s) => ({ name: s.name, animation: s.animation, speed: s.speed })),
    initial: data.initial,
    transitions: data.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      conditions: t.conditions.map((c) => ({ ...c })),
      ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
    })),
  };
}

/**
 * Convert a draft back to the strict document shape used by
 * `updateStateMachineAsset`. Trigger conditions are serialized as `{param}`
 * only (op/value stripped) to satisfy the schema; absent param defaults are
 * omitted rather than written as `undefined`.
 */
export function draftToDoc(draft: AsmDraft): StateMachineData {
  const params: Record<string, StateMachineParam> = {};
  for (const p of draft.params) {
    params[p.name] =
      p.type === 'trigger' || p.default === undefined
        ? { type: p.type }
        : { type: p.type, default: p.default };
  }
  const typeOf = new Map<string, ParamType>(draft.params.map((p) => [p.name, p.type]));
  const transitions: StateMachineTransition[] = draft.transitions.map((t) => ({
    from: t.from,
    to: t.to,
    conditions: t.conditions.map((c) =>
      typeOf.get(c.param) === 'trigger'
        ? { param: c.param }
        : { param: c.param, ...(c.op !== undefined ? { op: c.op } : {}), ...(c.value !== undefined ? { value: c.value } : {}) },
    ),
    ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
  }));
  return {
    params,
    states: draft.states.map((s) => ({ name: s.name, animation: s.animation, speed: s.speed })),
    initial: draft.initial,
    transitions,
  };
}

/** The single `updateStateMachineAsset` payload a Save commits (one undo entry). */
export function savePayload(assetId: string, draft: AsmDraft): { assetId: string; data: StateMachineData } {
  return { assetId, data: draftToDoc(draft) };
}

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addParam(draft: AsmDraft): AsmDraft {
  const name = uniqueName('param', new Set(draft.params.map((p) => p.name)));
  return { ...draft, params: [...draft.params, { name, type: 'bool', default: false }] };
}

/** Remove param at `index` and drop every condition that referenced it. */
export function removeParam(draft: AsmDraft, index: number): AsmDraft {
  const removed = draft.params[index];
  if (!removed) return draft;
  return {
    ...draft,
    params: draft.params.filter((_, i) => i !== index),
    transitions: draft.transitions.map((t) => ({
      ...t,
      conditions: t.conditions.filter((c) => c.param !== removed.name),
    })),
  };
}

/** Rename param at `index`, rewriting every dependent condition to the new name. */
export function renameParam(draft: AsmDraft, index: number, name: string): AsmDraft {
  const old = draft.params[index];
  if (!old) return draft;
  return {
    ...draft,
    params: draft.params.map((p, i) => (i === index ? { ...p, name } : p)),
    transitions: draft.transitions.map((t) => ({
      ...t,
      conditions: t.conditions.map((c) => (c.param === old.name ? { ...c, param: name } : c)),
    })),
  };
}

/**
 * Change a param's type, resetting its default to a sensible value for the new
 * type AND migrating every dependent condition's op/value to that type (the
 * same reseed `setConditionParam` applies when a condition is repointed). Left
 * un-migrated, a stale `{op:'gt', value:5}` on a param retyped to bool renders
 * misleadingly and makes Save fail against the server schema (bool params only
 * support eq/neq) — so we reseed here, and `draftIssues()` is the safety net.
 */
export function setParamType(draft: AsmDraft, index: number, type: ParamType): AsmDraft {
  const target = draft.params[index];
  if (!target) return draft;
  const params = draft.params.map((p, i) => {
    if (i !== index) return p;
    if (type === 'trigger') return { name: p.name, type };
    if (type === 'bool') return { name: p.name, type, default: typeof p.default === 'boolean' ? p.default : false };
    return { name: p.name, type, default: typeof p.default === 'number' ? p.default : 0 };
  });
  const transitions = draft.transitions.map((t) => ({
    ...t,
    conditions: t.conditions.map((c) => (c.param === target.name ? seedCondition(target.name, type) : c)),
  }));
  return { ...draft, params, transitions };
}

export function setParamDefault(draft: AsmDraft, index: number, value: boolean | number): AsmDraft {
  return { ...draft, params: draft.params.map((p, i) => (i === index ? { ...p, default: value } : p)) };
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

export function addState(draft: AsmDraft): AsmDraft {
  const name = uniqueName('state', new Set(draft.states.map((s) => s.name)));
  const states = [...draft.states, { name, animation: '', speed: 1 }];
  // First state becomes the initial state automatically.
  const initial = draft.states.length === 0 ? name : draft.initial;
  return { ...draft, states, initial };
}

/**
 * Remove state at `index`, dropping any transition that referenced it (as
 * `from` or `to`). Deleting the initial state clears `initial` so the UI
 * forces the user to pick a new one (completeness gating flags it meanwhile).
 */
export function removeState(draft: AsmDraft, index: number): AsmDraft {
  const removed = draft.states[index];
  if (!removed) return draft;
  return {
    ...draft,
    states: draft.states.filter((_, i) => i !== index),
    initial: draft.initial === removed.name ? '' : draft.initial,
    transitions: draft.transitions.filter((t) => t.from !== removed.name && t.to !== removed.name),
  };
}

export function renameState(draft: AsmDraft, index: number, name: string): AsmDraft {
  const old = draft.states[index];
  if (!old) return draft;
  return {
    ...draft,
    states: draft.states.map((s, i) => (i === index ? { ...s, name } : s)),
    initial: draft.initial === old.name ? name : draft.initial,
    transitions: draft.transitions.map((t) => ({
      ...t,
      from: t.from === old.name ? name : t.from,
      to: t.to === old.name ? name : t.to,
    })),
  };
}

export function setStateAnimation(draft: AsmDraft, index: number, animation: string): AsmDraft {
  return { ...draft, states: draft.states.map((s, i) => (i === index ? { ...s, animation } : s)) };
}

export function setStateSpeed(draft: AsmDraft, index: number, speed: number): AsmDraft {
  return { ...draft, states: draft.states.map((s, i) => (i === index ? { ...s, speed } : s)) };
}

export function setInitialState(draft: AsmDraft, name: string): AsmDraft {
  return { ...draft, initial: name };
}

// ---------------------------------------------------------------------------
// transitions & conditions
// ---------------------------------------------------------------------------

export function addTransition(draft: AsmDraft): AsmDraft {
  const first = draft.states[0]?.name ?? '';
  return {
    ...draft,
    transitions: [...draft.transitions, { from: first, to: first, conditions: [] }],
  };
}

export function removeTransition(draft: AsmDraft, index: number): AsmDraft {
  return { ...draft, transitions: draft.transitions.filter((_, i) => i !== index) };
}

function mapTransition(
  draft: AsmDraft,
  index: number,
  fn: (t: DraftTransition) => DraftTransition,
): AsmDraft {
  return { ...draft, transitions: draft.transitions.map((t, i) => (i === index ? fn(t) : t)) };
}

export function setTransitionFrom(draft: AsmDraft, index: number, from: string): AsmDraft {
  return mapTransition(draft, index, (t) => ({ ...t, from }));
}

export function setTransitionTo(draft: AsmDraft, index: number, to: string): AsmDraft {
  return mapTransition(draft, index, (t) => ({ ...t, to }));
}

export function setTransitionExitTime(draft: AsmDraft, index: number, exitTime: number | undefined): AsmDraft {
  return mapTransition(draft, index, (t) => {
    if (exitTime === undefined) {
      const { exitTime: _drop, ...rest } = t;
      return { ...rest, conditions: t.conditions };
    }
    return { ...t, exitTime };
  });
}

/** A fresh condition seeded from a param's type (or a bare `{param:''}` when there are no params). */
function seedCondition(param: string, type: ParamType | undefined): DraftCondition {
  if (type === undefined) return { param };
  if (type === 'trigger') return { param };
  if (type === 'bool') return { param, op: 'eq', value: true };
  return { param, op: 'eq', value: 0 };
}

export function addCondition(draft: AsmDraft, index: number): AsmDraft {
  const first = draft.params[0];
  const cond = seedCondition(first?.name ?? '', first?.type);
  return mapTransition(draft, index, (t) => ({ ...t, conditions: [...t.conditions, cond] }));
}

export function removeCondition(draft: AsmDraft, tIndex: number, cIndex: number): AsmDraft {
  return mapTransition(draft, tIndex, (t) => ({
    ...t,
    conditions: t.conditions.filter((_, i) => i !== cIndex),
  }));
}

/** Point a condition at a different param, reseeding op/value for that param's type. */
export function setConditionParam(draft: AsmDraft, tIndex: number, cIndex: number, param: string): AsmDraft {
  const type = draft.params.find((p) => p.name === param)?.type;
  return mapTransition(draft, tIndex, (t) => ({
    ...t,
    conditions: t.conditions.map((c, i) => (i === cIndex ? seedCondition(param, type) : c)),
  }));
}

export function setConditionOp(draft: AsmDraft, tIndex: number, cIndex: number, op: ConditionOp): AsmDraft {
  return mapTransition(draft, tIndex, (t) => ({
    ...t,
    conditions: t.conditions.map((c, i) => (i === cIndex ? { ...c, op } : c)),
  }));
}

export function setConditionValue(draft: AsmDraft, tIndex: number, cIndex: number, value: boolean | number): AsmDraft {
  return mapTransition(draft, tIndex, (t) => ({
    ...t,
    conditions: t.conditions.map((c, i) => (i === cIndex ? { ...c, value } : c)),
  }));
}

// ---------------------------------------------------------------------------
// completeness gating
// ---------------------------------------------------------------------------

/**
 * Human-readable structural problems that would make `updateStateMachineAsset`
 * reject the draft. Mirrors the core schema's superRefine closely enough to
 * gate the Save button with a visible reason rather than letting the command
 * fail as the only feedback. An empty array means the draft is safe to save.
 */
export function draftIssues(draft: AsmDraft): string[] {
  const issues: string[] = [];

  // params
  const paramNames = new Set<string>();
  for (const p of draft.params) {
    if (!p.name.trim()) issues.push('A parameter is missing a name.');
    else if (paramNames.has(p.name)) issues.push(`Duplicate parameter name "${p.name}".`);
    paramNames.add(p.name);
  }

  // states
  if (draft.states.length === 0) {
    issues.push('Add at least one state.');
  }
  const stateNames = new Set<string>();
  for (const s of draft.states) {
    if (!s.name.trim()) issues.push('A state is missing a name.');
    else if (stateNames.has(s.name)) issues.push(`Duplicate state name "${s.name}".`);
    stateNames.add(s.name);
    if (!s.animation) issues.push(`State "${s.name || '(unnamed)'}" needs an animation.`);
    if (!(s.speed > 0)) issues.push(`State "${s.name || '(unnamed)'}" needs a positive speed.`);
  }

  // initial
  if (!draft.initial) issues.push('Choose an initial state.');
  else if (!stateNames.has(draft.initial)) issues.push(`Initial state "${draft.initial}" is not one of the states.`);

  // transitions
  draft.transitions.forEach((t, i) => {
    const label = `Transition ${i + 1} (${t.from || '?'} → ${t.to || '?'})`;
    if (t.from !== ANY_STATE && !stateNames.has(t.from)) issues.push(`${label}: "from" is not a state.`);
    if (!stateNames.has(t.to)) issues.push(`${label}: "to" is not a state.`);

    const hasGate = t.conditions.length > 0 || t.exitTime !== undefined;
    if (!hasGate) issues.push(`${label} needs at least one condition or an exit time.`);
    if (t.from === ANY_STATE && t.conditions.length === 0) {
      issues.push(`${label}: an "Any" transition needs at least one condition.`);
    }

    t.conditions.forEach((c, ci) => {
      const clabel = `${label} condition ${ci + 1}`;
      if (!c.param) {
        issues.push(`${clabel} needs a parameter.`);
        return;
      }
      const type = draft.params.find((p) => p.name === c.param)?.type;
      if (type === undefined) {
        issues.push(`${clabel} references unknown parameter "${c.param}".`);
        return;
      }
      if (type === 'trigger') return; // {param} only
      if (c.op === undefined) issues.push(`${clabel} needs an operator.`);
      // Mirror the server schema's op-vs-type rule (project.ts superRefine) so an
      // invalid combo — e.g. a leftover ordering op on a param retyped to bool —
      // is named here rather than surfacing as a raw schema string after Save.
      else if (type === 'bool' && c.op !== 'eq' && c.op !== 'neq') {
        issues.push(`${clabel}: a bool parameter only supports = or ≠.`);
      }
      if (c.value === undefined) issues.push(`${clabel} needs a value.`);
    });
  });

  return issues;
}

export function isDraftComplete(draft: AsmDraft): boolean {
  return draftIssues(draft).length === 0;
}

/**
 * Turn a raw `updateStateMachineAsset` rejection into a human, field-located
 * message. The command surfaces zod paths verbatim, e.g.
 *   `Invalid parameters for updateStateMachineAsset: data.transitions.2.conditions.0.op: bool param "spd" conditions only support eq/neq`
 * which an end user can't map back to "the 3rd transition's 1st condition".
 * We strip the command prefix and translate the `data.<path>` locator into a
 * plain-language location (1-based, matching the on-screen ordering). Anything
 * we don't recognize passes through minus the noise, so we never dump raw zod.
 */
export function humanizeSaveError(message: string): string {
  const withoutPrefix = message.replace(/^Invalid parameters for \w+:\s*/, '');
  const match = withoutPrefix.match(/^data\.([A-Za-z0-9_.]+):\s*([\s\S]*)$/);
  if (!match) return withoutPrefix;
  const [, rawPath, detail] = match;
  const parts = rawPath.split('.');
  const labels: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const idx = Number(parts[i + 1]);
    if (seg === 'transitions' && Number.isInteger(idx)) {
      labels.push(`Transition ${idx + 1}`);
      i++;
    } else if (seg === 'conditions' && Number.isInteger(idx)) {
      labels.push(`condition ${idx + 1}`);
      i++;
    } else if (seg === 'states' && Number.isInteger(idx)) {
      labels.push(`State ${idx + 1}`);
      i++;
    } else if (seg === 'params') {
      labels.push('Parameter');
    } else if (seg === 'initial') {
      labels.push('Initial state');
    }
  }
  const location = labels.join(', ');
  return location ? `${location}: ${detail}` : detail;
}
