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
 * The outcome of avatar inference. `id` is the chosen entity (or null when none
 * can be picked); `ambiguous` is true only when several input-readers competed
 * and no `player`-tagged one broke the tie; `candidates` names them for a note.
 */
export interface AvatarResolution {
  id: string | null;
  ambiguous: boolean;
  candidates: string[];
}

/**
 * Resolve the avatar for a run without throwing. An explicit ref wins. Otherwise
 * we infer from script-bearing entities that reference `ctx.input`: a lone one
 * is the avatar; several are ambiguous, unless exactly one carries the `player`
 * tag, which breaks the tie. Steering policies turn an ambiguous result into a
 * hard error via {@link resolveAvatar}; mash/idle tolerate it and just note it.
 */
export async function resolveAvatarInfo(
  store: ProjectStore,
  session: GameSession,
  explicit?: string,
): Promise<AvatarResolution> {
  const runtime = session.runtime;

  if (explicit !== undefined) {
    const direct = runtime.find(explicit);
    if (direct) return { id: direct.id, ambiguous: false, candidates: [direct.name] };
    const tagged = runtime.findByTag(explicit);
    if (tagged.length > 0) return { id: tagged[0].id, ambiguous: false, candidates: [tagged[0].name] };
    throw new Error(`avatar "${explicit}" not found in scene "${session.currentSceneId}"`);
  }

  // Infer: script-bearing entities whose source references ctx.input.
  const candidates: { id: string; name: string; player: boolean }[] = [];
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
      candidates.push({ id: entity.id, name: entity.name, player: entity.tags.includes('player') });
    }
  }

  const names = candidates.map((c) => c.name);
  if (candidates.length === 0) return { id: null, ambiguous: false, candidates: [] };
  if (candidates.length === 1) return { id: candidates[0].id, ambiguous: false, candidates: names };

  // A single `player`-tagged candidate breaks the tie — the common intent.
  const tagged = candidates.filter((c) => c.player);
  if (tagged.length === 1) return { id: tagged[0].id, ambiguous: false, candidates: names };

  return { id: null, ambiguous: true, candidates: names };
}

/**
 * Resolve the avatar entity id for a run, or null when none can be inferred.
 * Throws on an unresolvable explicit ref, or — for steering policies that must
 * have a definite avatar — on an ambiguous inferred set.
 */
export async function resolveAvatar(
  store: ProjectStore,
  session: GameSession,
  explicit?: string,
  opts: { required?: boolean } = {},
): Promise<string | null> {
  const info = await resolveAvatarInfo(store, session, explicit);
  if (info.ambiguous && (opts.required ?? true)) {
    throw new Error(
      `avatar is ambiguous: ${info.candidates.length} input-reading entities ` +
        `(${info.candidates.join(', ')}); pass an explicit avatar`,
    );
  }
  return info.id;
}
