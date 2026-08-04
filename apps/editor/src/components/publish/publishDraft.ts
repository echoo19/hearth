/**
 * The listing someone is writing, and the rules about it — kept out of the
 * dialog so that both outlive it.
 *
 * Two reasons this is a module and not `useState` in the component:
 *
 *  1. **Nothing a person typed may be lost.** `Modal` renders its children
 *     only while open, so every field in the dialog is unmounted the moment it
 *     closes. A draft held in the form would be gone on the way out — and a
 *     description is not something anyone wants to write twice. The draft is
 *     held here, keyed by project folder, for as long as the app is running.
 *     It is deliberately NOT persisted to disk: a half-written listing is a
 *     thought in progress, not a document, and restoring one three days later
 *     next to a folder that has changed underneath it would be a worse answer
 *     than a clean form.
 *  2. The rules are checkable without a DOM. What counts as publishable, and
 *     what the server actually gets sent, are the two things worth being sure
 *     about, so they are pure functions here rather than conditions buried in
 *     JSX.
 *
 * `tagText` lives in the draft alongside the committed tags for the same
 * reason the rest of it does: a tag half-typed when the dialog closed is still
 * something a person typed. It is committed on submit (see `draftToRequest`),
 * so a tag that was never turned into a chip still reaches the catalog.
 */
import type { CatalogProjectInfo, PublishRequest } from '../../api';

/** Everything the person controls about the listing. */
export interface PublishDraft {
  title: string;
  tagline: string;
  description: string;
  instructions: string;
  tags: string[];
  /** Uncommitted text sitting in the tag input. Committed on submit. */
  tagText: string;
  /** Project-relative path of the cover, or '' for none. */
  coverPath: string;
}

/** A blank listing. Exported for tests and for the seeding path below. */
export function emptyDraft(): PublishDraft {
  return {
    title: '',
    tagline: '',
    description: '',
    instructions: '',
    tags: [],
    tagText: '',
    coverPath: '',
  };
}

// Keyed by project folder: two folders open in one session are two listings,
// and neither should ever see the other's words.
const DRAFTS = new Map<string, PublishDraft>();

/**
 * The draft to open with. A stored one wins outright, including a stored one
 * whose title is empty — someone who cleared the suggested title did that on
 * purpose, and re-suggesting it would be the dialog arguing with them.
 */
export function draftForProject(project: string, info: CatalogProjectInfo | null): PublishDraft {
  const stored = DRAFTS.get(project);
  if (stored) return stored;
  return { ...emptyDraft(), title: info?.suggestedTitle ?? '' };
}

/** Keep what has been typed so far. Called on every edit. */
export function rememberDraft(project: string, draft: PublishDraft): void {
  DRAFTS.set(project, draft);
}

/**
 * Nothing clears a draft, deliberately — not even a successful publish. The
 * listing that went out IS the draft, and the next publish from this folder is
 * an UPDATE to it. Clearing on success would send the next one back to the
 * folder name, which would quietly rename a game that already has a name.
 *
 * Test seam: forget every draft.
 */
export function resetDrafts(): void {
  DRAFTS.clear();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * The one thing a listing cannot go without. Everything else on the form is
 * genuinely optional, and inventing more required fields here would be this
 * dialog enforcing rules the catalog never asked for.
 */
export const TITLE_REQUIRED = 'Give the listing a title. It is the name people will see.';

/** The problem with the title, or null when there isn't one. */
export function titleProblem(title: string): string | null {
  return title.trim() === '' ? TITLE_REQUIRED : null;
}

/** Whether this folder has been published before, and so is being updated. */
export function isUpdate(info: CatalogProjectInfo | null): boolean {
  return info?.published != null;
}

/** Whether there is a game here at all. Null info means "not known yet". */
export function hasGame(info: CatalogProjectInfo | null): boolean {
  return info?.entry != null;
}

/**
 * Add a tag, if it is one. Trims, ignores blanks, and refuses a duplicate
 * case-insensitively while keeping the casing already on screen — retyping
 * "Puzzle" when "puzzle" is already a chip should not quietly make two tags
 * that the catalog would then show side by side.
 */
export function addTag(tags: readonly string[], raw: string): string[] {
  const tag = raw.trim();
  if (tag === '') return [...tags];
  const seen = tags.some((existing) => existing.toLowerCase() === tag.toLowerCase());
  return seen ? [...tags] : [...tags, tag];
}

/** Remove a tag by exact value. */
export function removeTag(tags: readonly string[], tag: string): string[] {
  return tags.filter((existing) => existing !== tag);
}

/**
 * What actually gets sent.
 *
 * Empty optional fields are left OFF the request rather than sent as empty
 * strings: on an update, `tagline: ''` is a request to erase the tagline,
 * while an absent key is "leave it as it is". Someone who never touched the
 * field meant the second one.
 *
 * The uncommitted tag text is committed here, which is the whole reason it is
 * carried in the draft — a tag typed and then submitted without pressing Enter
 * is not a tag anyone intended to throw away.
 */
export function draftToRequest(project: string, draft: PublishDraft): PublishRequest {
  const request: PublishRequest = {
    project,
    title: draft.title.trim(),
  };
  const tagline = draft.tagline.trim();
  if (tagline !== '') request.tagline = tagline;
  const description = draft.description.trim();
  if (description !== '') request.description = description;
  const instructions = draft.instructions.trim();
  if (instructions !== '') request.instructions = instructions;
  const tags = addTag(draft.tags, draft.tagText);
  if (tags.length > 0) request.tags = tags;
  if (draft.coverPath !== '') request.coverPath = draft.coverPath;
  return request;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Bytes in the units a person reads. One decimal place past KB, because
 * "1.2 MB" is a size and "1.234567 MB" is a measurement nobody asked for.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "24 files" / "1 file" — the count with its noun agreeing. */
export function formatFileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** Extensions the cover picker will offer. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];

/** Which of a project's files could be a cover image. */
export function imageFiles(paths: readonly string[]): string[] {
  return paths
    .filter((path) => {
      const lower = path.toLowerCase();
      return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
    })
    .sort((a, b) => a.localeCompare(b));
}
