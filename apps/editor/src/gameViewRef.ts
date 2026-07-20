/**
 * Module-level handle to the currently-mounted game preview. A few
 * chrome pieces outside GamePreview's own tree — the Toolbar's Pause/Step
 * buttons, the Live inspector panel — need to reach the live PixiSceneView
 * without prop-drilling it through the workspace layout. GamePreview owns
 * the mount/unmount lifecycle and is the only writer; everyone else only
 * reads it.
 */
import type { MountedGameView } from './runtimeBridge';

let current: MountedGameView | null = null;

/** Set by GamePreview on mount, cleared (null) on unmount/Stop. */
export function setGameView(view: MountedGameView | null): void {
  current = view;
}

/** The live game view, or null when no preview is mounted. */
export function getGameView(): MountedGameView | null {
  return current;
}
