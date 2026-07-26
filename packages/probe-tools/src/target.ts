/**
 * Turning "what should I probe?" into the three separate things the rest of
 * this package needs, which are easy to conflate and wrong to merge:
 *
 * - `open`   — what @hearth/adapter-web is pointed at (a directory it serves,
 *              or a URL somebody else is already serving).
 * - `label`  — what lands in `SweepReport.target` and therefore in the repro
 *              string an agent copy-pastes back. Stable and absolute for
 *              directories; verbatim for URLs.
 * - `root`   — where `.hearth/evidence` is written. Defaults to the swept
 *              directory, because that is the project the Hearth app has open;
 *              a URL sweep has no such directory, so it falls back to cwd
 *              unless `--out` says otherwise.
 */
import path from 'node:path';

export interface TargetInput {
  /** Directory to serve and sweep. */
  dir?: string | undefined;
  /** A URL already being served. Wins over `dir` (mirrors openWebGame). */
  url?: string | undefined;
  /** Explicit evidence root. */
  out?: string | undefined;
  /** Base for relative paths. Defaults to process.cwd(). */
  cwd?: string | undefined;
}

export interface ResolvedTarget {
  /** What `SweepReport.target` records and repro strings name. */
  label: string;
  /** Passed straight to openWebGame. */
  open: { dir?: string; url?: string };
  /** Absolute path whose `.hearth/evidence` receives everything. */
  root: string;
  isUrl: boolean;
}

export function resolveTarget(input: TargetInput): ResolvedTarget {
  const cwd = input.cwd ?? process.cwd();
  const url = input.url?.trim();
  if (url) {
    const root = path.resolve(cwd, input.out ?? input.dir ?? '.');
    return { label: url, open: { url }, root, isUrl: true };
  }
  const dir = path.resolve(cwd, input.dir ?? '.');
  return {
    label: dir,
    open: { dir },
    root: path.resolve(cwd, input.out ?? dir),
    isUrl: false,
  };
}

/** POSIX-ish quoting, so a path with a space survives a copy-paste into a shell. */
export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * How a target is named on a `hearth-probe sweep` command line. A URL needs
 * the `--url` flag; a directory is the positional argument.
 */
export function targetArgs(label: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(label) ? `--url ${shellQuote(label)}` : shellQuote(label);
}
