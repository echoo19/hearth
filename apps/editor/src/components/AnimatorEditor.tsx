/**
 * Animator editor: a typed, list-based editor for a state-machine asset's
 * document (params, states, transitions). No raw JSON anywhere — every field
 * is a typed control, and a Save commits ONE `updateStateMachineAsset` (a
 * single undo entry). The edit logic lives in ../asmEdit (pure, unit-tested);
 * this component is the DOM shell around it.
 *
 * Opened on demand (View menu, the Assets card's "Edit state machine", or the
 * Inspector's AnimationStateMachine row) via the store's `animatorTarget` seam.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandIssue, StateMachineData } from '@hearth/core';
import { fileUrl } from '../api';
import { useEditor } from '../store';
import type { AssetItem } from '../types';
import { ConfirmDialog, Icon, NumberField, TextField } from './ui';
import { Button, IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { CreateStateMachineDialog } from './CreateStateMachineDialog';
import {
  ANY_STATE,
  addCondition,
  addParam,
  addState,
  addTransition,
  docToDraft,
  draftIssues,
  draftToDoc,
  groupTransitions,
  humanizeSaveError,
  isDraftComplete,
  moveTransitionInGroup,
  opsForParamType,
  outgoingCount,
  removeCondition,
  removeParam,
  removeState,
  removeTransition,
  renameParam,
  renameState,
  savePayload,
  shouldBlockAsmSave,
  setConditionOp,
  setConditionParam,
  setConditionValue,
  setInitialState,
  setParamDefault,
  setParamType,
  setStateAnimation,
  setStateSpeed,
  setTransitionExitTime,
  setTransitionFrom,
  setTransitionTo,
  summarizeTransition,
  type AsmDraft,
  type ConditionOp,
  type DraftTransition,
  type ParamType,
} from '../asmEdit';

const PARAM_TYPES: ParamType[] = ['bool', 'number', 'trigger'];

const OP_LABELS: Record<ConditionOp, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

/** 1 → "1st", 2 → "2nd", 11 → "11th" — for the per-group priority tooltip. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th'}`;
}

export function AnimatorEditor() {
  const assets = useEditor((s) => s.assets);
  const exec = useEditor((s) => s.exec);
  const animatorTarget = useEditor((s) => s.animatorTarget);
  const projectPath = useEditor((s) => s.projectPath);
  const setUnsavedAnimatorDraft = useEditor((s) => s.setUnsavedAnimatorDraft);

  const stateMachineAssets = useMemo(() => assets.filter((a) => a.type === 'stateMachine'), [assets]);
  const animationAssets = useMemo(() => assets.filter((a) => a.type === 'animation'), [assets]);

  const [assetId, setAssetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AsmDraft | null>(null);
  const [loadedDoc, setLoadedDoc] = useState('');
  const [saveErrors, setSaveErrors] = useState<CommandIssue[]>([]);
  const [saving, setSaving] = useState(false);
  // ANIMATOR-2: a machine switch requested while the current draft is dirty,
  // parked behind a discard confirm rather than clobbering unsaved edits.
  const [pendingAssetId, setPendingAssetId] = useState<string | null>(null);
  // ANIMATOR-8: set when Save detects the file changed on disk since we loaded
  // (an agent/CLI/raw-fs edit while the machine was open) — holds the fresh
  // on-disk parse captured at detection time, so the banner's Reload adopts
  // exactly what Save compared against (the store's `asset.stateMachine` only
  // refreshes via the command journal and can be stale for raw fs edits).
  const [conflictDoc, setConflictDoc] = useState<StateMachineData | null>(null);
  // L-085: a click on a State card's outgoing-count badge asks the Transitions
  // section to expand + scroll to that source's group (cheap navigation, no
  // graph canvas). The nonce lets the same group be re-focused repeatedly.
  const [groupFocus, setGroupFocus] = useState<{ from: string; nonce: number } | null>(null);
  // ANIMATOR-3: in-editor "New state machine" create dialog — the shared
  // CreateStateMachineDialog (unified with AssetsPanel's copy, T9-U8).
  const [createOpen, setCreateOpen] = useState(false);
  // The asset id whose document is currently mirrored in `draft`. Guards the
  // load effect from clobbering in-progress edits when an unrelated refresh
  // (e.g. the post-save refresh) hands us a new `assets` array.
  const loadedIdRef = useRef<string | null>(null);

  // Follow an explicit open request. Forcing a reload (loadedIdRef = null)
  // means re-opening the same asset shows it fresh from disk.
  useEffect(() => {
    if (animatorTarget) {
      setAssetId(animatorTarget.assetId);
      loadedIdRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animatorTarget?.nonce]);

  // Keep the selected asset valid: default to the first state machine, and
  // fall back if the current one disappears.
  useEffect(() => {
    if (stateMachineAssets.length === 0) {
      if (assetId !== null) setAssetId(null);
      return;
    }
    if (!assetId || !stateMachineAssets.some((a) => a.id === assetId)) {
      setAssetId(stateMachineAssets[0].id);
    }
  }, [assetId, stateMachineAssets]);

  const asset: AssetItem | null = stateMachineAssets.find((a) => a.id === assetId) ?? null;

  // Load the selected asset's parsed document into a fresh draft — once per
  // asset id (loadedIdRef), so editing survives background refreshes.
  useEffect(() => {
    if (!asset) {
      loadedIdRef.current = null;
      setDraft(null);
      return;
    }
    if (loadedIdRef.current === asset.id) return;
    const doc = asset.stateMachine;
    if (!doc) return; // inspectAssets hasn't attached the parsed doc yet
    loadedIdRef.current = asset.id;
    const next = docToDraft(doc);
    setDraft(next);
    setLoadedDoc(JSON.stringify(draftToDoc(next)));
    setSaveErrors([]);
    setConflictDoc(null);
  }, [asset]);

  const update = (fn: (d: AsmDraft) => AsmDraft) => setDraft((d) => (d ? fn(d) : d));

  const issues = draft ? draftIssues(draft) : [];
  const complete = draft ? isDraftComplete(draft) : false;
  const dirty = draft !== null && JSON.stringify(draftToDoc(draft)) !== loadedDoc;

  // Publish dirty state to the store: PANELS-1 — the global mod+s keybind
  // otherwise has no way to tell a dirty draft apart from a clean one when
  // the keypress lands at the window level (DOM focus outside `.animator`,
  // e.g. the user clicked another dock tab), and was logging "no need to
  // save" while an edit sat unsaved on screen. Global mod+s still never
  // auto-saves the draft itself — that stays scoped to `onKeyDownSave`
  // below (ANIMATOR-4) — this only makes the fallback log message honest.
  useEffect(() => {
    setUnsavedAnimatorDraft(dirty);
  }, [dirty, setUnsavedAnimatorDraft]);
  useEffect(() => {
    return () => setUnsavedAnimatorDraft(false);
  }, [setUnsavedAnimatorDraft]);

  const canSave = !!draft && !saving && dirty && complete;

  async function save(overwrite = false) {
    if (!asset || !draft) return;
    setSaving(true);
    // ANIMATOR-8 backstop (same shape as CodePanel's L-054): a raw filesystem
    // edit never goes through the command layer, so the store's
    // `asset.stateMachine` parse can be stale — the only honest check is to
    // RE-READ the .asm.json from disk right now and compare (normalized
    // through the same doc<->draft round-trip as `loadedDoc`, so formatting/
    // key-order differences never read as a false conflict). On drift, stop
    // and show Reload/Overwrite instead of silently last-write-winning.
    if (!overwrite && projectPath) {
      let onDiskJson: string | null = null;
      try {
        const res = await fetch(fileUrl(projectPath, asset.path));
        onDiskJson = res.ok ? await res.text() : null;
      } catch {
        onDiskJson = null; // can't read (offline/removed) → don't block the save
      }
      if (shouldBlockAsmSave({ overwrite, onDiskJson, loadedDoc })) {
        try {
          setConflictDoc(JSON.parse(onDiskJson!) as StateMachineData);
        } catch {
          setConflictDoc(null);
        }
        setSaving(false);
        return;
      }
    }
    const result = await exec('updateStateMachineAsset', savePayload(asset.id, draft));
    setSaving(false);
    if (result.success) {
      setSaveErrors([]);
      setConflictDoc(null);
      setLoadedDoc(JSON.stringify(draftToDoc(draft)));
    } else {
      setSaveErrors(result.errors);
    }
  }

  // ANIMATOR-8: adopt the on-disk version (the exact doc Save compared
  // against, captured at detection), discarding this session's edits.
  function reloadFromDisk() {
    if (!conflictDoc) return;
    const next = docToDraft(conflictDoc);
    setDraft(next);
    setLoadedDoc(JSON.stringify(draftToDoc(next)));
    setConflictDoc(null);
    setSaveErrors([]);
  }

  // ANIMATOR-2: guard a Machine-dropdown switch that would discard a dirty draft.
  function requestSwitch(id: string) {
    if (id === assetId) return;
    if (dirty) {
      setPendingAssetId(id);
      return;
    }
    setAssetId(id);
  }

  // ANIMATOR-4: the Animator is the deliberate non-autosave panel, so claim
  // mod+s for its own gated save while it's focused — preempting the global
  // "changes are saved automatically" keybind (which fires on window bubble;
  // stopPropagation here keeps it from ever seeing this keydown).
  function onKeyDownSave(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopPropagation();
      if (canSave) void save();
    }
  }

  // The shared "New state machine" dialog (owns its own name/error state).
  const createDialog = <CreateStateMachineDialog open={createOpen} onClose={() => setCreateOpen(false)} />;

  // -------------------------------------------------------------------------
  // Empty / loading states
  // -------------------------------------------------------------------------

  if (stateMachineAssets.length === 0) {
    return (
      <div className="animator">
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="animator" size={16} />
          </span>
          <span>No state machines yet</span>
          <span className="hint">
            State machine assets drive the AnimationStateMachine component. Create one here, or ask an agent — then
            edit its params, states, and transitions.
          </span>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={10} /> New state machine…
          </Button>
        </div>
        {createDialog}
      </div>
    );
  }

  return (
    <div className="animator" onKeyDown={onKeyDownSave}>
      <div className="panel-toolbar animator-toolbar">
        <label className="field-label" htmlFor="animator-asset">
          Machine
        </label>
        <select
          id="animator-asset"
          className="select"
          value={assetId ?? ''}
          onChange={(e) => requestSwitch(e.target.value)}
        >
          {stateMachineAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Tooltip content="Create a new state machine">
          <Button size="sm" onClick={() => setCreateOpen(true)} aria-label="New state machine">
            <Icon name="plus" size={10} /> New
          </Button>
        </Tooltip>
        <span style={{ flex: 1 }} />
        {dirty && <span className="animator-dirty">Unsaved</span>}
        <Tooltip
          content={
            !complete
              ? 'Resolve the highlighted issues before saving'
              : !dirty
                ? 'No unsaved changes'
                : 'Save this state machine'
          }
        >
          <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>
            <Icon name="check" size={11} /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </Tooltip>
      </div>

      {conflictDoc !== null && (
        <div className="code-conflict-banner" role="alert">
          <Icon name="warning" size={13} />
          <span>
            This state machine changed on disk — from an agent or another process — since you opened it. Saving now
            overwrites that change.
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={reloadFromDisk}>
            Reload
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save(true)}>
            Overwrite
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingAssetId !== null}
        title="Discard unsaved changes?"
        body="Switching to another state machine will discard the unsaved edits to this one."
        confirmLabel="Discard & switch"
        danger
        onConfirm={() => {
          if (pendingAssetId) setAssetId(pendingAssetId);
          setPendingAssetId(null);
        }}
        onCancel={() => setPendingAssetId(null)}
      />
      {createDialog}

      {!draft ? (
        <div className="empty-state">
          <span>Could not load this state machine.</span>
          <span className="hint">The asset file may be missing or invalid — check the Console / validation.</span>
        </div>
      ) : (
        <div className="panel-body animator-body">
          <ParamsSection draft={draft} update={update} />
          <StatesSection
            draft={draft}
            update={update}
            animationAssets={animationAssets}
            onNavigateToGroup={(from) => setGroupFocus({ from, nonce: Date.now() })}
          />
          {/* Keyed per machine so per-card expand + per-group collapse state
              (keyed by flat index / source name) never leaks across a switch. */}
          <TransitionsSection key={assetId ?? 'none'} draft={draft} update={update} focus={groupFocus} />

          {issues.length > 0 && (
            <div className="animator-issues" role="status">
              <div className="animator-issues-title">
                <Icon name="warning" size={11} /> Finish these before saving
              </div>
              {issues.map((m, i) => (
                <p key={i}>{m}</p>
              ))}
            </div>
          )}

          {saveErrors.length > 0 && (
            <div className="export-errors" role="alert">
              {saveErrors.map((e, i) => (
                <p key={i}>{humanizeSaveError(e.message)}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function ParamsSection({ draft, update }: { draft: AsmDraft; update: (fn: (d: AsmDraft) => AsmDraft) => void }) {
  return (
    <section className="animator-section">
      <header className="component-header animator-section-header">
        <span className="component-title">Parameters</span>
        <Button size="sm" onClick={() => update(addParam)}>
          <Icon name="plus" size={10} /> Add
        </Button>
      </header>
      <div className="component-body">
        {draft.params.length === 0 ? (
          <span className="animator-empty">No parameters. Add one to gate transitions on game state.</span>
        ) : (
          draft.params.map((p, i) => (
            <div className="editor-row animator-param-row" key={i}>
              <TextField value={p.name} placeholder="name" onCommit={(v) => update((d) => renameParam(d, i, v))} />
              <select
                className="select"
                aria-label={`Type for parameter ${p.name || '(unnamed)'}`}
                value={p.type}
                onChange={(e) => update((d) => setParamType(d, i, e.target.value as ParamType))}
              >
                {PARAM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <div className="animator-param-default">
                {p.type === 'bool' && (
                  <label className="animator-check">
                    <input
                      type="checkbox"
                      checked={p.default === true}
                      onChange={(e) => update((d) => setParamDefault(d, i, e.target.checked))}
                    />
                    <span>default</span>
                  </label>
                )}
                {p.type === 'number' && (
                  <NumberField
                    value={typeof p.default === 'number' ? p.default : 0}
                    onCommit={(v) => update((d) => setParamDefault(d, i, v))}
                  />
                )}
                {p.type === 'trigger' && <span className="animator-empty">fires once</span>}
              </div>
              <IconButton
                bare
                className="icon-btn danger"
                icon="cross"
                iconSize={10}
                label={`Remove ${p.name || 'parameter'}`}
                onClick={() => update((d) => removeParam(d, i))}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function StatesSection({
  draft,
  update,
  animationAssets,
  onNavigateToGroup,
}: {
  draft: AsmDraft;
  update: (fn: (d: AsmDraft) => AsmDraft) => void;
  animationAssets: AssetItem[];
  onNavigateToGroup: (from: string) => void;
}) {
  return (
    <section className="animator-section">
      <header className="component-header animator-section-header">
        <span className="component-title">States</span>
        <Button size="sm" onClick={() => update(addState)}>
          <Icon name="plus" size={10} /> Add
        </Button>
      </header>
      <div className="component-body">
        {draft.states.length === 0 ? (
          <span className="animator-empty">A state machine needs at least one state.</span>
        ) : (
          draft.states.map((s, i) => {
            const isInitial = draft.initial === s.name && s.name !== '';
            const out = s.name ? outgoingCount(draft, s.name) : 0;
            return (
              <div className="editor-row animator-state-row" key={i}>
                <IconButton
                  bare
                  className={`animator-initial${isInitial ? ' on' : ''}`}
                  icon="star"
                  iconSize={11}
                  label={isInitial ? 'Initial state' : 'Make this the initial state'}
                  aria-pressed={isInitial}
                  disabled={s.name === ''}
                  onClick={() => update((d) => setInitialState(d, s.name))}
                />
                <TextField value={s.name} placeholder="name" onCommit={(v) => update((d) => renameState(d, i, v))} />
                <select
                  className="select"
                  aria-label={`Animation for state ${s.name || '(unnamed)'}`}
                  value={s.animation}
                  onChange={(e) => update((d) => setStateAnimation(d, i, e.target.value))}
                >
                  <option value="">(choose animation)</option>
                  {animationAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <Tooltip
                  content={
                    out === 0
                      ? 'No transitions leave this state'
                      : `${out} outgoing transition${out === 1 ? '' : 's'} — jump to them`
                  }
                >
                  <button
                    type="button"
                    className="animator-out-badge"
                    disabled={out === 0 || s.name === ''}
                    onClick={() => onNavigateToGroup(s.name)}
                    aria-label={`${out} outgoing transition${out === 1 ? '' : 's'} from ${s.name || 'this state'}`}
                  >
                    {out} out
                  </button>
                </Tooltip>
                <div className="animator-speed" title="Playback speed">
                  <span className="animator-speed-label" aria-hidden="true">
                    ×
                  </span>
                  <NumberField value={s.speed} onCommit={(v) => update((d) => setStateSpeed(d, i, v))} />
                </div>
                <IconButton
                  bare
                  className="icon-btn danger"
                  icon="cross"
                  iconSize={10}
                  label={`Remove ${s.name || 'state'}`}
                  onClick={() => update((d) => removeState(d, i))}
                />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function TransitionsSection({
  draft,
  update,
  focus,
}: {
  draft: AsmDraft;
  update: (fn: (d: AsmDraft) => AsmDraft) => void;
  focus: { from: string; nonce: number } | null;
}) {
  const groups = useMemo(() => groupTransitions(draft), [draft]);
  // Card expansion is keyed by flat declaration index; collapsed by default so
  // the list reads as a scannable set of one-line summaries. A group collapse
  // set hides an entire source's cards behind its "From <state>" header.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [flashGroup, setFlashGroup] = useState<string | null>(null);
  const groupRefs = useRef(new Map<string, HTMLDivElement | null>());

  const toggleCard = (idx: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  const toggleGroup = (from: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(from)) next.delete(from);
      else next.add(from);
      return next;
    });

  // A newly added transition is appended at the end — expand it so the user can
  // edit the fresh (from=to, conditionless) row immediately.
  function addAndExpand() {
    const idx = draft.transitions.length;
    update(addTransition);
    setExpanded((prev) => new Set(prev).add(idx));
  }

  // React to a State-card navigation request: un-collapse the group, scroll it
  // into view, and briefly flash it so the eye lands on the right section.
  useEffect(() => {
    if (!focus) return;
    setCollapsedGroups((prev) => {
      if (!prev.has(focus.from)) return prev;
      const next = new Set(prev);
      next.delete(focus.from);
      return next;
    });
    const el = groupRefs.current.get(focus.from);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFlashGroup(focus.from);
    const timer = window.setTimeout(() => setFlashGroup(null), 1200);
    return () => window.clearTimeout(timer);
  }, [focus?.nonce, focus?.from]);

  return (
    <section className="animator-section">
      <header className="component-header animator-section-header">
        <span className="component-title">Transitions</span>
        <Tooltip content={draft.states.length === 0 ? 'Add a state first' : 'Add a transition'}>
          <Button size="sm" disabled={draft.states.length === 0} onClick={addAndExpand}>
            <Icon name="plus" size={10} /> Add
          </Button>
        </Tooltip>
      </header>
      <div className="component-body">
        {draft.transitions.length === 0 ? (
          <span className="animator-empty">No transitions. Add one to move between states.</span>
        ) : (
          groups.map((g) => {
            const collapsed = collapsedGroups.has(g.from);
            const label = g.from === ANY_STATE ? 'Any state' : g.from || '(no source)';
            return (
              <div
                key={g.from}
                className={`animator-tgroup${flashGroup === g.from ? ' flash' : ''}`}
                ref={(el) => groupRefs.current.set(g.from, el)}
              >
                <button
                  type="button"
                  className="animator-tgroup-header"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(g.from)}
                >
                  <span className={`animator-tgroup-caret${collapsed ? '' : ' open'}`} aria-hidden="true">
                    <Icon name="chevron" size={10} />
                  </span>
                  <span className="animator-tgroup-title">From {label}</span>
                  <span className="animator-tgroup-count">
                    {g.items.length} transition{g.items.length === 1 ? '' : 's'}
                  </span>
                  {g.from === ANY_STATE && (
                    <Tooltip content="Checked after a state's own transitions — a machine-wide fallback">
                      <span className="animator-tgroup-note">fallback</span>
                    </Tooltip>
                  )}
                </button>
                {!collapsed && (
                  <div className="animator-tgroup-body">
                    {g.items.map((item) => (
                      <TransitionCard
                        key={item.index}
                        draft={draft}
                        update={update}
                        item={item}
                        groupSize={g.items.length}
                        expanded={expanded.has(item.index)}
                        onToggle={() => toggleCard(item.index)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function TransitionCard({
  draft,
  update,
  item,
  groupSize,
  expanded,
  onToggle,
}: {
  draft: AsmDraft;
  update: (fn: (d: AsmDraft) => AsmDraft) => void;
  item: { transition: DraftTransition; index: number; groupPos: number };
  groupSize: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { transition: t, index: ti, groupPos } = item;
  const stateNames = draft.states.map((s) => s.name).filter(Boolean);
  const atTop = groupPos === 0;
  const atBottom = groupPos === groupSize - 1;
  // Priority badge: the ordinal WITHIN this source group — the only order the
  // runtime actually honors. pickTransition evaluates two strict tiers (the
  // current state's own transitions first, then `any` transitions), each in
  // relative declaration order; a global flat index would overstate what the
  // order means across tiers, so we never show one.
  const isAny = t.from === ANY_STATE;
  const priorityTip = isAny
    ? `Fallback #${groupPos + 1} — checked after the state's own transitions`
    : `Checked ${ordinal(groupPos + 1)} among ${t.from || 'this state'}'s own transitions — first match wins`;

  return (
    <div className="animator-transition-card">
      <div className="animator-transition-summary">
        <Tooltip content={priorityTip}>
          <span className="animator-priority" aria-label={priorityTip}>
            {groupPos + 1}
          </span>
        </Tooltip>
        <button
          type="button"
          className="animator-summary-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={`animator-tgroup-caret${expanded ? ' open' : ''}`} aria-hidden="true">
            <Icon name="chevron" size={9} />
          </span>
          <span className="animator-summary-text">{summarizeTransition(draft, t)}</span>
        </button>
        <span style={{ flex: 1 }} />
        <div className="animator-reorder" role="group" aria-label="Reorder within this source">
          <IconButton
            bare
            className="icon-btn animator-move-up"
            icon="chevron"
            iconSize={10}
            label="Move earlier (higher priority)"
            disabled={atTop}
            onClick={() => update((d) => moveTransitionInGroup(d, ti, groupPos - 1))}
          />
          <IconButton
            bare
            className="icon-btn animator-move-down"
            icon="chevron"
            iconSize={10}
            label="Move later (lower priority)"
            disabled={atBottom}
            onClick={() => update((d) => moveTransitionInGroup(d, ti, groupPos + 1))}
          />
        </div>
        <IconButton
          bare
          className="icon-btn danger"
          icon="cross"
          iconSize={10}
          label="Remove transition"
          onClick={() => update((d) => removeTransition(d, ti))}
        />
      </div>

      {expanded && (
        <div className="animator-transition-edit">
          <div className="animator-transition-head">
            <select
              className="select"
              aria-label="Transition source state"
              value={t.from}
              onChange={(e) => update((d) => setTransitionFrom(d, ti, e.target.value))}
            >
              <option value={ANY_STATE}>Any</option>
              {stateNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="animator-arrow" aria-hidden="true">
              →
            </span>
            <select
              className="select"
              aria-label="Transition target state"
              value={t.to}
              onChange={(e) => update((d) => setTransitionTo(d, ti, e.target.value))}
            >
              <option value="">(to)</option>
              {stateNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <label className="animator-check animator-exittime">
            <input
              type="checkbox"
              checked={t.exitTime !== undefined}
              onChange={(e) => update((d) => setTransitionExitTime(d, ti, e.target.checked ? 0.5 : undefined))}
            />
            <span>Exit time</span>
            {t.exitTime !== undefined && (
              // The standard commit-on-blur/Enter field idiom (L-088): an
              // out-of-range or non-numeric draft reverts with the shared
              // rejection cue instead of being live-clamped mid-keystroke.
              <NumberField
                value={t.exitTime}
                min={0}
                max={1}
                onCommit={(v) => update((d) => setTransitionExitTime(d, ti, v))}
              />
            )}
          </label>

          <div className="animator-conditions">
            <div className="animator-conditions-head">
              <span className="animator-empty">Conditions</span>
              <Button size="sm" variant="ghost" onClick={() => update((d) => addCondition(d, ti))}>
                <Icon name="plus" size={10} /> Condition
              </Button>
            </div>
            {t.conditions.length === 0 ? (
              <span className="animator-empty">
                {t.from === ANY_STATE ? 'An “Any” transition needs a condition.' : 'No conditions (uses exit time only).'}
              </span>
            ) : (
              t.conditions.map((c, ci) => {
                const type = draft.params.find((p) => p.name === c.param)?.type;
                const ops = type ? opsForParamType(type) : [];
                return (
                  <div className="animator-condition-row" key={ci}>
                    <select
                      className="select"
                      aria-label="Condition parameter"
                      value={c.param}
                      onChange={(e) => update((d) => setConditionParam(d, ti, ci, e.target.value))}
                    >
                      <option value="">(param)</option>
                      {draft.params.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {type === 'trigger' ? (
                      <span className="animator-empty animator-trigger-note">on trigger</span>
                    ) : (
                      <>
                        <select
                          className="select animator-op"
                          aria-label="Condition operator"
                          value={c.op ?? ''}
                          disabled={ops.length === 0}
                          onChange={(e) => update((d) => setConditionOp(d, ti, ci, e.target.value as ConditionOp))}
                        >
                          {c.op === undefined && <option value="">op</option>}
                          {ops.map((op) => (
                            <option key={op} value={op}>
                              {OP_LABELS[op]}
                            </option>
                          ))}
                        </select>
                        {type === 'bool' ? (
                          <select
                            className="select"
                            aria-label="Condition value"
                            value={c.value === true ? 'true' : 'false'}
                            onChange={(e) => update((d) => setConditionValue(d, ti, ci, e.target.value === 'true'))}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <NumberField
                            value={typeof c.value === 'number' ? c.value : 0}
                            onCommit={(v) => update((d) => setConditionValue(d, ti, ci, v))}
                          />
                        )}
                      </>
                    )}
                    <IconButton
                      bare
                      className="icon-btn danger"
                      icon="cross"
                      iconSize={10}
                      label="Remove condition"
                      onClick={() => update((d) => removeCondition(d, ti, ci))}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
