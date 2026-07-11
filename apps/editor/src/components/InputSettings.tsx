/**
 * Input settings panel: keyboard/gamepad-button/gamepad-axis bindings per
 * action, virtual axes, and the global deadzone — no JSON textareas, every
 * control is typed (reuses NumberField/TextField from ui.tsx).
 *
 * Every edit calls exec('updateSettings', { inputMappings }). Per Task 4's
 * settingsCommands.ts: `actions` merges per-action (an empty code array
 * removes that action), while `gamepadButtons`, `gamepadAxes`, `axes`, and
 * `deadzone` each replace that whole top-level key — so whenever one of
 * those four changes, the full updated map for that key is sent.
 *
 * State model — optimistic local mappings. The wholesale-replace keys make
 * "build the patch from the last server snapshot" a lost-update race: two
 * quick edits would build the second patch from pre-first-edit data and
 * silently revert the first. So the panel owns a local InputMappings copy:
 * every edit (1) applies to the local copy synchronously (via a ref, so
 * consecutive edits compose even within one render), (2) builds its exec
 * patch FROM that just-updated local state, and (3) re-syncs local state
 * from server info only when no writes are in flight (pending counter).
 * `actions` goes through the same local state for consistency even though
 * its per-key server merge is race-safe on its own.
 *
 * Action names live across three maps (actions/gamepadButtons/gamepadAxes)
 * with no single owning key, and `actions` can't hold a zero-binding entry
 * (empty array = delete, per the merge rule above) — so a freshly "added"
 * action is tracked as a local draft name until its first real key or
 * gamepad-button binding lands, at which point it appears from the mappings
 * data and the draft is dropped.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GAMEPAD_BUTTON_NAMES } from '@hearth/core';
import type { GamepadAxisBinding, InputMappings, VirtualAxis } from '@hearth/core';
import { useEditor } from '../store';
import { ConfirmDialog, Icon, NumberField, TextField } from './ui';

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

function has(map: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

const DEFAULT_AXIS_BINDING: GamepadAxisBinding = { axis: 0, direction: 1, threshold: 0.5 };

/**
 * Pure classifier for a settled `updateSettings` result: decides the message
 * shown when an optimistic key/gamepad binding edit fails to persist and
 * snaps back to server truth. Previously this rollback happened with zero
 * explanation — a user who pressed a key to bind an action would see the
 * chip vanish a moment later with no idea why. Exported for unit testing.
 */
export function updateSettingsErrorMessage(result: { success: boolean; errors: { message: string }[] }): string | null {
  if (result.success) return null;
  return result.errors[0]?.message ?? "That didn't save.";
}

/** One edit = the full next local state + the minimal updateSettings patch derived from it. */
interface Edit {
  next: InputMappings;
  patch: Partial<InputMappings>;
}

// ---------------------------------------------------------------------------
// Shared bits: chips, capture button, gamepad-button add select
// ---------------------------------------------------------------------------

function ChipList({
  items,
  onRemove,
  empty,
}: {
  items: string[];
  onRemove: (item: string, index: number) => void;
  empty: string;
}) {
  if (items.length === 0) return <span className="chip-list-empty">{empty}</span>;
  return (
    <div className="chip-list">
      {items.map((item, i) => (
        <span className="chip mono" key={`${item}-${i}`}>
          {item}
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove ${item}`}
            title={`Remove ${item}`}
            onClick={() => onRemove(item, i)}
          >
            <Icon name="cross" size={8} />
          </button>
        </span>
      ))}
    </div>
  );
}

function CaptureButton({
  armed,
  label,
  onArm,
  onCancel,
}: {
  armed: boolean;
  label: string;
  onArm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm${armed ? ' btn-capture-armed' : ''}`}
        onClick={armed ? onCancel : onArm}
      >
        {armed ? 'Press any key…' : label}
      </button>
      {armed && <span className="capture-hint">Esc cancels — Escape itself can't be bound here.</span>}
    </>
  );
}

function GamepadButtonAdd({ bound, onAdd }: { bound: string[]; onAdd: (name: string) => void }) {
  const options = GAMEPAD_BUTTON_NAMES.filter((n) => !bound.includes(n));
  return (
    <select
      className="select"
      value=""
      disabled={options.length === 0}
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
      }}
    >
      <option value="" disabled>
        {options.length === 0 ? 'All buttons bound' : 'Add gamepad button…'}
      </option>
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Action row: keyboard codes, gamepad buttons, optional gamepad-axis binding
// ---------------------------------------------------------------------------

function ActionRow({
  name,
  codes,
  gamepadNames,
  axisBinding,
  capturing,
  onArmCapture,
  onCancelCapture,
  onRemoveCode,
  onAddGamepadButton,
  onRemoveGamepadButton,
  onAddAxisBinding,
  onRemoveAxisBinding,
  onSetAxisField,
  onDelete,
}: {
  name: string;
  codes: string[];
  gamepadNames: string[];
  axisBinding: GamepadAxisBinding | undefined;
  capturing: boolean;
  onArmCapture: () => void;
  onCancelCapture: () => void;
  onRemoveCode: (code: string) => void;
  onAddGamepadButton: (name: string) => void;
  onRemoveGamepadButton: (name: string) => void;
  onAddAxisBinding: () => void;
  onRemoveAxisBinding: () => void;
  onSetAxisField: (patch: Partial<GamepadAxisBinding>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="component-card">
      <div className="component-header">
        <span className="component-title">{name}</span>
        <button className="icon-btn danger" title={`Delete action "${name}"`} onClick={onDelete}>
          <Icon name="cross" size={10} />
        </button>
      </div>
      <div className="component-body">
        <div className="inspector-row">
          <label className="field-label">Keys</label>
          <div className="input-binding-col">
            <ChipList items={codes} onRemove={onRemoveCode} empty="No keys bound" />
            <CaptureButton armed={capturing} label="Press a key…" onArm={onArmCapture} onCancel={onCancelCapture} />
          </div>
        </div>
        <div className="inspector-row">
          <label className="field-label">Gamepad</label>
          <div className="input-binding-col">
            <ChipList items={gamepadNames} onRemove={onRemoveGamepadButton} empty="No buttons bound" />
            <GamepadButtonAdd bound={gamepadNames} onAdd={onAddGamepadButton} />
          </div>
        </div>
        {axisBinding ? (
          <div className="input-axis-binding">
            <div className="inspector-row">
              <label className="field-label">Gamepad axis</label>
              <NumberField value={axisBinding.axis} onCommit={(v) => onSetAxisField({ axis: v })} />
            </div>
            <div className="inspector-row">
              <label className="field-label">Direction</label>
              <select
                className="select"
                value={String(axisBinding.direction)}
                onChange={(e) => onSetAxisField({ direction: Number(e.target.value) as 1 | -1 })}
              >
                <option value="1">+1</option>
                <option value="-1">−1</option>
              </select>
            </div>
            <div className="inspector-row">
              <label className="field-label">Threshold</label>
              <NumberField value={axisBinding.threshold} onCommit={(v) => onSetAxisField({ threshold: v })} />
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onRemoveAxisBinding}>
              Remove gamepad axis binding
            </button>
          </div>
        ) : (
          <button className="btn btn-sm" onClick={onAddAxisBinding}>
            <Icon name="plus" size={10} /> Add gamepad axis binding
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtual axis row: name (renamable), gamepad axis index, key capture, deadzone
// ---------------------------------------------------------------------------

function AxisRow({
  name,
  axis,
  globalDeadzone,
  capturingNeg,
  capturingPos,
  onArmNeg,
  onArmPos,
  onCancelCapture,
  onRemoveNegCode,
  onRemovePosCode,
  onRename,
  onSetGamepadAxis,
  onSetDeadzone,
  onDelete,
}: {
  name: string;
  axis: VirtualAxis;
  globalDeadzone: number;
  capturingNeg: boolean;
  capturingPos: boolean;
  onArmNeg: () => void;
  onArmPos: () => void;
  onCancelCapture: () => void;
  onRemoveNegCode: (code: string) => void;
  onRemovePosCode: (code: string) => void;
  onRename: (newName: string) => void;
  onSetGamepadAxis: (value: number | undefined) => void;
  onSetDeadzone: (value: number | undefined) => void;
  onDelete: () => void;
}) {
  const [gamepadAxisEnabled, setGamepadAxisEnabled] = useState(axis.gamepadAxis !== undefined);
  const [deadzoneEnabled, setDeadzoneEnabled] = useState(axis.deadzone !== undefined);

  useEffect(() => setGamepadAxisEnabled(axis.gamepadAxis !== undefined), [axis.gamepadAxis]);
  useEffect(() => setDeadzoneEnabled(axis.deadzone !== undefined), [axis.deadzone]);

  return (
    <div className="component-card">
      <div className="component-header">
        <TextField key={`axis-name-${name}`} value={name} onCommit={onRename} />
        <button className="icon-btn danger" title={`Delete axis "${name}"`} onClick={onDelete}>
          <Icon name="cross" size={10} />
        </button>
      </div>
      <div className="component-body">
        <div className="inspector-row">
          <label className="field-label">Gamepad axis</label>
          <div className="input-binding-col">
            <label className="input-checkbox-label">
              <input
                type="checkbox"
                checked={gamepadAxisEnabled}
                onChange={(e) => {
                  setGamepadAxisEnabled(e.target.checked);
                  onSetGamepadAxis(e.target.checked ? (axis.gamepadAxis ?? 0) : undefined);
                }}
              />
              Bound
            </label>
            {gamepadAxisEnabled && (
              <NumberField value={axis.gamepadAxis ?? 0} onCommit={onSetGamepadAxis} />
            )}
          </div>
        </div>
        <div className="inspector-row">
          <label className="field-label">Negative key</label>
          <div className="input-binding-col">
            <ChipList items={axis.negativeCodes} onRemove={onRemoveNegCode} empty="No keys bound" />
            <CaptureButton armed={capturingNeg} label="Press a key…" onArm={onArmNeg} onCancel={onCancelCapture} />
          </div>
        </div>
        <div className="inspector-row">
          <label className="field-label">Positive key</label>
          <div className="input-binding-col">
            <ChipList items={axis.positiveCodes} onRemove={onRemovePosCode} empty="No keys bound" />
            <CaptureButton armed={capturingPos} label="Press a key…" onArm={onArmPos} onCancel={onCancelCapture} />
          </div>
        </div>
        <div className="inspector-row">
          <label className="field-label">Deadzone</label>
          <div className="input-binding-col">
            <label className="input-checkbox-label">
              <input
                type="checkbox"
                checked={deadzoneEnabled}
                onChange={(e) => {
                  setDeadzoneEnabled(e.target.checked);
                  onSetDeadzone(e.target.checked ? (axis.deadzone ?? globalDeadzone) : undefined);
                }}
              />
              Override (global: {globalDeadzone})
            </label>
            {deadzoneEnabled && (
              <NumberField value={axis.deadzone ?? globalDeadzone} onCommit={onSetDeadzone} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type CaptureTarget =
  | { kind: 'action'; name: string }
  | { kind: 'axis-neg'; name: string }
  | { kind: 'axis-pos'; name: string };

export function InputSettings() {
  const info = useEditor((s) => s.info);
  const exec = useEditor((s) => s.exec);

  const serverMappings = info?.inputMappings ?? null;

  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const [newActionName, setNewActionName] = useState('');
  const [newAxisName, setNewAxisName] = useState('');
  const [draftActionNames, setDraftActionNames] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'action' | 'axis'; name: string } | null>(null);

  // Optimistic local mappings (see the file header). `localRef` mirrors the
  // state synchronously so consecutive edits compose without waiting for a
  // re-render; `pendingWrites` counts in-flight updateSettings calls so a
  // server refresh can't clobber newer local edits mid-write.
  const [local, setLocal] = useState<InputMappings | null>(serverMappings);
  const localRef = useRef<InputMappings | null>(serverMappings);
  const pendingWrites = useRef(0);

  // Reconcile from server info only when nothing is in flight (covers
  // project open/switch, external agent edits, and undo/redo refreshes).
  useEffect(() => {
    if (pendingWrites.current === 0) {
      localRef.current = serverMappings;
      setLocal(serverMappings);
    }
  }, [serverMappings]);

  /**
   * Apply one edit: compute { next, patch } from the LIVE local state (the
   * ref, not a render snapshot), commit it locally right away, then send the
   * patch. When the last in-flight write settles, re-sync local state from
   * the store — exec() has refreshed `info` by then on success, and on
   * failure this rolls the optimistic change back to server truth.
   */
  function applyEdit(edit: (cur: InputMappings) => Edit | null) {
    const current = localRef.current;
    if (!current) return;
    const result = edit(current);
    if (!result) return;
    localRef.current = result.next;
    setLocal(result.next);
    setEditError(null);
    pendingWrites.current += 1;
    exec('updateSettings', { inputMappings: result.patch }, { quiet: true }).then(
      (settled) => setEditError(updateSettingsErrorMessage(settled)),
      () => setEditError("That change didn't save — check your connection."),
    ).finally(() => {
      pendingWrites.current -= 1;
      if (pendingWrites.current === 0) {
        const latest = useEditor.getState().info?.inputMappings ?? null;
        localRef.current = latest;
        setLocal(latest);
      }
    });
  }

  // Drop a locally-drafted action name once it gets a real binding — it then
  // renders from `actions`/`gamepadButtons` like any other action.
  useEffect(() => {
    if (!local) return;
    setDraftActionNames((prev) =>
      prev.filter((n) => !local.actions[n]?.length && !local.gamepadButtons[n]?.length),
    );
  }, [local]);

  // Key capture: while armed, swallow every keydown at the capture phase so
  // global shortcuts (App.tsx's window-level Cmd+Z/Cmd+Y handler) never see
  // it. Escape cancels without recording; losing window focus disarms too.
  useEffect(() => {
    if (!capture) return;
    const target = capture;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture(null);
        return;
      }
      recordCapturedCode(target, e.code);
      setCapture(null);
    }
    function onBlur() {
      setCapture(null);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
    // recordCapturedCode goes through applyEdit, which reads the live
    // localRef — never a stale arm-time snapshot — so the handler stays
    // correct even if the mappings change while armed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture]);

  if (!info || !local) {
    return (
      <>
        <div className="panel-header">
          <span>Input</span>
        </div>
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="script" size={16} />
          </span>
          <span>No project open</span>
        </div>
      </>
    );
  }

  // Non-null render binding. The narrowing above doesn't reach the hoisted
  // function declarations below — but those all read via applyEdit/localRef,
  // so only the JSX needs this.
  const m: InputMappings = local;

  function recordCapturedCode(target: CaptureTarget, code: string) {
    applyEdit((cur) => {
      if (target.kind === 'action') {
        const existing = cur.actions[target.name] ?? [];
        if (existing.includes(code)) return null;
        const codes = [...existing, code];
        return {
          next: { ...cur, actions: { ...cur.actions, [target.name]: codes } },
          patch: { actions: { [target.name]: codes } },
        };
      }
      const axis = cur.axes[target.name];
      if (!axis) return null;
      const field = target.kind === 'axis-neg' ? 'negativeCodes' : 'positiveCodes';
      if (axis[field].includes(code)) return null;
      const axes = { ...cur.axes, [target.name]: { ...axis, [field]: [...axis[field], code] } };
      return { next: { ...cur, axes }, patch: { axes } };
    });
  }

  function removeActionCode(name: string, code: string) {
    applyEdit((cur) => {
      const remaining = (cur.actions[name] ?? []).filter((c) => c !== code);
      // Server semantics: an empty array deletes the action key — mirror that
      // locally so the row only survives via other bindings (or as a draft).
      const actions =
        remaining.length > 0 ? { ...cur.actions, [name]: remaining } : withoutKey(cur.actions, name);
      return { next: { ...cur, actions }, patch: { actions: { [name]: remaining } } };
    });
  }

  function addGamepadButton(name: string, buttonName: string) {
    applyEdit((cur) => {
      const current = cur.gamepadButtons[name] ?? [];
      if (current.includes(buttonName)) return null;
      const gamepadButtons = { ...cur.gamepadButtons, [name]: [...current, buttonName] };
      return { next: { ...cur, gamepadButtons }, patch: { gamepadButtons } };
    });
  }

  function removeGamepadButton(name: string, buttonName: string) {
    applyEdit((cur) => {
      const remaining = (cur.gamepadButtons[name] ?? []).filter((b) => b !== buttonName);
      const gamepadButtons = withoutKey(cur.gamepadButtons, name);
      if (remaining.length > 0) gamepadButtons[name] = remaining;
      return { next: { ...cur, gamepadButtons }, patch: { gamepadButtons } };
    });
  }

  function addAxisBinding(name: string) {
    applyEdit((cur) => {
      const gamepadAxes = { ...cur.gamepadAxes, [name]: DEFAULT_AXIS_BINDING };
      return { next: { ...cur, gamepadAxes }, patch: { gamepadAxes } };
    });
  }

  function removeAxisBinding(name: string) {
    applyEdit((cur) => {
      const gamepadAxes = withoutKey(cur.gamepadAxes, name);
      return { next: { ...cur, gamepadAxes }, patch: { gamepadAxes } };
    });
  }

  function setAxisBindingField(name: string, fieldPatch: Partial<GamepadAxisBinding>) {
    applyEdit((cur) => {
      const current = cur.gamepadAxes[name];
      if (!current) return null;
      const gamepadAxes = { ...cur.gamepadAxes, [name]: { ...current, ...fieldPatch } };
      return { next: { ...cur, gamepadAxes }, patch: { gamepadAxes } };
    });
  }

  function deleteAction(name: string) {
    setDraftActionNames((prev) => prev.filter((n) => n !== name));
    applyEdit((cur) => {
      const hasActions = has(cur.actions, name);
      const hasButtons = has(cur.gamepadButtons, name);
      const hasAxis = has(cur.gamepadAxes, name);
      if (!hasActions && !hasButtons && !hasAxis) return null; // draft-only, nothing to persist
      const next = { ...cur };
      const patch: Partial<InputMappings> = {};
      if (hasActions) {
        next.actions = withoutKey(cur.actions, name);
        patch.actions = { [name]: [] }; // empty array = server-side delete
      }
      if (hasButtons) {
        next.gamepadButtons = withoutKey(cur.gamepadButtons, name);
        patch.gamepadButtons = next.gamepadButtons;
      }
      if (hasAxis) {
        next.gamepadAxes = withoutKey(cur.gamepadAxes, name);
        patch.gamepadAxes = next.gamepadAxes;
      }
      return { next, patch };
    });
  }

  function addAction() {
    const trimmed = newActionName.trim();
    if (!trimmed) return;
    const cur = localRef.current;
    if (!cur) return;
    const taken =
      has(cur.actions, trimmed) ||
      has(cur.gamepadButtons, trimmed) ||
      has(cur.gamepadAxes, trimmed) ||
      draftActionNames.includes(trimmed);
    if (taken) return;
    setDraftActionNames((prev) => [...prev, trimmed]);
    setNewActionName('');
  }

  function renameAxis(oldName: string, rawNewName: string) {
    const newName = rawNewName.trim();
    if (!newName || newName === oldName) return;
    applyEdit((cur) => {
      if (has(cur.axes, newName) || !has(cur.axes, oldName)) return null;
      const entry = cur.axes[oldName];
      const axes = withoutKey(cur.axes, oldName);
      axes[newName] = entry;
      return { next: { ...cur, axes }, patch: { axes } };
    });
  }

  function setAxisField(name: string, fieldPatch: Partial<VirtualAxis>) {
    applyEdit((cur) => {
      const current = cur.axes[name];
      if (!current) return null;
      const axes = { ...cur.axes, [name]: { ...current, ...fieldPatch } };
      return { next: { ...cur, axes }, patch: { axes } };
    });
  }

  function removeAxisCode(name: string, field: 'negativeCodes' | 'positiveCodes', code: string) {
    applyEdit((cur) => {
      const current = cur.axes[name];
      if (!current) return null;
      const axes = {
        ...cur.axes,
        [name]: { ...current, [field]: current[field].filter((c) => c !== code) },
      };
      return { next: { ...cur, axes }, patch: { axes } };
    });
  }

  function deleteAxis(name: string) {
    applyEdit((cur) => {
      const axes = withoutKey(cur.axes, name);
      return { next: { ...cur, axes }, patch: { axes } };
    });
  }

  function addAxis() {
    const trimmed = newAxisName.trim();
    if (!trimmed) return;
    applyEdit((cur) => {
      if (has(cur.axes, trimmed)) return null;
      const axes = { ...cur.axes, [trimmed]: { negativeCodes: [], positiveCodes: [] } };
      return { next: { ...cur, axes }, patch: { axes } };
    });
    setNewAxisName('');
  }

  function setGlobalDeadzone(value: number) {
    applyEdit((cur) => ({ next: { ...cur, deadzone: value }, patch: { deadzone: value } }));
  }

  const actionNames = Array.from(
    new Set([
      ...Object.keys(m.actions),
      ...Object.keys(m.gamepadButtons),
      ...Object.keys(m.gamepadAxes),
      ...draftActionNames,
    ]),
  ).sort();
  const axisNames = Object.keys(m.axes).sort();

  return (
    <>
      <div className="panel-header">
        <span>Input</span>
      </div>
      {editError && (
        <div className="code-conflict-banner">
          <Icon name="cross" size={13} />
          <span>That change didn't save: {editError}</span>
        </div>
      )}
      <div className="panel-body">
        <div className="diff-section">
          <h4>Actions</h4>
          {actionNames.length === 0 && (
            <div className="chip-list-empty">No actions yet — add one below and bind a key or gamepad button to it.</div>
          )}
          {actionNames.map((name) => (
            <ActionRow
              key={name}
              name={name}
              codes={m.actions[name] ?? []}
              gamepadNames={m.gamepadButtons[name] ?? []}
              axisBinding={m.gamepadAxes[name]}
              capturing={capture?.kind === 'action' && capture.name === name}
              onArmCapture={() => setCapture({ kind: 'action', name })}
              onCancelCapture={() => setCapture(null)}
              onRemoveCode={(code) => removeActionCode(name, code)}
              onAddGamepadButton={(btn) => addGamepadButton(name, btn)}
              onRemoveGamepadButton={(btn) => removeGamepadButton(name, btn)}
              onAddAxisBinding={() => addAxisBinding(name)}
              onRemoveAxisBinding={() => removeAxisBinding(name)}
              onSetAxisField={(fieldPatch) => setAxisBindingField(name, fieldPatch)}
              onDelete={() => setPendingDelete({ kind: 'action', name })}
            />
          ))}
          <div className="settings-add-row">
            <input
              className="input"
              placeholder="New action name…"
              value={newActionName}
              onChange={(e) => setNewActionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addAction();
              }}
            />
            <button className="btn btn-sm" onClick={addAction} disabled={!newActionName.trim()}>
              <Icon name="plus" size={10} /> Add action
            </button>
          </div>
        </div>

        <div className="diff-section">
          <h4>Virtual axes</h4>
          {axisNames.length === 0 && (
            <div className="chip-list-empty">
              No virtual axes yet — add one below for analog movement, like a joystick or WASD pair.
            </div>
          )}
          {axisNames.map((name) => (
            <AxisRow
              key={name}
              name={name}
              axis={m.axes[name]}
              globalDeadzone={m.deadzone}
              capturingNeg={capture?.kind === 'axis-neg' && capture.name === name}
              capturingPos={capture?.kind === 'axis-pos' && capture.name === name}
              onArmNeg={() => setCapture({ kind: 'axis-neg', name })}
              onArmPos={() => setCapture({ kind: 'axis-pos', name })}
              onCancelCapture={() => setCapture(null)}
              onRemoveNegCode={(code) => removeAxisCode(name, 'negativeCodes', code)}
              onRemovePosCode={(code) => removeAxisCode(name, 'positiveCodes', code)}
              onRename={(newName) => renameAxis(name, newName)}
              onSetGamepadAxis={(v) => setAxisField(name, { gamepadAxis: v })}
              onSetDeadzone={(v) => setAxisField(name, { deadzone: v })}
              onDelete={() => setPendingDelete({ kind: 'axis', name })}
            />
          ))}
          <div className="settings-add-row">
            <input
              className="input"
              placeholder="New axis name…"
              value={newAxisName}
              onChange={(e) => setNewAxisName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addAxis();
              }}
            />
            <button className="btn btn-sm" onClick={addAxis} disabled={!newAxisName.trim()}>
              <Icon name="plus" size={10} /> Add axis
            </button>
          </div>
        </div>

        <div className="diff-section">
          <h4>Global</h4>
          <div className="inspector-row">
            <label className="field-label">Deadzone</label>
            <NumberField value={m.deadzone} onCommit={setGlobalDeadzone} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        body={
          pendingDelete?.kind === 'axis'
            ? 'All of its key and gamepad-axis bindings are removed. This shows up in your undo history, so Ctrl/Cmd+Z brings it back.'
            : 'All of its key and gamepad bindings are removed. This shows up in your undo history, so Ctrl/Cmd+Z brings it back.'
        }
        confirmLabel={pendingDelete?.kind === 'axis' ? 'Delete axis' : 'Delete action'}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === 'axis') deleteAxis(pendingDelete.name);
          else deleteAction(pendingDelete.name);
          setPendingDelete(null);
        }}
      />
    </>
  );
}
