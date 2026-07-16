/**
 * The ONE "New state machine" dialog (T9-U8, unifying the two parallel copies
 * that grew in AnimatorEditor (T8-B6 / ANIMATOR-3) and AssetsPanel (T9-U3 /
 * L-084's follow-up) — same seed payload, same error presentation, one file).
 *
 * `createStateMachineAsset` requires ≥1 state whose animation resolves to a
 * real animation asset, so the dialog seeds a single `idle` state on the first
 * available animation and opens the new machine in the Animator. Command
 * failures (e.g. a name CONFLICT) render inline under the name field — the
 * field-level `.invalid` + `.field-error` idiom every create dialog uses.
 */
import React, { useState } from 'react';
import { useEditor } from '../store';
import { Modal } from './ui';
import { Button } from './ui/Button';

/** The createStateMachineAsset params seeding one `idle` state (pure, for tests). */
export function seedStateMachinePayload(name: string, firstAnimationId: string): {
  name: string;
  data: {
    params: Record<string, never>;
    states: { name: string; animation: string; speed: number }[];
    initial: string;
    transitions: never[];
  };
} {
  return {
    name,
    data: {
      params: {},
      states: [{ name: 'idle', animation: firstAnimationId, speed: 1 }],
      initial: 'idle',
      transitions: [],
    },
  };
}

export function CreateStateMachineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assets = useEditor((s) => s.assets);
  const exec = useEditor((s) => s.exec);
  const openAnimatorFor = useEditor((s) => s.openAnimatorFor);

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const animationAssets = assets.filter((a) => a.type === 'animation');

  function close() {
    setError(null);
    onClose();
  }

  async function create() {
    const trimmed = name.trim();
    const firstAnim = animationAssets[0];
    if (!trimmed || !firstAnim) return;
    setCreating(true);
    const result = await exec<{ assetId: string }>(
      'createStateMachineAsset',
      seedStateMachinePayload(trimmed, firstAnim.id),
    );
    setCreating(false);
    if (result.success && result.data) {
      setName('');
      setError(null);
      onClose();
      openAnimatorFor(result.data.assetId);
    } else {
      setError(result.errors[0]?.message ?? 'Could not create the state machine.');
    }
  }

  return (
    <Modal open={open} title="New state machine" onClose={close}>
      <div className="modal-body">
        <div className="form-field">
          <label className="field-label" htmlFor="create-sm-name">
            Name
          </label>
          <input
            id="create-sm-name"
            className={`input${error ? ' invalid' : ''}`}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            autoFocus
            placeholder="courier-motion"
          />
          {error && <span className="field-error">{error}</span>}
        </div>
        {animationAssets.length === 0 ? (
          <p className="animator-empty">
            A state machine needs at least one animation asset to drive. Create an animation first, then come
            back.
          </p>
        ) : (
          <p className="animator-empty">
            Seeds one "idle" state on "{animationAssets[0].name}". Add params, states, and transitions after it
            opens in the Animator.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!name.trim() || animationAssets.length === 0 || creating}
          onClick={() => void create()}
        >
          {creating ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </Modal>
  );
}
