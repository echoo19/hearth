/**
 * Desktop app-icon resolution. Converts a project's PNG icon into the
 * platform-native formats Electron packaging wants (`.icns` for macOS, `.ico`
 * for Windows, `.png` for Linux) via png2icons. Conversion is best-effort: if
 * the project ships no icon, or png2icons chokes on the input, we fall back to
 * the bundled default Hearth icons and never fail the build.
 */
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import png2icons from 'png2icons';

/** Absolute paths to icon files, one per platform family. */
export interface ResolvedIcons {
  icns: string;
  ico: string;
  png: string;
}

/** Directory holding the checked-in default icons (resolved from this module). */
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** The bundled fallback icons shipped inside the package. */
export function defaultIconPaths(): ResolvedIcons {
  return {
    icns: path.join(ASSETS_DIR, 'hearth.icns'),
    ico: path.join(ASSETS_DIR, 'hearth.ico'),
    png: path.join(ASSETS_DIR, 'hearth-icon.png'),
  };
}

export interface ResolveIconsOptions {
  /** Decoded project icon PNG. Absent → bundled defaults are used directly. */
  iconPng?: Uint8Array;
  /** Scratch directory for generated icon files. */
  workDir: string;
  /** Called with a human-readable message when conversion fails and we fall back. */
  onProgress?: (message: string) => void;
}

/**
 * Resolve the three platform icons for a build. With a valid `iconPng` the
 * icons are generated into `workDir`; on any failure (or absence) the bundled
 * defaults are returned instead.
 */
export async function resolveIcons(opts: ResolveIconsOptions): Promise<ResolvedIcons> {
  const { iconPng, workDir, onProgress } = opts;
  if (!iconPng) return defaultIconPaths();

  try {
    const src = Buffer.from(iconPng);
    const icns = png2icons.createICNS(src, png2icons.BICUBIC, 0);
    const ico = png2icons.createICO(src, png2icons.BICUBIC, 0, false);
    if (!icns || !ico) throw new Error('png2icons could not decode the icon PNG');

    await fsp.mkdir(workDir, { recursive: true });
    const out: ResolvedIcons = {
      icns: path.join(workDir, 'icon.icns'),
      ico: path.join(workDir, 'icon.ico'),
      png: path.join(workDir, 'icon.png'),
    };
    await fsp.writeFile(out.icns, icns);
    await fsp.writeFile(out.ico, ico);
    await fsp.writeFile(out.png, src);
    return out;
  } catch (err) {
    onProgress?.(`icon conversion failed, using the default Hearth icon: ${(err as Error).message}`);
    return defaultIconPaths();
  }
}
