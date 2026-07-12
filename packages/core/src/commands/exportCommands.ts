/**
 * Web export: `exportWeb` produces a static, self-contained playable build —
 * index.html + hearth-player.js + project.bundle.json + assets/, or a single
 * inlined index.html. The player bundle itself is a built artifact of
 * @hearth/runtime; hosts (CLI, MCP server, editor server) provide it through
 * `CommandContext.resources.getPlayerBundle()`.
 */
import { z } from 'zod';
import { defineCommand, type CommandContext, type DesktopBuildSpec, type DesktopPlatform } from './types.js';
import { ProjectError } from '../project/store.js';
import { joinPath, dirnamePath, isSafeOut } from '../fs.js';
import { slugify } from '../ids.js';
import { validateProject } from '../validate.js';
import type { Scene } from '../schema/scene.js';

/** Project bundle shape consumed by HearthPlayer.boot({ mount, bundle }). */
export interface WebExportBundle {
  project: unknown;
  scenes: Scene[];
  scripts: Record<string, string>;
  assets: {
    id: string;
    name: string;
    type: string;
    path?: string;
    dataUri?: string;
    /**
     * Asset.metadata (e.g. sliceSpritesheet's frames/grid) — carried through
     * so the played build can resolve SpriteRenderer.frame sheet refs; without
     * this the player's reconstructed store always has metadata: {} and every
     * sheet frame lookup fails.
     */
    metadata?: Record<string, unknown>;
  }[];
}

const PLAYER_LOCATIONS_HINT =
  'Expected locations: $HEARTH_TOOLS_DIR/hearth-player.js (packaged app) or ' +
  'packages/runtime/player/hearth-player.js (repo checkout; build it with the runtime player build step).';

const MIME_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  json: 'application/json',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// Browser-safe base64 (core cannot use node:Buffer).
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : '=';
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Prevent inlined JS/JSON from terminating its enclosing <script> tag.
 * `<\/script` is a valid escape inside both JS and JSON string literals,
 * which is the only place `</script` can legally appear in either.
 */
function escapeScriptContent(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * Only allow CSS color-ish values into the inline stylesheet; anything that
 * could break out of the declaration (";", "}", "<", quotes) falls back to
 * the neutral default.
 */
function safeCssColor(color: string, fallback: string): string {
  return /^[#(),.%a-zA-Z0-9\s-]+$/.test(color) ? color : fallback;
}

/** Legible neutral foreground for error text on the loading background. */
function loadingForeground(backgroundColor: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(backgroundColor.trim())?.[1]
    ?? /^#([0-9a-f]{3})$/i.exec(backgroundColor.trim())?.[1]?.replace(/(.)/g, '$1$1');
  if (!hex) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000000' : '#ffffff';
}

/**
 * The exported page. Deliberately unbranded: the only visuals are the
 * user-controlled loading background (buildSettings.loading) and, on
 * failure, a plain error message. Boot logic is inline, no external
 * requests; the player handles the loading layer and letterbox scaling.
 */
function renderIndexHtml(opts: {
  title: string;
  /** buildSettings.loading.backgroundColor — page + status background. */
  background: string;
  /** When set, the player source is inlined instead of loaded from a file. */
  inlinePlayer?: string;
  /** When set, the bundle is inlined instead of fetched. */
  inlineBundleJson?: string;
}): string {
  const title = escapeHtml(opts.title);
  const bg = safeCssColor(opts.background, '#000000');
  const fg = loadingForeground(bg);
  const boot = opts.inlinePlayer !== undefined && opts.inlineBundleJson !== undefined
    ? [
        `  <script>${escapeScriptContent(opts.inlinePlayer)}</script>`,
        '  <script>',
        `    var bundle = ${escapeScriptContent(opts.inlineBundleJson)};`,
        '    hearthBoot(function (ready) { ready(bundle); });',
        '  </script>',
      ].join('\n')
    : [
        '  <script>',
        "    hearthBoot(function (ready, fail) {",
        "      fetch('project.bundle.json')",
        "        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })",
        '        .then(function (bundle) {',
        "          var script = document.createElement('script');",
        "          script.src = 'hearth-player.js';",
        '          script.onload = function () { ready(bundle); };',
        "          script.onerror = function () { fail('Failed to load hearth-player.js'); };",
        '          document.body.appendChild(script);',
        '        })',
        "        .catch(function (err) { fail('Failed to load project.bundle.json: ' + err.message); });",
        '    });',
        '  </script>',
      ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { background: ${bg}; font-family: system-ui, sans-serif; overflow: hidden; }
    #hearth-mount { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
    #hearth-status { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; background: ${bg}; z-index: 10; }
    #hearth-status-text { display: none; font-size: 13px; color: ${fg}; opacity: 0.85; max-width: 40em; padding: 0 16px; }
    #hearth-status-text.error { display: block; }
    #hearth-fullscreen { position: fixed; right: 14px; bottom: 14px; z-index: 20; background: transparent; color: ${fg}; opacity: 0.4; border: 1px solid ${fg}; border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 12px; cursor: pointer; }
    #hearth-fullscreen:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div id="hearth-mount"></div>
  <div id="hearth-status">
    <p id="hearth-status-text"></p>
  </div>
  <button id="hearth-fullscreen" type="button" title="Toggle fullscreen">Fullscreen</button>
  <script>
    function hearthBoot(load) {
      var mount = document.getElementById('hearth-mount');
      var status = document.getElementById('hearth-status');
      var statusText = document.getElementById('hearth-status-text');
      function fail(message) {
        statusText.textContent = message;
        statusText.className = 'error';
      }
      function ready(bundle) {
        if (!window.HearthPlayer || typeof window.HearthPlayer.boot !== 'function') {
          return fail('hearth-player.js did not define window.HearthPlayer.boot');
        }
        status.remove();
        try {
          window.HearthPlayer.boot({ mount: mount, bundle: bundle });
        } catch (err) {
          document.body.appendChild(status);
          fail('Failed to start: ' + (err && err.message ? err.message : err));
        }
      }
      try {
        load(ready, fail);
      } catch (err) {
        fail('Failed to start: ' + (err && err.message ? err.message : err));
      }
      document.getElementById('hearth-fullscreen').addEventListener('click', function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      });
    }
  </script>
${boot}
</body>
</html>
`;
}

async function buildBundle(ctx: CommandContext, inlineAssets: boolean): Promise<WebExportBundle> {
  const store = ctx.store;
  const scenes = store.project.scenes
    .map((ref) => store.scenes.get(ref.id))
    .filter((s): s is Scene => s !== undefined);
  const scripts: Record<string, string> = {};
  for (const path of await store.listScripts()) {
    scripts[path] = await store.readScript(path);
  }
  // Every project asset ships, whether or not a scene references it — this
  // is what guarantees buildSettings.loading.image is present in the bundle
  // for the player's loading layer (exportLoading.test.ts locks this in).
  const assets: WebExportBundle['assets'] = [];
  for (const asset of store.assets.assets) {
    if (inlineAssets) {
      const bytes = await ctx.fs.readFileBinary(joinPath(store.root, asset.path));
      assets.push({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        dataUri: `data:${mimeFor(asset.path)};base64,${toBase64(bytes)}`,
        metadata: asset.metadata,
      });
    } else {
      assets.push({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        path: asset.path,
        metadata: asset.metadata,
      });
    }
  }
  return { project: store.project, scenes, scripts, assets };
}

async function loadPlayerSource(ctx: CommandContext): Promise<string> {
  if (!ctx.resources?.getPlayerBundle) {
    throw new ProjectError(
      `exportWeb needs the built web player, but this host did not provide one (no resources.getPlayerBundle). ${PLAYER_LOCATIONS_HINT}`,
      'MISSING_RESOURCE',
    );
  }
  try {
    return await ctx.resources.getPlayerBundle();
  } catch (err) {
    throw new ProjectError(
      `exportWeb could not load the web player bundle: ${(err as Error).message} ${PLAYER_LOCATIONS_HINT}`,
      'MISSING_RESOURCE',
    );
  }
}

/**
 * Assemble the in-memory web build — the shared assembly path behind both
 * `exportWeb` (writes these files to a project folder) and `exportDesktop`
 * (hands them to a host packager for wrapping in a native shell). Returns the
 * files as `{ path, content }` pairs relative to the build root, so `index.html`
 * sits at the root. Callers gate on `validateProject` themselves.
 *
 * - `inlinePlayer`: inline the player source + bundle into `index.html`
 *   (single file), instead of emitting `hearth-player.js` + `project.bundle.json`.
 * - `inlineAssets`: inline assets as data URIs in the bundle, instead of
 *   shipping each asset as its own file the player fetches.
 */
export async function assembleWebBuild(
  ctx: CommandContext,
  opts: { inlineAssets: boolean; inlinePlayer: boolean },
): Promise<{ files: Array<{ path: string; content: string | Uint8Array }>; slug: string; title: string }> {
  const playerSource = await loadPlayerSource(ctx);
  const title = ctx.store.project.buildSettings.title || ctx.store.project.name;
  const background = ctx.store.project.buildSettings.loading.backgroundColor;
  const slug = slugify(ctx.store.project.name);
  const bundle = await buildBundle(ctx, opts.inlineAssets);

  const files: Array<{ path: string; content: string | Uint8Array }> = [];
  if (opts.inlinePlayer) {
    files.push({
      path: 'index.html',
      content: renderIndexHtml({
        title,
        background,
        inlinePlayer: playerSource,
        inlineBundleJson: JSON.stringify(bundle),
      }),
    });
  } else {
    files.push({ path: 'index.html', content: renderIndexHtml({ title, background }) });
    files.push({ path: 'hearth-player.js', content: playerSource });
    files.push({ path: 'project.bundle.json', content: JSON.stringify(bundle, null, 2) + '\n' });
  }

  // Non-inlined assets ship as their own files (the player fetches them).
  if (!opts.inlineAssets) {
    for (const asset of ctx.store.assets.assets) {
      const bytes = await ctx.fs.readFileBinary(joinPath(ctx.store.root, asset.path));
      files.push({ path: asset.path, content: bytes });
    }
  }

  return { files, slug, title };
}

export const exportWeb = defineCommand({
  name: 'exportWeb',
  description:
    'Export a production web build: a static, self-contained playable page (index.html + hearth-player.js + ' +
    'project.bundle.json + assets/). With singleFile=true, one index.html with the player inlined and assets as data URIs. ' +
    'Validates the project first.',
  permission: 'build',
  mutates: false,
  paramsSchema: z.object({
    outDir: z.string().default('export/web'),
    singleFile: z.boolean().default(false),
  }),
  async run(ctx, params) {
    if (!isSafeOut(params.outDir)) {
      throw new ProjectError(`Export outDir must be a project-relative path (got: ${params.outDir})`, 'INVALID_INPUT');
    }
    const report = await validateProject(ctx.store);
    if (!report.valid) {
      throw new ProjectError(
        `Cannot export: project has ${report.errors.length} validation error(s). Run validateProject for details.`,
        'SCHEMA_ERROR',
      );
    }

    const { files, slug, title } = await assembleWebBuild(ctx, {
      inlineAssets: params.singleFile,
      inlinePlayer: params.singleFile,
    });

    const outRoot = joinPath(ctx.store.root, params.outDir);
    await ctx.fs.mkdir(outRoot);
    const written: string[] = [];
    for (const file of files) {
      const dest = joinPath(outRoot, file.path);
      await ctx.fs.mkdir(dirnamePath(dest));
      await ctx.fs.writeFile(dest, file.content);
      written.push(joinPath(params.outDir, file.path));
    }

    ctx.changed({ kind: 'file', path: params.outDir, action: 'created' });
    return {
      outDir: params.outDir,
      singleFile: params.singleFile,
      files: written,
      title,
      slug,
    };
  },
});

const DESKTOP_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const;

export const exportDesktop = defineCommand({
  name: 'exportDesktop',
  description:
    'Export native desktop builds: wraps the web build in an Electron shell and zips one app per platform ' +
    '(darwin-arm64, darwin-x64, win32-x64, linux-x64). Uses buildSettings.icon (a sprite asset) as the app icon. ' +
    'Validates the project first. Requires a host with a desktop packager (CLI, MCP server, or editor).',
  permission: 'build',
  mutates: false,
  paramsSchema: z.object({
    outDir: z.string().default('export/desktop'),
    platforms: z
      .array(z.enum(DESKTOP_PLATFORMS))
      .min(1)
      .default([...DESKTOP_PLATFORMS]),
  }),
  async run(ctx, params) {
    if (!isSafeOut(params.outDir)) {
      throw new ProjectError(`Export outDir must be a project-relative path (got: ${params.outDir})`, 'INVALID_INPUT');
    }
    const report = await validateProject(ctx.store);
    if (!report.valid) {
      throw new ProjectError(
        `Cannot export: project has ${report.errors.length} validation error(s). Run validateProject for details.`,
        'SCHEMA_ERROR',
      );
    }

    if (!ctx.resources?.packageDesktop) {
      throw new ProjectError(
        'exportDesktop needs a desktop packager, but this host did not provide one (no resources.packageDesktop). ' +
          'Desktop export is supported by the Hearth CLI, MCP server, and editor.',
        'DESKTOP_EXPORT_UNSUPPORTED',
      );
    }

    const { files, slug, title } = await assembleWebBuild(ctx, { inlineAssets: false, inlinePlayer: false });

    // Resolve + decode the project icon (a sprite asset) when set.
    let iconPng: Uint8Array | undefined;
    const iconId = ctx.store.project.buildSettings.icon;
    if (iconId) {
      const asset = ctx.store.getAsset(iconId);
      if (!asset) {
        throw new ProjectError(`buildSettings.icon references an unknown asset: ${iconId}`, 'NOT_FOUND');
      }
      if (asset.type !== 'sprite') {
        throw new ProjectError(
          `buildSettings.icon must be a sprite asset, but ${iconId} is a "${asset.type}" asset`,
          'INVALID_INPUT',
        );
      }
      iconPng = await ctx.fs.readFileBinary(joinPath(ctx.store.root, asset.path));
    }

    const bs = ctx.store.project.buildSettings;
    const platforms = params.platforms as DesktopPlatform[];
    const spec: DesktopBuildSpec = {
      files,
      slug,
      title,
      width: bs.width,
      height: bs.height,
      outDirAbs: joinPath(ctx.store.root, params.outDir),
      platforms,
      ...(iconPng ? { iconPng } : {}),
    };
    const builds = await ctx.resources.packageDesktop(spec);

    ctx.changed({ kind: 'file', path: params.outDir, action: 'created' });
    return { outDir: params.outDir, slug, builds };
  },
});
