/**
 * Interactive UI targets — where a bot should aim a click to drive a menu.
 *
 * The reason mash falsely "stuck" on menu scenes is that it clicked random
 * viewport points and essentially never landed on a centered button. Here we
 * enumerate the screen-space centers of every interactive UIElement (using the
 * same layout math the runtime uses to route real clicks), so mash can click
 * where something actually happens. A menu whose button works then advances;
 * one whose button is dead still stalls — which is the real bug.
 */
import { rectAtPosition, resolveUiPositions, type SceneRuntime } from '@hearth/runtime';

export interface UiPoint {
  x: number;
  y: number;
}

/** Screen-space centers of every enabled, interactive UIElement in the scene. */
export function interactiveUiCenters(runtime: SceneRuntime, width: number, height: number): UiPoint[] {
  const entities = runtime.getEntities();
  const positions = resolveUiPositions(entities, width, height);
  const centers: UiPoint[] = [];
  for (const entity of entities) {
    if (!entity.enabled || !entity.components.UIElement?.interactive) continue;
    const pos = positions.get(entity.id);
    if (!pos) continue;
    const rect = rectAtPosition(entity.components, pos);
    if (!rect) continue;
    centers.push({ x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 });
  }
  return centers;
}
