/**
 * Avatar resolution — which entity the steering policies drive, and which
 * entity objectives and novelty tracking default to.
 *
 * Explicit wins: an `avatar` ref (id, name, or tag) resolves against the live
 * runtime. Otherwise we infer it by scanning the current scene's script-bearing
 * entities for `ctx.input` usage — a lone input-reading entity is the player.
 * Zero matches yields null (mash/idle tolerate that); more than one is
 * ambiguous and throws, listing the candidates so the caller can name one.
 */
import type { ProjectStore } from '@hearth/core';
import type { GameSession } from '@hearth/runtime';

/**
 * Resolve the avatar entity id for a run, or null when none can be inferred.
 * Throws on an unresolvable explicit ref, or on an ambiguous inferred set.
 */
export async function resolveAvatar(
  store: ProjectStore,
  session: GameSession,
  explicit?: string,
): Promise<string | null> {
  const runtime = session.runtime;

  if (explicit !== undefined) {
    const direct = runtime.find(explicit);
    if (direct) return direct.id;
    const tagged = runtime.findByTag(explicit);
    if (tagged.length > 0) return tagged[0].id;
    throw new Error(`avatar "${explicit}" not found in scene "${session.currentSceneId}"`);
  }

  // Infer: script-bearing entities whose source references ctx.input.
  const candidates: { id: string; name: string }[] = [];
  for (const entity of runtime.getEntities()) {
    const scriptPath = entity.components.Script?.scriptPath;
    if (!scriptPath) continue;
    let source: string;
    try {
      source = await store.readScript(scriptPath);
    } catch {
      continue;
    }
    if (source.includes('ctx.input')) {
      candidates.push({ id: entity.id, name: entity.name });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  const names = candidates.map((c) => c.name).join(', ');
  throw new Error(
    `avatar is ambiguous: ${candidates.length} input-reading entities (${names}); pass an explicit avatar`,
  );
}
