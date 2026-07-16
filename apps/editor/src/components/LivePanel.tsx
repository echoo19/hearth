/**
 * Live panel (Task 9): read-only runtime inspector for the running game.
 * Polls the mounted PixiSceneView's SceneRuntime at 10Hz — only while this
 * panel is actually visible (see LivePanelHost in Workspace.tsx) and a run
 * is playing — and shows one entity's live transform/velocity/timers/tweens
 * plus the most recent scene-wide events. Entirely typed rows, no raw JSON:
 * every value here is a specific field pulled off the runtime, not a dump.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { getGameView } from '../gameViewRef';
import type { RuntimeEntityHandle, RuntimeEventRecord, RuntimeSchedulerSnapshot } from '../runtimeBridge';
import { Icon } from './ui';
import { Button } from './ui/Button';

const POLL_MS = 100;
const MAX_EVENTS = 10;

interface LiveSnapshot {
  frame: number;
  entityCount: number;
  entities: { id: string; name: string }[];
  selected: RuntimeEntityHandle | null;
  worldPosition: { x: number; y: number } | null;
  scheduler: RuntimeSchedulerSnapshot | null;
  events: RuntimeEventRecord[];
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '-';
}

export function LivePanel({ visible }: { visible: boolean }) {
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const storeSelection = useEditor((s) => s.selection);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  // Mirrors `entityId` for the interval callback so it always reads the
  // latest pick without needing to restart the interval on every selection.
  const entityIdRef = useRef<string | null>(null);
  entityIdRef.current = entityId;

  useEffect(() => {
    if (!playing) {
      setSnapshot(null);
      setEntityId(null);
      return;
    }
    if (!visible) return;

    const tick = () => {
      const runtime = getGameView()?.runtime;
      if (!runtime) return;
      const entities = runtime.getEntities();

      // Seed (or recover) the selected entity: keep the current pick while
      // it's still live; otherwise fall back to the scene selection (when it
      // matches a live entity — spawned entities included) or the first one.
      let id = entityIdRef.current;
      if (!id || !entities.some((e) => e.id === id)) {
        id =
          storeSelection && entities.some((e) => e.id === storeSelection)
            ? storeSelection
            : (entities[0]?.id ?? null);
        entityIdRef.current = id;
        setEntityId(id);
      }

      const selected = id ? (entities.find((e) => e.id === id) ?? null) : null;
      setSnapshot({
        frame: runtime.frame,
        entityCount: entities.length,
        entities: entities.map((e) => ({ id: e.id, name: e.name })),
        selected,
        worldPosition: selected ? runtime.getWorldPosition(selected) : null,
        scheduler: selected ? runtime.getSchedulerSnapshot(selected.id) : null,
        events: runtime.events.slice(-MAX_EVENTS).reverse(),
      });
    };

    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
    // storeSelection only re-seeds a fresh pick (id is null/stale); re-running
    // this effect on every selection change while already playing would
    // fight the user's own choice in the panel's entity dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, visible]);

  function selectEntity(id: string) {
    entityIdRef.current = id;
    setEntityId(id);
  }

  if (!playing) {
    return (
      <>
        <div className="panel-toolbar">
          <span className="live-summary">Live</span>
        </div>
        <div className="panel-body">
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="play" size={16} />
            </span>
            <span>Nothing running to inspect.</span>
            <span className="hint">
              Shows the live transform, velocity, timers, tweens, and recent events of any entity in the running
              scene, including ones spawned at runtime.
            </span>
            <Button size="sm" icon="play" onClick={() => setPlaying(true)}>
              Play
            </Button>
          </div>
        </div>
      </>
    );
  }

  const entity = snapshot?.selected ?? null;
  const velocity = entity?.components.PhysicsBody?.velocity ?? null;
  const timers = snapshot?.scheduler?.timers ?? [];
  const tweens = snapshot?.scheduler?.tweens ?? [];
  const events = snapshot?.events ?? [];

  return (
    <>
      <div className="panel-toolbar">
        <select
          className="select"
          value={entityId ?? ''}
          onChange={(e) => selectEntity(e.target.value)}
          disabled={!snapshot || snapshot.entities.length === 0}
          aria-label="Entity"
          style={{ maxWidth: 200 }}
        >
          {(snapshot?.entities ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <span className="live-summary">
          Frame {snapshot?.frame ?? 0} · {snapshot?.entityCount ?? 0} {snapshot?.entityCount === 1 ? 'entity' : 'entities'}
        </span>
      </div>
      <div className="panel-body">
        {!snapshot ? (
          <div className="empty-state">
            <span>Starting the game preview…</span>
          </div>
        ) : !entity ? (
          <div className="empty-state">
            <span>No entities in the running scene.</span>
          </div>
        ) : (
          <>
            <div className="inspector-section">
              <div className="inspector-row">
                <label className="field-label">Name</label>
                <span className="mono">{entity.name}</span>
              </div>
              <div className="inspector-row">
                <label className="field-label">ID</label>
                <span className="mono">{entity.id}</span>
              </div>
              <div className="inspector-row">
                <label className="field-label">Tags</label>
                <span>{entity.tags.length > 0 ? entity.tags.join(', ') : '-'}</span>
              </div>
              <div className="inspector-row">
                <label className="field-label">Enabled</label>
                <span>{entity.enabled ? 'Yes' : 'No'}</span>
              </div>
              <div className="inspector-row">
                <label className="field-label">World pos</label>
                <span className="mono">
                  x: {fmtNum(snapshot.worldPosition?.x ?? 0)}, y: {fmtNum(snapshot.worldPosition?.y ?? 0)}
                </span>
              </div>
              {velocity && (
                <div className="inspector-row">
                  <label className="field-label">Velocity</label>
                  <span className="mono">
                    x: {fmtNum(velocity.x)}, y: {fmtNum(velocity.y)}
                  </span>
                </div>
              )}
            </div>

            <div className="component-card">
              <div className="component-header">
                <span className="component-title">Timers ({timers.length})</span>
              </div>
              <div className="component-body">
                {timers.length === 0 ? (
                  <span className="hint">No pending timers.</span>
                ) : (
                  <div className="live-table live-table-timers">
                    <div className="live-table-head">
                      <span>Interval</span>
                      <span>Remaining</span>
                      <span>Repeats</span>
                    </div>
                    {timers.map((t) => (
                      <div className="live-table-row mono" key={t.id}>
                        <span>{fmtNum(t.interval)}s</span>
                        <span>{fmtNum(t.remaining)}s</span>
                        <span>{t.repeat ? 'Yes' : 'No'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="component-card">
              <div className="component-header">
                <span className="component-title">Tweens ({tweens.length})</span>
              </div>
              <div className="component-body">
                {tweens.length === 0 ? (
                  <span className="hint">No active tweens.</span>
                ) : (
                  <div className="live-table live-table-tweens">
                    <div className="live-table-head">
                      <span>Property</span>
                      <span>Progress</span>
                      <span>From</span>
                      <span>To</span>
                    </div>
                    {tweens.map((t) => (
                      <div className="live-table-row mono" key={t.id}>
                        <span>{t.key}</span>
                        <span>{t.duration > 0 ? Math.min(100, Math.round((t.elapsed / t.duration) * 100)) : 100}%</span>
                        <span>{fmtNum(t.from)}</span>
                        <span>{fmtNum(t.to)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="component-card">
              <div className="component-header">
                <span className="component-title">Recent events</span>
              </div>
              <div className="component-body">
                {events.length === 0 ? (
                  <span className="hint">No events recorded yet.</span>
                ) : (
                  <div className="live-events-list">
                    {events.map((e, i) => (
                      <div className="live-event-row mono" key={`${e.frame}-${e.name}-${i}`}>
                        <span>{e.name}</span>
                        <span className="live-event-frame">frame {e.frame}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
