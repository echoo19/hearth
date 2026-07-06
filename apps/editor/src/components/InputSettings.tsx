/**
 * Input settings panel: keyboard/gamepad-button/gamepad-axis bindings per
 * action, virtual axes, and the global deadzone — no JSON textareas, every
 * control is typed (reuses NumberField/TextField from the Inspector).
 *
 * Every edit calls exec('updateSettings', { inputMappings }). Per Task 4's
 * settingsCommands.ts: `actions` merges per-action (an empty code array
 * removes that action), while `gamepadButtons`, `gamepadAxes`, `axes`, and
 * `deadzone` each replace that whole top-level key — so whenever one of
 * those four changes, the full updated map for that key is sent.
 *
 * Action names live across three maps (actions/gamepadButtons/gamepadAxes)
 * with no single owning key, and `actions` can't hold a zero-binding entry
 * (empty array = delete, per the merge rule above) — so a freshly "added"
 * action is tracked as a local draft name until its first real key or
 * gamepad-button binding lands, at which point it appears from the server
 * data and the draft is dropped.
 */
import React, { useEffect, useState } from 'react';
import { GAMEPAD_BUTTON_NAMES } from '@hearth/core';
import type { GamepadAxisBinding, InputMappings, VirtualAxis } from '@hearth/core';
import { useEditor } from '../store';
import { NumberField, TextField } from './Inspector';
import { Icon } from './ui';

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

const DEFAULT_AXIS_BINDING: GamepadAxisBinding = { axis: 0, direction: 1, threshold: 0.5 };

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
    <button
      type="button"
      className={`btn btn-sm${armed ? ' btn-capture-armed' : ''}`}
      onClick={armed ? onCancel : onArm}
    >
      {armed ? 'Press any key… (Esc to cancel)' : label}
    </button>
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

  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const [newActionName, setNewActionName] = useState('');
  const [newAxisName, setNewAxisName] = useState('');
  const [draftActionNames, setDraftActionNames] = useState<string[]>([]);

  const mappings = info?.inputMappings ?? null;

  // Drop a locally-drafted action name once it gets a real binding — it then
  // renders from `actions`/`gamepadButtons` like any other action.
  useEffect(() => {
    if (!mappings) return;
    setDraftActionNames((prev) =>
      prev.filter((n) => !mappings.actions[n]?.length && !mappings.gamepadButtons[n]?.length),
    );
  }, [mappings]);

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
    // recordCapturedCode is a plain function declared below, closing over the
    // latest `mappings`/`exec` from this render; the listener itself is torn
    // down and re-attached whenever `capture` changes, so it's always fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture]);

  if (!info || !mappings) {
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

  // A fresh, definitely-non-null binding: the narrowing above doesn't carry
  // into the function declarations below (they're hoisted, so TS can't prove
  // they only run after this guard), so closing over `m` instead of the
  // still-nullable `mappings` keeps every helper below error-free.
  const m: InputMappings = mappings;

  function patch(partial: Partial<InputMappings>) {
    void exec('updateSettings', { inputMappings: partial }, { quiet: true });
  }

  function recordCapturedCode(target: CaptureTarget, code: string) {
    if (target.kind === 'action') {
      const existing = m.actions[target.name] ?? [];
      if (existing.includes(code)) return;
      patch({ actions: { [target.name]: [...existing, code] } });
      return;
    }
    const axis = m.axes[target.name];
    if (!axis) return;
    const field = target.kind === 'axis-neg' ? 'negativeCodes' : 'positiveCodes';
    const existing = axis[field];
    if (existing.includes(code)) return;
    patch({ axes: { ...m.axes, [target.name]: { ...axis, [field]: [...existing, code] } } });
  }

  function removeActionCode(name: string, code: string) {
    const remaining = (m.actions[name] ?? []).filter((c) => c !== code);
    patch({ actions: { [name]: remaining } });
  }

  function addGamepadButton(name: string, buttonName: string) {
    const current = m.gamepadButtons[name] ?? [];
    if (current.includes(buttonName)) return;
    patch({ gamepadButtons: { ...m.gamepadButtons, [name]: [...current, buttonName] } });
  }

  function removeGamepadButton(name: string, buttonName: string) {
    const remaining = (m.gamepadButtons[name] ?? []).filter((b) => b !== buttonName);
    const next = withoutKey(m.gamepadButtons, name);
    if (remaining.length > 0) next[name] = remaining;
    patch({ gamepadButtons: next });
  }

  function addAxisBinding(name: string) {
    patch({ gamepadAxes: { ...m.gamepadAxes, [name]: DEFAULT_AXIS_BINDING } });
  }

  function removeAxisBinding(name: string) {
    patch({ gamepadAxes: withoutKey(m.gamepadAxes, name) });
  }

  function setAxisBindingField(name: string, fieldPatch: Partial<GamepadAxisBinding>) {
    const current = m.gamepadAxes[name];
    if (!current) return;
    patch({ gamepadAxes: { ...m.gamepadAxes, [name]: { ...current, ...fieldPatch } } });
  }

  function deleteAction(name: string) {
    setDraftActionNames((prev) => prev.filter((n) => n !== name));
    const hasActions = Object.prototype.hasOwnProperty.call(m.actions, name);
    const hasButtons = Object.prototype.hasOwnProperty.call(m.gamepadButtons, name);
    const hasAxis = Object.prototype.hasOwnProperty.call(m.gamepadAxes, name);
    if (!hasActions && !hasButtons && !hasAxis) return; // was draft-only, nothing to persist
    const partial: Partial<InputMappings> = {};
    if (hasActions) partial.actions = { [name]: [] };
    if (hasButtons) partial.gamepadButtons = withoutKey(m.gamepadButtons, name);
    if (hasAxis) partial.gamepadAxes = withoutKey(m.gamepadAxes, name);
    patch(partial);
  }

  function addAction() {
    const trimmed = newActionName.trim();
    if (!trimmed) return;
    const taken =
      Object.prototype.hasOwnProperty.call(m.actions, trimmed) ||
      Object.prototype.hasOwnProperty.call(m.gamepadButtons, trimmed) ||
      Object.prototype.hasOwnProperty.call(m.gamepadAxes, trimmed) ||
      draftActionNames.includes(trimmed);
    if (taken) return;
    setDraftActionNames((prev) => [...prev, trimmed]);
    setNewActionName('');
  }

  function renameAxis(oldName: string, rawNewName: string) {
    const newName = rawNewName.trim();
    if (!newName || newName === oldName || Object.prototype.hasOwnProperty.call(m.axes, newName)) return;
    const entry = m.axes[oldName];
    const next = withoutKey(m.axes, oldName);
    next[newName] = entry;
    patch({ axes: next });
  }

  function setAxisGamepadIndex(name: string, value: number | undefined) {
    const current = m.axes[name];
    if (!current) return;
    patch({ axes: { ...m.axes, [name]: { ...current, gamepadAxis: value } } });
  }

  function setAxisDeadzone(name: string, value: number | undefined) {
    const current = m.axes[name];
    if (!current) return;
    patch({ axes: { ...m.axes, [name]: { ...current, deadzone: value } } });
  }

  function removeAxisCode(name: string, field: 'negativeCodes' | 'positiveCodes', code: string) {
    const current = m.axes[name];
    if (!current) return;
    patch({ axes: { ...m.axes, [name]: { ...current, [field]: current[field].filter((c) => c !== code) } } });
  }

  function deleteAxis(name: string) {
    patch({ axes: withoutKey(m.axes, name) });
  }

  function addAxis() {
    const trimmed = newAxisName.trim();
    if (!trimmed || Object.prototype.hasOwnProperty.call(m.axes, trimmed)) return;
    patch({ axes: { ...m.axes, [trimmed]: { negativeCodes: [], positiveCodes: [] } } });
    setNewAxisName('');
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
      <div className="panel-body">
        <div className="diff-section">
          <h4>Actions</h4>
          {actionNames.length === 0 && <div className="chip-list-empty">No actions yet.</div>}
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
              onDelete={() => deleteAction(name)}
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
          {axisNames.length === 0 && <div className="chip-list-empty">No virtual axes yet.</div>}
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
              onSetGamepadAxis={(v) => setAxisGamepadIndex(name, v)}
              onSetDeadzone={(v) => setAxisDeadzone(name, v)}
              onDelete={() => deleteAxis(name)}
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
            <NumberField value={m.deadzone} onCommit={(v) => patch({ deadzone: v })} />
          </div>
        </div>
      </div>
    </>
  );
}
