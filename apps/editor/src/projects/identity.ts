/**
 * What a project looks like: one mark, one colour, and how a project that has
 * never been given either still gets both.
 *
 * A project is a game. In a rail listing six of them, the name alone is a wall
 * of same-looking text — the mark is what makes "the one with the red flame"
 * a thing you can say and then find. So identity is never optional and never
 * blank: it is derived from the project's own path the first time it is drawn,
 * which makes it distinct, stable across restarts, and free of any setup step.
 *
 * The marks come from the app's existing 12px icon set rather than a second
 * icon family, and the palette is one ring of equal-weight hues — deliberately
 * NOT graded, because no project is more important than another.
 *
 * Pure, and the palette is data, so both the derivation and the wrap-around
 * are testable without a DOM.
 */
import type { ProjectIdentity } from '../../server/projectIdentity';

export type { ProjectIdentity };

/**
 * The ring. Eight hues at one lightness and one chroma, spaced around the
 * wheel so no two read as versions of each other. They sit near — but never
 * on — the ember accent, which stays reserved for actions and selection: a
 * project must not be able to disguise itself as the app's own highlight.
 */
export const PROJECT_COLORS: { key: string; oklch: string }[] = [
  { key: 'coral', oklch: 'oklch(0.72 0.16 25)' },
  { key: 'amber', oklch: 'oklch(0.76 0.14 75)' },
  { key: 'moss', oklch: 'oklch(0.74 0.14 140)' },
  { key: 'teal', oklch: 'oklch(0.74 0.12 190)' },
  { key: 'sky', oklch: 'oklch(0.72 0.13 235)' },
  { key: 'iris', oklch: 'oklch(0.70 0.15 280)' },
  { key: 'orchid', oklch: 'oklch(0.72 0.16 320)' },
  { key: 'rose', oklch: 'oklch(0.72 0.15 355)' },
];

/**
 * The marks. Chosen from the icon set for silhouette rather than meaning — at
 * 14px what a reader recognises is the shape, and a project called "moss" does
 * not need a leaf. Twelve is enough that a rail of recents rarely repeats one.
 */
export const PROJECT_ICONS = [
  'flame',
  'star',
  'grid',
  'entity',
  'script',
  'camera',
  'light',
  'particles',
  'physics',
  'image',
  'audio',
  'prefab',
] as const;

/**
 * What to CALL each mark out loud.
 *
 * The ids above are icon-set keys, and several of them are engine vocabulary
 * ("entity", "prefab", "script") that means nothing to someone choosing a
 * picture for their game — a screen reader was reading this row as "entity,
 * prefab, script". Since the marks are picked for silhouette rather than
 * meaning, the spoken name is the silhouette.
 */
const MARK_LABELS: Record<string, string> = {
  flame: 'Flame',
  star: 'Star',
  grid: 'Grid',
  entity: 'Square',
  script: 'Brackets',
  camera: 'Camera',
  light: 'Sun',
  particles: 'Sparks',
  physics: 'Circle',
  image: 'Picture',
  audio: 'Speaker',
  prefab: 'Blocks',
};

/** The spoken name for a mark, falling back to the id rather than to nothing. */
export function markLabel(icon: string): string {
  return MARK_LABELS[icon] ?? icon;
}

/** The colour a key names, falling back to the first rather than to nothing. */
export function projectColorValue(key: string): string {
  return (PROJECT_COLORS.find((entry) => entry.key === key) ?? PROJECT_COLORS[0]).oklch;
}

/**
 * FNV-1a over the path. Any stable hash would do; what matters is that it is
 * deterministic across machines and sessions, so a project keeps its mark
 * without anything being written down.
 */
export function hashPath(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The mark and colour to draw, given what the project stored (if anything).
 * Stored values win per-field: someone who picked a colour and left the mark
 * alone keeps the derived mark rather than being reset to a default one.
 */
export function resolveIdentity(
  projectPath: string,
  stored?: ProjectIdentity | null,
): { icon: string; color: string; colorValue: string } {
  const hash = hashPath(projectPath);
  const icon =
    stored?.icon && (PROJECT_ICONS as readonly string[]).includes(stored.icon)
      ? stored.icon
      : PROJECT_ICONS[hash % PROJECT_ICONS.length];
  const color =
    stored?.color && PROJECT_COLORS.some((entry) => entry.key === stored.color)
      ? stored.color
      : // Shifted off the low bits so two projects sharing a mark rarely also
        // share a colour — the pair is what has to be distinct, not either half.
        PROJECT_COLORS[(hash >>> 8) % PROJECT_COLORS.length].key;
  return { icon, color, colorValue: projectColorValue(color) };
}
