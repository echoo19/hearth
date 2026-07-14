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
import type { CommandIssue } from '@hearth/core';
import { useEditor } from '../store';
import type { AssetItem } from '../types';
import { Icon, NumberField, TextField } from './ui';
import { Button } from './ui/Button';
import {
  ANY_STATE,
  addCondition,
  addParam,
  addState,
  addTransition,
  docToDraft,
  draftIssues,
  draftToDoc,
  isDraftComplete,
  opsForParamType,
  removeCondition,
  removeParam,
  removeState,
  removeTransition,
  renameParam,
  renameState,
  savePayload,
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
  type AsmDraft,
  type ConditionOp,
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

export function AnimatorEditor() {
  const assets = useEditor((s) => s.assets);
  const exec = useEditor((s) => s.exec);
  const animatorTarget = useEditor((s) => s.animatorTarget);

  const stateMachineAssets = useMemo(() => assets.filter((a) => a.type === 'stateMachine'), [assets]);
  const animationAssets = useMemo(() => assets.filter((a) => a.type === 'animation'), [assets]);

  const [assetId, setAssetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AsmDraft | null>(null);
  const [loadedDoc, setLoadedDoc] = useState('');
  const [saveErrors, setSaveErrors] = useState<CommandIssue[]>([]);
  const [saving, setSaving] = useState(false);
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
  }, [asset]);

  const update = (fn: (d: AsmDraft) => AsmDraft) => setDraft((d) => (d ? fn(d) : d));

  const issues = draft ? draftIssues(draft) : [];
  const complete = draft ? isDraftComplete(draft) : false;
  const dirty = draft !== null && JSON.stringify(draftToDoc(draft)) !== loadedDoc;

  async function save() {
    if (!asset || !draft) return;
    setSaving(true);
    const result = await exec('updateStateMachineAsset', savePayload(asset.id, draft));
    setSaving(false);
    if (result.success) {
      setSaveErrors([]);
      setLoadedDoc(JSON.stringify(draftToDoc(draft)));
    } else {
      setSaveErrors(result.errors);
    }
  }

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
            State machine assets drive the AnimationStateMachine component. Ask an agent to create one, or use the
            CLI’s createStateMachineAsset command — then edit its params, states, and transitions here.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="animator">
      <div className="panel-toolbar animator-toolbar">
        <label className="field-label" htmlFor="animator-asset">
          Machine
        </label>
        <select
          id="animator-asset"
          className="select"
          value={assetId ?? ''}
          onChange={(e) => setAssetId(e.target.value)}
        >
          {stateMachineAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {dirty && <span className="animator-dirty">Unsaved</span>}
        <Button
          size="sm"
          variant="primary"
          disabled={!draft || saving || !dirty || !complete}
          title={
            !complete
              ? 'Resolve the highlighted issues before saving'
              : !dirty
                ? 'No unsaved changes'
                : 'Save this state machine'
          }
          onClick={() => void save()}
        >
          <Icon name="check" size={11} /> {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {!draft ? (
        <div className="empty-state">
          <span>Could not load this state machine.</span>
          <span className="hint">The asset file may be missing or invalid — check the Console / validation.</span>
        </div>
      ) : (
        <div className="panel-body animator-body">
          <ParamsSection draft={draft} update={update} />
          <StatesSection draft={draft} update={update} animationAssets={animationAssets} />
          <TransitionsSection draft={draft} update={update} />

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
                <p key={i}>{e.message}</p>
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
            <div className="animator-param-row" key={i}>
              <TextField value={p.name} placeholder="name" onCommit={(v) => update((d) => renameParam(d, i, v))} />
              <select
                className="select"
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
              <button
                className="icon-btn danger"
                title={`Remove ${p.name || 'parameter'}`}
                onClick={() => update((d) => removeParam(d, i))}
              >
                <Icon name="cross" size={10} />
              </button>
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
}: {
  draft: AsmDraft;
  update: (fn: (d: AsmDraft) => AsmDraft) => void;
  animationAssets: AssetItem[];
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
            return (
              <div className="animator-state-row" key={i}>
                <button
                  className={`animator-initial${isInitial ? ' on' : ''}`}
                  title={isInitial ? 'Initial state' : 'Make this the initial state'}
                  aria-pressed={isInitial}
                  disabled={s.name === ''}
                  onClick={() => update((d) => setInitialState(d, s.name))}
                >
                  <Icon name="star" size={11} />
                </button>
                <TextField value={s.name} placeholder="name" onCommit={(v) => update((d) => renameState(d, i, v))} />
                <select
                  className="select"
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
                <div className="animator-speed" title="Playback speed">
                  <span className="animator-speed-label">×</span>
                  <NumberField value={s.speed} onCommit={(v) => update((d) => setStateSpeed(d, i, v))} />
                </div>
                <button
                  className="icon-btn danger"
                  title={`Remove ${s.name || 'state'}`}
                  onClick={() => update((d) => removeState(d, i))}
                >
                  <Icon name="cross" size={10} />
                </button>
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

function TransitionsSection({ draft, update }: { draft: AsmDraft; update: (fn: (d: AsmDraft) => AsmDraft) => void }) {
  const stateNames = draft.states.map((s) => s.name).filter(Boolean);
  return (
    <section className="animator-section">
      <header className="component-header animator-section-header">
        <span className="component-title">Transitions</span>
        <Button
          size="sm"
          disabled={draft.states.length === 0}
          title={draft.states.length === 0 ? 'Add a state first' : 'Add a transition'}
          onClick={() => update(addTransition)}
        >
          <Icon name="plus" size={10} /> Add
        </Button>
      </header>
      <div className="component-body">
        {draft.transitions.length === 0 ? (
          <span className="animator-empty">No transitions. Add one to move between states.</span>
        ) : (
          draft.transitions.map((t, ti) => (
            <div className="animator-transition-card" key={ti}>
              <div className="animator-transition-head">
                <select
                  className="select"
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
                <span style={{ flex: 1 }} />
                <button
                  className="icon-btn danger"
                  title="Remove transition"
                  onClick={() => update((d) => removeTransition(d, ti))}
                >
                  <Icon name="cross" size={10} />
                </button>
              </div>

              <label className="animator-check animator-exittime">
                <input
                  type="checkbox"
                  checked={t.exitTime !== undefined}
                  onChange={(e) => update((d) => setTransitionExitTime(d, ti, e.target.checked ? 0.5 : undefined))}
                />
                <span>Exit time</span>
                {t.exitTime !== undefined && (
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={t.exitTime}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      update((d) => setTransitionExitTime(d, ti, Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0));
                    }}
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
                        <button
                          className="icon-btn danger"
                          title="Remove condition"
                          onClick={() => update((d) => removeCondition(d, ti, ci))}
                        >
                          <Icon name="cross" size={10} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
