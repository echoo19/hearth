/**
 * Web export: `exportWeb` produces a static, self-contained playable build —
 * index.html + hearth-player.js + project.bundle.json + assets/, or a single
 * inlined index.html. The player bundle itself is a built artifact of
 * @hearth/runtime; hosts (CLI, MCP server, editor server) provide it through
 * `CommandContext.resources.getPlayerBundle()`.
 */
import { z } from 'zod';
import { defineCommand, type CommandContext } from './types.js';
import { ProjectError } from '../project/store.js';
import { joinPath, dirnamePath } from '../fs.js';
import { slugify } from '../ids.js';
import { validateProject } from '../validate.js';
import type { Scene } from '../schema/scene.js';

/** Project bundle shape consumed by HearthPlayer.boot({ mount, bundle }). */
export interface WebExportBundle {
  project: unknown;
  scenes: Scene[];
  scripts: Record<string, string>;
  assets: { id: string; name: string; type: string; path?: string; dataUri?: string }[];
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
 * The exported page. Dark themed, no external requests: styles and boot logic
 * are inline; the player handles canvas letterbox scaling itself.
 */
function renderIndexHtml(opts: {
  title: string;
  /** When set, the player source is inlined instead of loaded from a file. */
  inlinePlayer?: string;
  /** When set, the bundle is inlined instead of fetched. */
  inlineBundleJson?: string;
}): string {
  const title = escapeHtml(opts.title);
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
    :root { --bg: #141019; --ember: #F76B15; --text: #e8e2ee; --dim: #8a8296; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; }
    #hearth-mount { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
    #hearth-status { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center; text-align: center; background: var(--bg); z-index: 10; }
    #hearth-status h1 { font-size: 18px; font-weight: 600; letter-spacing: 0.04em; }
    #hearth-status p { font-size: 12px; color: var(--dim); }
    #hearth-status p.error { color: var(--ember); max-width: 40em; padding: 0 16px; }
    #hearth-status .flame { width: 10px; height: 10px; border-radius: 50%; background: var(--ember); animation: hearth-pulse 1.1s ease-in-out infinite; }
    @keyframes hearth-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }
    #hearth-fullscreen { position: fixed; right: 14px; bottom: 14px; z-index: 20; background: rgba(20, 16, 25, 0.85); color: var(--dim); border: 1px solid #2c2436; border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 12px; cursor: pointer; }
    #hearth-fullscreen:hover { color: var(--text); border-color: var(--ember); }
  </style>
</head>
<body>
  <div id="hearth-mount"></div>
  <div id="hearth-status">
    <div class="flame"></div>
    <h1>${title}</h1>
    <p id="hearth-status-text">Loading&hellip;</p>
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
  const assets: WebExportBundle['assets'] = [];
  for (const asset of store.assets.assets) {
    if (inlineAssets) {
      const bytes = await ctx.fs.readFileBinary(joinPath(store.root, asset.path));
      assets.push({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        dataUri: `data:${mimeFor(asset.path)};base64,${toBase64(bytes)}`,
      });
    } else {
      assets.push({ id: asset.id, name: asset.name, type: asset.type, path: asset.path });
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

    const playerSource = await loadPlayerSource(ctx);
    const title = ctx.store.project.buildSettings.title || ctx.store.project.name;
    const outRoot = joinPath(ctx.store.root, params.outDir);
    await ctx.fs.mkdir(outRoot);

    const written: string[] = [];
    const write = async (rel: string, content: string | Uint8Array) => {
      await ctx.fs.writeFile(joinPath(outRoot, rel), content);
      written.push(joinPath(params.outDir, rel));
    };

    if (params.singleFile) {
      const bundle = await buildBundle(ctx, true);
      const html = renderIndexHtml({
        title,
        inlinePlayer: playerSource,
        inlineBundleJson: JSON.stringify(bundle),
      });
      await write('index.html', html);
    } else {
      const bundle = await buildBundle(ctx, false);
      await write('index.html', renderIndexHtml({ title }));
      await write('hearth-player.js', playerSource);
      await write('project.bundle.json', JSON.stringify(bundle, null, 2) + '\n');
      for (const asset of ctx.store.assets.assets) {
        const src = joinPath(ctx.store.root, asset.path);
        const dest = joinPath(outRoot, asset.path);
        await ctx.fs.mkdir(dirnamePath(dest));
        await ctx.fs.copyFile(src, dest);
        written.push(joinPath(params.outDir, asset.path));
      }
    }

    ctx.changed({ kind: 'file', path: params.outDir, action: 'created' });
    return {
      outDir: params.outDir,
      singleFile: params.singleFile,
      files: written,
      title,
      slug: slugify(ctx.store.project.name),
    };
  },
});

function isSafeOut(p: string): boolean {
  return !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]:/.test(p);
}
