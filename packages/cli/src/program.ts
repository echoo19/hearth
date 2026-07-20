/**
 * The `hearth` command line: builds the commander program that maps CLI
 * grammar onto @hearth/core commands (via HearthSession.execute) and a
 * handful of CLI-only meta operations (init, doctor, commands, test).
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import {
  createProject,
  listCommands,
  slugify,
  validateProject,
  DEFAULT_MODES,
  PERMISSION_MODES,
  SOUND_PRESETS,
  PermissionError,
  hasPermission,
  type HearthSession,
} from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { listTemplates, getTemplatePath, scaffoldFromTemplate } from '@hearth/templates';
import { captureScreenshot, captureSequence, MAX_SEQUENCE_FRAMES } from '@hearth/playtest';
import { zipDirectory, describeSigningCapability } from '@hearth/shipping';
import { CliError, openSession, resolveProjectRoot, type GlobalOpts } from './context.js';
import { emit, errorResult, makeResult, logStderr } from './output.js';
import {
  parseBool,
  parseJsonArray,
  parseJsonObject,
  parseList,
  parsePosition,
  parseSize,
  parseFrameSize,
  parseValue,
  parseWidthHeight,
  parseRect,
  parseCells,
  ParseError,
} from './parse.js';

// Hardcoded rather than imported from package.json: this package builds
// under NodeNext + esbuild-bundled single-file tool builds (see
// apps/editor/scripts/build-electron.mjs), and a JSON import needs an
// import-attribute syntax (`with { type: 'json' }`) that's a bigger change
// than a version bump justifies here. Keep this in sync with package.json's
// "version" on every release.
const VERSION = '1.0.0';

/** The genre template names `init --template` accepts, in menu order. */
const TEMPLATE_NAMES: string[] = listTemplates().map((t) => t.name);

/** The four native desktop targets `export desktop` can build, mirroring core's exportDesktop schema. */
const DESKTOP_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const;
type DesktopPlatformId = (typeof DESKTOP_PLATFORMS)[number];

/** Render a signing capability (from @hearth/shipping's describeSigningCapability) for human output. */
function formatSigningCapability(capability: { mode: string; identity?: string }): string {
  const mode = capability.mode === 'adhoc' ? 'ad-hoc' : capability.mode;
  return capability.identity ? `${mode} (${capability.identity})` : mode;
}

/** Read a global-options snapshot off a commander Command. */
function globalOpts(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

/** Run body(); on any thrown error, emit a failing envelope for `commandName` and set exit code 1. */
async function guarded(cmd: Command, commandName: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const opts = globalOpts(cmd);
    const code = err instanceof CliError ? err.code : err instanceof ParseError ? 'INVALID_INPUT' : 'INTERNAL_ERROR';
    const message = (err as Error).message ?? String(err);
    process.exitCode = emit(errorResult(commandName, code, message), opts);
  }
}

/**
 * Resolve a `--data <json|@file>` option: a value starting with `@` is a
 * path to a JSON file (read + parsed); anything else is parsed as inline
 * JSON. Used by state-machine asset documents, which are too large to type
 * as a single flag value in practice.
 */
async function readDataOption(raw: string, flagName: string): Promise<Record<string, unknown>> {
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    const text = await fsp.readFile(path.resolve(filePath), 'utf8');
    return parseJsonObject(text, filePath);
  }
  return parseJsonObject(raw, flagName);
}

/**
 * Resolve a `--tracks <json|@file>` (or any JSON-array) option: `@path` reads
 * and parses a JSON file; anything else is parsed as inline JSON. The array
 * sibling of readDataOption, used by `create music`'s track list.
 */
async function readArrayDataOption(raw: string, flagName: string): Promise<unknown[]> {
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    const text = await fsp.readFile(path.resolve(filePath), 'utf8');
    return parseJsonArray(text, filePath);
  }
  return parseJsonArray(raw, flagName);
}

/** Open a session, execute a core command, and emit the result. `okIf` can force exit 1 on semantic failure. */
async function runAndEmit(
  cmd: Command,
  commandName: string,
  params: unknown,
  options: { okIf?: (data: unknown) => boolean } = {},
): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);
  const result = await session.execute(commandName, params);
  let code = emit(result, opts);
  if (code === 0 && options.okIf && !options.okIf(result.data)) code = 1;
  process.exitCode = code;
}

/**
 * Expand a single `import asset --recursive` argument: a file passes through
 * unchanged; a directory is walked recursively for the files under it
 * (dotfiles and dot-directories skipped). A path that doesn't exist also
 * passes through unchanged — importAssets reports the NOT_FOUND skip for it
 * with the original path, which is a better error than one from this helper.
 */
export async function expandImportPath(sourcePath: string): Promise<string[]> {
  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch {
    return [sourcePath];
  }
  if (!stat.isDirectory()) return [sourcePath];
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(sourcePath);
  return out;
}

/**
 * `import asset <source-paths...>`: a single path (no --recursive) runs the
 * single-file importAsset command unchanged (keeps --name support and its
 * one-asset output shape); anything else — multiple paths, or --recursive —
 * expands any directories and runs importAssets as one atomic batch.
 */
async function runImportAssetCommand(
  cmd: Command,
  sourcePaths: string[],
  opts: { name?: string; type?: string; recursive?: boolean },
): Promise<void> {
  if (sourcePaths.length === 1 && !opts.recursive) {
    let stat: Awaited<ReturnType<typeof fsp.stat>> | undefined;
    try {
      stat = await fsp.stat(sourcePaths[0]);
    } catch {
      // Missing path: let importAsset produce its usual NOT_FOUND error.
    }
    if (stat?.isDirectory()) {
      throw new CliError(
        'INVALID_INPUT',
        `"${sourcePaths[0]}" is a directory. Pass --recursive to import the files under it.`,
      );
    }
    await runAndEmit(cmd, 'importAsset', { sourcePath: sourcePaths[0], name: opts.name, type: opts.type });
    return;
  }
  if (opts.name) {
    throw new CliError('INVALID_INPUT', '--name can only be used when importing a single file.');
  }
  let expanded = sourcePaths;
  if (opts.recursive) {
    expanded = [];
    for (const p of sourcePaths) expanded.push(...(await expandImportPath(p)));
  }
  const params: Record<string, unknown> = { sourcePaths: expanded };
  if (opts.type) params.type = opts.type;
  await runAndEmit(cmd, 'importAssets', params);
}

function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option('-p, --project <path>', 'project root (default: walk up from cwd looking for hearth.json)')
    .option('--json', 'emit machine-readable JSON (the CommandResult envelope) on stdout')
    .option('--allow <modes>', 'comma-separated permission modes, or "all" (default: ' + DEFAULT_MODES.join(',') + ')')
    .option('-q, --quiet', 'suppress log output on stderr');
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('hearth')
    .description('hearth: the Hearth engine command-line interface for humans and coding agents')
    .version(VERSION)
    .showHelpAfterError(true);
  addGlobalOptions(program);

  // ---------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      // `[name]` is optional so `--list-templates` works on its own; a missing
      // name for an actual create is rejected in the action below.
      .command('init [name]')
      .description('create a new Hearth project (optionally from a genre template)')
      .option('--dir <path>', 'target directory (default: ./<slug-of-name> under cwd)')
      .option('--description <text>', 'project description')
      .option('--template <name>', `scaffold from a genre template (${TEMPLATE_NAMES.join(', ')})`)
      .option('--list-templates', 'list the available genre templates and exit')
      .option('--no-starter', 'skip the starter scene (camera + ground + player); blank projects only')
      .option('--width <n>', 'build width in pixels', (v) => parseInt(v, 10))
      .option('--height <n>', 'build height in pixels', (v) => parseInt(v, 10)),
  ).action(async (name: string | undefined, opts, cmd: Command) => {
    await guarded(cmd, 'init', async () => {
      const g = globalOpts(cmd);

      if (opts.listTemplates) {
        const templates = listTemplates();
        if (g.json) {
          process.exitCode = emit(makeResult('init', true, { templates }), g);
        } else {
          console.log('Available templates:');
          for (const t of templates) console.log(`  ${t.name.padEnd(12)} ${t.description}`);
          process.exitCode = 0;
        }
        return;
      }

      if (typeof name !== 'string' || name.trim() === '') {
        throw new CliError('INVALID_INPUT', 'A project name is required (or pass --list-templates).');
      }

      if (opts.template !== undefined) {
        if (!TEMPLATE_NAMES.includes(opts.template)) {
          throw new CliError(
            'INVALID_INPUT',
            `Unknown template "${opts.template}". Available templates: ${TEMPLATE_NAMES.join(', ')}.`,
          );
        }
        // --no-starter sets opts.starter === false; it only governs the blank
        // starter scene, so it's meaningless (and likely a mistake) with a template.
        if (opts.starter === false) {
          throw new CliError(
            'INVALID_INPUT',
            '--no-starter applies to blank projects only; it cannot be combined with --template.',
          );
        }
        // Templates own their build dimensions (their levels are laid out for
        // them), so silently ignoring --width/--height would be a lie. Error
        // instead; `hearth set-settings --build-settings` can resize afterwards.
        if (opts.width !== undefined || opts.height !== undefined) {
          throw new CliError(
            'INVALID_INPUT',
            '--width/--height apply to blank projects only; templates set their own build size. ' +
              'Scaffold first, then resize with: hearth set-settings --build-settings \'{"width":...,"height":...}\'.',
          );
        }
      }

      const target = await resolveInitTarget(name, opts.dir);
      await fsp.mkdir(target, { recursive: true });
      const fs = new NodeFileSystem();

      let files: string[];
      if (opts.template !== undefined) {
        if (existsSync(path.join(target, 'hearth.json'))) {
          throw new CliError('CONFLICT', `A Hearth project already exists at ${target}`);
        }
        ({ files } = await scaffoldFromTemplate(fs, getTemplatePath(opts.template), target, {
          name,
          description: opts.description,
        }));
      } else {
        ({ files } = await createProject(fs, target, {
          name,
          description: opts.description,
          starterScene: opts.starter !== false,
          width: opts.width,
          height: opts.height,
        }));
      }

      const suggestions = [
        `cd ${path.relative(process.cwd(), target) || '.'}`,
        'hearth inspect project --json',
        'hearth validate',
      ];
      const result = makeResult('init', true, { path: target, files }, { files, suggestions });
      process.exitCode = emit(result, g);
    });
  });

  // ---------------------------------------------------------------------
  // inspect
  // ---------------------------------------------------------------------
  const inspect = program.command('inspect').description('inspect the project, scenes, entities, components, assets, or scripts');
  addGlobalOptions(inspect);

  addGlobalOptions(inspect.command('project').description('project metadata')).action(async (opts, cmd) => {
    await guarded(cmd, 'inspectProject', () => runAndEmit(cmd, 'inspectProject', {}));
  });
  addGlobalOptions(inspect.command('scenes').description('list all scenes')).action(async (opts, cmd) => {
    await guarded(cmd, 'listScenes', () => runAndEmit(cmd, 'listScenes', {}));
  });
  addGlobalOptions(inspect.command('components').description('list all component types with defaults')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'inspectComponents', () => runAndEmit(cmd, 'inspectComponents', {}));
    },
  );
  addGlobalOptions(
    inspect.command('assets').description('list all assets').option('--type <type>', 'filter by asset type'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'inspectAssets', () => runAndEmit(cmd, 'inspectAssets', { type: opts.type }));
  });
  addGlobalOptions(inspect.command('scripts').description('list all script files')).action(async (opts, cmd) => {
    await guarded(cmd, 'inspectScripts', () => runAndEmit(cmd, 'inspectScripts', {}));
  });
  addGlobalOptions(
    inspect
      .command('scene <scene>')
      .description('inspect a scene and its entity hierarchy')
      .option('--full', 'include full component data per entity'),
  ).action(async (scene: string, opts, cmd) => {
    await guarded(cmd, 'inspectScene', () => runAndEmit(cmd, 'inspectScene', { scene, full: !!opts.full }));
  });
  addGlobalOptions(inspect.command('entity <scene> <entity>').description('inspect one entity')).action(
    async (scene: string, entity: string, opts, cmd) => {
      await guarded(cmd, 'inspectEntity', () => runAndEmit(cmd, 'inspectEntity', { scene, entity }));
    },
  );
  addGlobalOptions(
    inspect.command('api').description('the script ctx API reference (signatures, descriptions, Lua + JS examples)'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'inspectApi', () => runAndEmit(cmd, 'inspectApi', {}));
  });
  addGlobalOptions(
    inspect
      .command('path <scene>')
      .description('find a walkable path between two points (A* over solid geometry)')
      .requiredOption('--from <x,y>', 'start position')
      .requiredOption('--to <x,y>', 'goal position')
      .option('--diagonals', 'allow 8-directional movement'),
  ).action(async (scene: string, opts: { from: string; to: string; diagonals?: boolean }, cmd) => {
    await guarded(cmd, 'inspectPath', () =>
      runAndEmit(cmd, 'inspectPath', {
        scene,
        from: parsePosition(opts.from),
        to: parsePosition(opts.to),
        diagonals: Boolean(opts.diagonals),
      }),
    );
  });

  // ---------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------
  addGlobalOptions(program.command('validate').description('validate the whole project')).action(async (opts, cmd) => {
    await guarded(cmd, 'validateProject', () =>
      runAndEmit(cmd, 'validateProject', {}, { okIf: (data) => (data as { valid: boolean }).valid }),
    );
  });

  // ---------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------
  const create = program.command('create').description('create scenes, entities, scripts, assets, animations, or playtests');
  addGlobalOptions(create);

  addGlobalOptions(
    create.command('scene <name>').description('create a scene').option('--no-camera', 'do not add a default Main Camera'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createScene', () =>
      runAndEmit(cmd, 'createScene', { name, withCamera: opts.camera !== false }),
    );
  });

  addGlobalOptions(
    create
      .command('entity <scene> <name>')
      .description('create an entity in a scene')
      .option('--position <x,y>', 'initial position')
      .option('--parent <ref>', 'parent entity (id or name)')
      .option('--tags <a,b>', 'comma-separated tags')
      .option('--components <json>', 'component type -> property overrides, e.g. \'{"SpriteRenderer":{"color":"#f00"}}\''),
  ).action(async (scene: string, name: string, opts, cmd) => {
    await guarded(cmd, 'createEntity', () => {
      const params = {
        scene,
        name,
        position: opts.position ? parsePosition(opts.position) : undefined,
        parent: opts.parent,
        tags: parseList(opts.tags),
        components: parseJsonObject(opts.components, '--components'),
      };
      return runAndEmit(cmd, 'createEntity', params);
    });
  });

  addGlobalOptions(
    create
      .command('script <name>')
      .description('create a script under scripts/ from the standard template (Lua by default; reformats on save unless --no-format)')
      .option('--dir <dir>', 'subdirectory under scripts/, e.g. lib')
      .option('--language <language>', 'scripting language: lua (default) or js')
      .option('--source-file <path>', 'read initial source from a file instead of the template')
      .option('--no-format', 'save verbatim, without reformatting to Hearth house style'),
  ).action(async (name: string, opts: { dir?: string; language?: string; sourceFile?: string; format?: boolean }, cmd) => {
    await guarded(cmd, 'createScript', async () => {
      const source = opts.sourceFile ? await fsp.readFile(path.resolve(opts.sourceFile), 'utf8') : undefined;
      // commander's --no-format sets opts.format=false; absent means "use
      // the project's codeStyle.formatOnSave" (send nothing).
      const format = opts.format === false ? false : undefined;
      await runAndEmit(cmd, 'createScript', { name, dir: opts.dir, language: opts.language, source, format });
    });
  });

  const createAsset = create.command('asset').description('create a procedural asset');
  addGlobalOptions(createAsset);
  addGlobalOptions(
    createAsset
      .command('sprite <name>')
      .description('create a procedural placeholder sprite')
      .option('--shape <shape>', 'rectangle, circle, triangle, polygon, ...')
      .option('--color <color>', 'hex or named color')
      .option('--width <n>', 'width in px', (v) => parseInt(v, 10))
      .option('--height <n>', 'height in px', (v) => parseInt(v, 10))
      .option('--accent-color <color>', 'accent color')
      .option('--sides <n>', 'polygon side count', (v) => parseInt(v, 10))
      .option('--stroke-color <color>', 'stroke color')
      .option('--stroke-width <n>', 'stroke width', (v) => parseFloat(v))
      .option('--corner-radius <n>', 'corner radius', (v) => parseFloat(v))
      .option('--shading <mode>', 'body shading: flat (default) or gradient')
      .option('--secondary-color <color>', 'gradient end color (defaults to a darkened primary; requires --shading gradient)'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createSpriteAsset', () =>
      runAndEmit(cmd, 'createSpriteAsset', {
        name,
        shape: opts.shape,
        color: opts.color,
        width: opts.width,
        height: opts.height,
        accentColor: opts.accentColor,
        sides: opts.sides,
        strokeColor: opts.strokeColor,
        strokeWidth: opts.strokeWidth,
        cornerRadius: opts.cornerRadius,
        shading: opts.shading,
        secondaryColor: opts.secondaryColor,
      }),
    );
  });
  addGlobalOptions(
    createAsset
      .command('tile <name>')
      .description('create a procedural tile asset')
      .option('--color <color>', 'hex or named color')
      .option('--size <n>', 'tile size in px', (v) => parseInt(v, 10))
      .option('--shading <mode>', 'body shading: flat (default) or gradient')
      .option('--secondary-color <color>', 'gradient end color (defaults to a darkened primary; requires --shading gradient)'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createTileAsset', () =>
      runAndEmit(cmd, 'createTileAsset', {
        name,
        color: opts.color,
        size: opts.size,
        shading: opts.shading,
        secondaryColor: opts.secondaryColor,
      }),
    );
  });

  addGlobalOptions(
    create
      .command('sound <name>')
      .description(`create a procedural sound effect (WAV). Presets: ${SOUND_PRESETS.join(', ')}`)
      .requiredOption('--preset <preset>', `sound preset (${SOUND_PRESETS.join(', ')})`)
      .option('--seed <n>', 'PRNG seed for deterministic variation', (v) => parseInt(v, 10)),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createSound', () =>
      runAndEmit(cmd, 'createSound', { name, preset: opts.preset, seed: opts.seed }),
    );
  });

  addGlobalOptions(
    create
      .command('music <name>')
      .description(
        'create a procedural chiptune track (deterministic WAV) from 1-4 oscillator tracks. ' +
          'Each track\'s notes are whitespace-separated tokens (one token = one sixteenth step): ' +
          'note names (C4, F#3, Bb2), "-" (rest), or "." (extend previous note).',
      )
      .requiredOption('--tempo <n>', 'beats per minute (40-300)', (v) => parseFloat(v))
      .requiredOption(
        '--tracks <json|@file>',
        'JSON array of tracks: inline, or @path/to/file.json, e.g. \'[{"wave":"square","notes":"C4 E4 G4"}]\' ' +
          '(each track: {wave, volume?, notes}; wave is sine|square|saw|triangle|noise)',
      )
      .option('--loop', 'mark the track as looping'),
  ).action(async (name: string, opts: { tempo: number; tracks: string; loop?: boolean }, cmd) => {
    await guarded(cmd, 'createMusic', async () => {
      const tracks = await readArrayDataOption(opts.tracks, '--tracks');
      await runAndEmit(cmd, 'createMusic', { name, tempo: opts.tempo, tracks, loop: !!opts.loop });
    });
  });

  addGlobalOptions(
    create
      .command('animation <name>')
      .description('create an animation asset from existing sprite/tile assets')
      .requiredOption('--frames <frames...>', 'frame asset ids or names, in order')
      .option('--frame-duration <seconds>', 'seconds per frame', (v) => parseFloat(v))
      .option('--no-loop', 'do not loop'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createAnimationAsset', () =>
      runAndEmit(cmd, 'createAnimationAsset', {
        name,
        frames: opts.frames,
        frameDuration: opts.frameDuration,
        loop: opts.loop !== false,
      }),
    );
  });

  addGlobalOptions(
    createAsset
      .command('slice <asset>')
      .description('slice a spritesheet image into frames with configurable grid spacing')
      .requiredOption('--frame-size <WxH>', 'frame size in pixels (e.g. 32x32)')
      .option('--margin <n>', 'margin around spritesheet edges', (v) => parseInt(v, 10))
      .option('--spacing <n>', 'spacing between frames', (v) => parseInt(v, 10))
      .option('--prefix <name>', 'frame name prefix'),
  ).action(async (asset: string, opts, cmd) => {
    await guarded(cmd, 'sliceSpritesheet', () => {
      const frameSize = parseFrameSize(opts.frameSize);
      return runAndEmit(cmd, 'sliceSpritesheet', {
        asset,
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        margin: opts.margin ?? 0,
        spacing: opts.spacing ?? 0,
        namePrefix: opts.prefix,
      });
    });
  });

  addGlobalOptions(
    createAsset
      .command('anim-from-sheet <name>')
      .description('create an animation asset from named frames on a sliced spritesheet')
      .requiredOption('--sheet <asset>', 'spritesheet asset id or name')
      .requiredOption('--frames <list>', 'comma-separated frame names from the sheet')
      .option('--duration <seconds>', 'seconds per frame', (v) => parseFloat(v))
      .option('--no-loop', 'do not loop'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createAnimationFromSheet', () => {
      const frames = parseList(opts.frames);
      if (frames.length === 0) {
        throw new ParseError('--frames must contain at least one frame name');
      }
      return runAndEmit(cmd, 'createAnimationFromSheet', {
        name,
        sheet: opts.sheet,
        frames,
        frameDuration: opts.duration,
        loop: opts.loop !== false,
      });
    });
  });

  addGlobalOptions(
    createAsset
      .command('state-machine <name>')
      .description(
        'create an animation state machine asset (params/states/transitions). Every state.animation must be an existing animation asset.',
      )
      .requiredOption('--data <json|@file>', 'the state machine document: inline JSON, or @path/to/file.json'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createStateMachineAsset', async () => {
      const data = await readDataOption(opts.data, '--data');
      await runAndEmit(cmd, 'createStateMachineAsset', { name, data });
    });
  });

  addGlobalOptions(
    create
      .command('playtest <name>')
      .description('create a playtest definition')
      .requiredOption('--scene <scene>', 'target scene')
      .option('--steps-file <path>', 'JSON file with an array of playtest steps')
      .option('--max-frames <n>', 'max frames before timeout', (v) => parseInt(v, 10))
      .option('--seed <n>', 'seed for ctx.random / Lua math.random (same seed, same run)', (v) =>
        parseInt(v, 10),
      ),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createPlaytest', async () => {
      let steps: unknown[] = [];
      if (opts.stepsFile) {
        const text = await fsp.readFile(path.resolve(opts.stepsFile), 'utf8');
        steps = parseJsonArray(text, opts.stepsFile);
      }
      await runAndEmit(cmd, 'createPlaytest', {
        name,
        scene: opts.scene,
        steps,
        maxFrames: opts.maxFrames,
        seed: opts.seed,
      });
    });
  });

  // ---------------------------------------------------------------------
  // add / remove component
  // ---------------------------------------------------------------------
  const add = program.command('add').description('add things to entities');
  addGlobalOptions(add);
  addGlobalOptions(
    add
      .command('component <scene> <entity> <type>')
      .description('add a component to an entity')
      .option('--properties <json>', 'property overrides'),
  ).action(async (scene: string, entity: string, type: string, opts, cmd) => {
    await guarded(cmd, 'addComponent', () =>
      runAndEmit(cmd, 'addComponent', {
        scene,
        entity,
        type,
        properties: parseJsonObject(opts.properties, '--properties'),
      }),
    );
  });

  const remove = program.command('remove').description('remove things from entities');
  addGlobalOptions(remove);
  addGlobalOptions(remove.command('component <scene> <entity> <type>').description('remove a component from an entity')).action(
    async (scene: string, entity: string, type: string, opts, cmd) => {
      await guarded(cmd, 'removeComponent', () => runAndEmit(cmd, 'removeComponent', { scene, entity, type }));
    },
  );

  // ---------------------------------------------------------------------
  // set / set-input
  // ---------------------------------------------------------------------
  const set = addGlobalOptions(
    program
      .command('set <scene> <entity> <property> <value>')
      .description('set a component property, e.g. hearth set MyScene Coin Transform.position.x 200'),
  );
  set.action(async (scene: string, entity: string, property: string, value: string, opts, cmd) => {
    await guarded(cmd, 'setComponentProperty', () =>
      runAndEmit(cmd, 'setComponentProperty', { scene, entity, property, value: parseValue(value) }),
    );
  });

  addGlobalOptions(
    set
      .command('enabled <scene> <entity> <enabled>')
      .description('enable or disable an entity, e.g. hearth set enabled MyScene Coin false'),
  ).action(async (scene: string, entity: string, enabled: string, opts, cmd) => {
    await guarded(cmd, 'setEntityEnabled', () =>
      runAndEmit(cmd, 'setEntityEnabled', { scene, entity, enabled: parseBool(enabled, '<enabled>') }),
    );
  });

  addGlobalOptions(
    set
      .command('tags <scene> <entity> <tags>')
      .description("replace an entity's tags (comma-separated), e.g. hearth set tags MyScene Coin pickup,shiny"),
  ).action(async (scene: string, entity: string, tags: string, opts, cmd) => {
    await guarded(cmd, 'setEntityTags', () =>
      runAndEmit(cmd, 'setEntityTags', { scene, entity, tags: parseList(tags) }),
    );
  });

  addGlobalOptions(
    program
      .command('set-many <scene> <entity>')
      .description(
        'set multiple component properties on one entity in a single undo step, e.g. ' +
          'hearth set-many MyScene Coin --properties \'{"Transform.position.x":100,"SpriteRenderer.width":64}\'',
      )
      .requiredOption('--properties <json>', 'dot-path property map, e.g. {"Transform.position.x":100}'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'setProperties', () =>
      runAndEmit(cmd, 'setProperties', {
        scene,
        entity,
        properties: parseJsonObject(opts.properties, '--properties'),
      }),
    );
  });

  addGlobalOptions(
    program
      .command('set-input <action> [keys...]')
      .description('set (or, with no keys, remove) the key bindings for an input action'),
  ).action(async (action: string, keys: string[], opts, cmd) => {
    await guarded(cmd, 'setInputMapping', () => runAndEmit(cmd, 'setInputMapping', { action, keys: keys ?? [] }));
  });

  addGlobalOptions(
    program
      .command('set-settings')
      .description(
        'update project settings: partial buildSettings (deep-merged), initial scene, input mappings, code style',
      )
      .option(
        '--build-settings <json>',
        'partial buildSettings JSON, deep-merged, e.g. \'{"title":"My Game","loading":{"spinner":true}}\'',
      )
      .option('--initial-scene <scene>', 'scene (id or name) that runs first')
      .option('--input-actions <json>', 'action -> key list JSON, replaced per action, e.g. \'{"jump":["Space"]}\'')
      .option(
        '--input-gamepad-buttons <json>',
        'action -> gamepad button name list JSON, replaced wholesale, e.g. \'{"jump":["a"]}\'',
      )
      .option(
        '--input-gamepad-axes <json>',
        'action -> gamepad axis binding JSON, replaced wholesale, e.g. \'{"right":{"axis":0,"direction":1}}\'',
      )
      .option(
        '--input-axes <json>',
        'virtual axis name -> axis JSON, replaced wholesale, e.g. \'{"horizontal":{"gamepadAxis":0,"negativeCodes":["ArrowLeft"],"positiveCodes":["ArrowRight"]}}\'',
      )
      .option('--input-deadzone <number>', 'global gamepad stick deadzone (0-1)', (v) => parseFloat(v))
      .option('--format-on-save <bool>', 'auto-format Lua/JS scripts on save (true/false)'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'updateSettings', () => {
      const params: Record<string, unknown> = {};
      if (opts.buildSettings) params.buildSettings = parseJsonObject(opts.buildSettings, '--build-settings');
      if (opts.initialScene) params.initialScene = opts.initialScene;
      const inputMappings: Record<string, unknown> = {};
      if (opts.inputActions) inputMappings.actions = parseJsonObject(opts.inputActions, '--input-actions');
      if (opts.inputGamepadButtons) {
        inputMappings.gamepadButtons = parseJsonObject(opts.inputGamepadButtons, '--input-gamepad-buttons');
      }
      if (opts.inputGamepadAxes) {
        inputMappings.gamepadAxes = parseJsonObject(opts.inputGamepadAxes, '--input-gamepad-axes');
      }
      if (opts.inputAxes) inputMappings.axes = parseJsonObject(opts.inputAxes, '--input-axes');
      if (opts.inputDeadzone !== undefined) inputMappings.deadzone = opts.inputDeadzone;
      if (Object.keys(inputMappings).length > 0) params.inputMappings = inputMappings;
      if (opts.formatOnSave !== undefined) {
        params.codeStyle = { formatOnSave: parseBool(opts.formatOnSave, '--format-on-save') };
      }
      return runAndEmit(cmd, 'updateSettings', params);
    });
  });

  addGlobalOptions(
    program
      .command('set-state-machine <assetId>')
      .description("replace a state machine asset's document in place (same asset id/path)")
      .requiredOption('--data <json|@file>', 'the state machine document: inline JSON, or @path/to/file.json'),
  ).action(async (assetId: string, opts, cmd) => {
    await guarded(cmd, 'updateStateMachineAsset', async () => {
      const data = await readDataOption(opts.data, '--data');
      await runAndEmit(cmd, 'updateStateMachineAsset', { assetId, data });
    });
  });

  // ---------------------------------------------------------------------
  // attach / edit-script
  // ---------------------------------------------------------------------
  const attach = program.command('attach').description('attach a script to an entity');
  addGlobalOptions(attach);
  addGlobalOptions(
    attach
      .command('script <scene> <entity> <script-path>')
      .description('attach a script to an entity')
      .option('--params <json>', 'parameters exposed to the script as ctx.params'),
  ).action(async (scene: string, entity: string, scriptPath: string, opts, cmd) => {
    await guarded(cmd, 'attachScript', () =>
      runAndEmit(cmd, 'attachScript', {
        scene,
        entity,
        script: scriptPath,
        params: parseJsonObject(opts.params, '--params'),
      }),
    );
  });

  // The `script` subcommand group is the forward surface for script ops
  // (edit / check / format). The legacy top-level `edit-script` /
  // `check-script` verbs stay as aliases into the same handlers — agents have
  // them memorized.
  const editScriptOpts = (cmd: Command) =>
    cmd
      .description('replace the full source of a script file (reformats on save unless --no-format)')
      .option('--source-file <path>', 'read new source from a file instead of stdin')
      .option('--no-format', 'save verbatim, without reformatting to Hearth house style');
  const checkScriptOpts = (cmd: Command) =>
    cmd
      .description(
        'check a script for syntax errors without saving it (pre-flight before edit). ' +
          'With --source, checks that text as if it would be saved to <path>; otherwise reads <path> from the project.',
      )
      .option('--source <text>', 'check this text instead of reading <path> from disk')
      .option('--language <language>', 'scripting language override: lua or js');

  const editScriptAction = async (scriptPath: string, opts: { sourceFile?: string; format?: boolean }, cmd: Command) => {
    await guarded(cmd, 'editScript', () => runEditScriptCommand(cmd, scriptPath, opts));
  };
  const checkScriptAction = async (scriptPath: string, opts: { source?: string; language?: string }, cmd: Command) => {
    await guarded(cmd, 'checkScript', () => runCheckScriptCommand(cmd, scriptPath, opts));
  };

  addGlobalOptions(editScriptOpts(program.command('edit-script <path>'))).action(editScriptAction);
  addGlobalOptions(checkScriptOpts(program.command('check-script <path>'))).action(checkScriptAction);

  const script = program.command('script').description('edit, check, reformat, search, or replace in script files');
  addGlobalOptions(script);
  addGlobalOptions(editScriptOpts(script.command('edit <path>'))).action(editScriptAction);
  addGlobalOptions(checkScriptOpts(script.command('check <path>'))).action(checkScriptAction);
  addGlobalOptions(
    script
      .command('format [path]')
      .description('reformat a script (or --all scripts) to Hearth house style')
      .option('--all', 'reformat every .lua/.js script under scripts/'),
  ).action(async (scriptPath: string | undefined, opts: { all?: boolean }, cmd) => {
    await guarded(cmd, 'formatScript', () => runFormatScriptCommand(cmd, scriptPath, opts));
  });
  addGlobalOptions(
    script
      .command('search <query>')
      .description(
        'search script source for a plain-text or regex query (line-based matching, no multiline patterns); ' +
          'prints path:line:col  preview per match',
      )
      .option('--regex', 'treat <query> as a regular expression')
      .option('--case', 'case-sensitive matching (default: case-insensitive)')
      .option('--glob <glob>', 'restrict to scripts matching this glob, e.g. "scripts/enemies/*"'),
  ).action(async (query: string, opts: { regex?: boolean; case?: boolean; glob?: string }, cmd) => {
    await guarded(cmd, 'searchScripts', () => runSearchScriptsCommand(cmd, query, opts));
  });
  addGlobalOptions(
    script
      .command('replace <query> <replacement>')
      .description(
        'find-and-replace across script files (line-based matching; $1-style capture groups with --regex). ' +
          'Results are written verbatim, not reformatted. Run "script format --all" after. Use --dry-run to ' +
          'preview counts before writing.',
      )
      .option('--regex', 'treat <query> as a regular expression')
      .option('--case', 'case-sensitive matching (default: case-insensitive)')
      .option('--glob <glob>', 'restrict to scripts matching this glob, e.g. "scripts/enemies/*"')
      .option('--dry-run', 'preview per-file counts without writing anything'),
  ).action(
    async (
      query: string,
      replacement: string,
      opts: { regex?: boolean; case?: boolean; glob?: string; dryRun?: boolean },
      cmd,
    ) => {
      await guarded(cmd, 'replaceInScripts', () => runReplaceScriptsCommand(cmd, query, replacement, opts));
    },
  );

  // ---------------------------------------------------------------------
  // import
  // ---------------------------------------------------------------------
  const importGroup = program.command('import').description('import external files as assets');
  addGlobalOptions(importGroup);
  addGlobalOptions(
    importGroup
      .command('asset <source-paths...>')
      .description(
        'import one or more external files into assets/ and register them. ' +
          'A single path (without --recursive) runs importAsset; anything else (multiple paths, or --recursive) ' +
          'runs importAssets as one atomic batch. See `skipped` in the JSON output for any per-file skip reasons.',
      )
      .option('--name <name>', 'asset name, only valid when importing a single file (default: filename without extension)')
      .option('--type <type>', 'asset type override (sprite, tile, audio, animation, font, data, other), applied to every file')
      .option('--recursive', 'expand any directory arguments into the files under them (recursively) before importing'),
  ).action(async (sourcePaths: string[], opts: { name?: string; type?: string; recursive?: boolean }, cmd) => {
    const commandName = sourcePaths.length === 1 && !opts.recursive ? 'importAsset' : 'importAssets';
    await guarded(cmd, commandName, () => runImportAssetCommand(cmd, sourcePaths, opts));
  });

  // ---------------------------------------------------------------------
  // rename / delete / move
  // ---------------------------------------------------------------------
  const rename = program.command('rename').description('rename a scene or entity');
  addGlobalOptions(rename);
  addGlobalOptions(rename.command('scene <scene> <new-name>').description('rename a scene')).action(
    async (scene: string, newName: string, opts, cmd) => {
      await guarded(cmd, 'renameScene', () => runAndEmit(cmd, 'renameScene', { scene, newName }));
    },
  );
  addGlobalOptions(rename.command('entity <scene> <entity> <new-name>').description('rename an entity')).action(
    async (scene: string, entity: string, newName: string, opts, cmd) => {
      await guarded(cmd, 'renameEntity', () => runAndEmit(cmd, 'renameEntity', { scene, entity, newName }));
    },
  );

  const del = program.command('delete').description('delete a scene, entity, asset, or playtest');
  addGlobalOptions(del);
  addGlobalOptions(del.command('scene <scene>').description('delete a scene')).action(async (scene: string, opts, cmd) => {
    await guarded(cmd, 'deleteScene', () => runAndEmit(cmd, 'deleteScene', { scene }));
  });
  addGlobalOptions(del.command('entity <scene> <entity>').description('delete an entity')).action(
    async (scene: string, entity: string, opts, cmd) => {
      await guarded(cmd, 'deleteEntity', () => runAndEmit(cmd, 'deleteEntity', { scene, entity }));
    },
  );
  addGlobalOptions(
    del
      .command('asset <asset>')
      .description('unregister an asset from the index (deletes its file too unless --keep-file)')
      .option('--keep-file', 'keep the asset file on disk (unregister only)'),
  ).action(async (asset: string, opts, cmd) => {
    await guarded(cmd, 'removeAsset', () =>
      runAndEmit(cmd, 'removeAsset', { asset, deleteFile: !opts.keepFile }),
    );
  });
  addGlobalOptions(
    del.command('playtest <name>').description('delete a playtest definition (removes its playtest file)'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'deletePlaytest', () => runAndEmit(cmd, 'deletePlaytest', { playtest: name }));
  });

  const duplicate = program.command('duplicate').description('duplicate a scene or entity');
  addGlobalOptions(duplicate);
  addGlobalOptions(
    duplicate
      .command('scene <scene> <new-name>')
      .description('duplicate a scene (fresh entity ids); optionally clone playtests targeting it')
      .option('--with-playtests', 'also clone playtests targeting the source scene, retargeted to the copy'),
  ).action(async (scene: string, newName: string, opts, cmd) => {
    await guarded(cmd, 'duplicateScene', () =>
      runAndEmit(cmd, 'duplicateScene', { scene, newName, withPlaytests: !!opts.withPlaytests }),
    );
  });
  addGlobalOptions(
    duplicate
      .command('entity <scene> <entity>')
      .description('duplicate an entity and its full descendant subtree (fresh ids), offset from the original')
      .option('--name <name>', 'name for the copy (default: "<name> copy")')
      .option('--offset <x,y>', 'position offset for the copy (default: 16,16)'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'duplicateEntity', () => {
      const params: Record<string, unknown> = { scene, entity };
      if (opts.name) params.newName = opts.name;
      if (opts.offset) params.offset = parsePosition(opts.offset);
      return runAndEmit(cmd, 'duplicateEntity', params);
    });
  });

  const move = program.command('move').description('move (reposition/reparent) an entity');
  addGlobalOptions(move);
  addGlobalOptions(
    move
      .command('entity <scene> <entity>')
      .description('set position and/or re-parent an entity')
      .option('--position <x,y>', 'new position')
      .option('--parent <ref>', 'new parent entity (id or name)')
      .option('--to-root', 'move to scene root (clears parent)'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'moveEntity', () => {
      const params: Record<string, unknown> = { scene, entity };
      if (opts.position) params.position = parsePosition(opts.position);
      if (opts.toRoot) params.parent = null;
      else if (opts.parent) params.parent = opts.parent;
      return runAndEmit(cmd, 'moveEntity', params);
    });
  });

  // ---------------------------------------------------------------------
  // prefab (create from an entity subtree, place instances)
  // ---------------------------------------------------------------------
  const prefab = program.command('prefab').description('create prefab assets from entities, and place instances of them');
  addGlobalOptions(prefab);
  addGlobalOptions(
    prefab
      .command('create <scene> <entity> <name>')
      .description(
        "serialize an entity's full descendant subtree into a reusable prefab asset; " +
          'the source root entity becomes an instance of the new prefab',
      ),
  ).action(async (scene: string, entity: string, name: string, opts, cmd) => {
    await guarded(cmd, 'createPrefab', () => runAndEmit(cmd, 'createPrefab', { scene, entity, name }));
  });
  addGlobalOptions(
    prefab
      .command('place <prefab> <scene>')
      .description('instantiate a prefab asset into a scene as a fresh entity subtree')
      .option('--position <x,y>', 'position for the new root entity')
      .option('--name <name>', 'name for the new root entity (default: the prefab name)'),
  ).action(async (prefabRef: string, scene: string, opts, cmd) => {
    await guarded(cmd, 'instantiatePrefab', () => {
      const params: Record<string, unknown> = { prefab: prefabRef, scene };
      if (opts.position) params.position = parsePosition(opts.position);
      if (opts.name) params.name = opts.name;
      return runAndEmit(cmd, 'instantiatePrefab', params);
    });
  });
  addGlobalOptions(
    prefab
      .command('update <prefab> <scene> <entity>')
      .description(
        "re-serialize a modified prefab instance's subtree back over the prefab asset's payload file; " +
          'the entity must be a marked instance of that exact prefab',
      ),
  ).action(async (prefabRef: string, scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'updatePrefab', () =>
      runAndEmit(cmd, 'updatePrefab', { prefab: prefabRef, scene, entity }),
    );
  });
  addGlobalOptions(
    prefab
      .command('sync <prefab>')
      .description(
        'rebuild every marked instance of a prefab from its current asset payload (all scenes, or one via --scene)',
      )
      .option('--scene <scene>', 'limit sync to a single scene (default: all scenes)'),
  ).action(async (prefabRef: string, opts, cmd) => {
    await guarded(cmd, 'syncPrefabInstances', () => {
      const params: Record<string, unknown> = { prefab: prefabRef };
      if (opts.scene) params.scene = opts.scene;
      return runAndEmit(cmd, 'syncPrefabInstances', params);
    });
  });
  addGlobalOptions(
    prefab
      .command('revert <scene> <entity> [component] [path]')
      .description(
        'revert per-instance prefab overrides on an instance member back to the prefab values; ' +
          'scope narrows with the optional component and path args',
      ),
  ).action(async (scene: string, entity: string, component: string | undefined, path: string | undefined, _opts, cmd) => {
    await guarded(cmd, 'revertPrefabOverride', () => {
      const params: Record<string, unknown> = { scene, entity };
      if (component) params.component = component;
      if (path) params.path = path;
      return runAndEmit(cmd, 'revertPrefabOverride', params);
    });
  });

  // ---------------------------------------------------------------------
  // paint / fill / resize (tilemap editing)
  // ---------------------------------------------------------------------
  const paint = program.command('paint').description('paint tiles onto a Tilemap component');
  addGlobalOptions(paint);
  addGlobalOptions(
    paint
      .command('tiles <scene> <entity>')
      .description(
        'paint a batch of tile cells in one undo step, e.g. --cells "0,0,G;1,0,G". ' +
          'A char is a single character: "." or a literal space (empty), or a tileAssets key. ' +
          'To paint a space, quote it explicitly, e.g. --cells "0,0, " (a comma is not usable as a char).',
      )
      .requiredOption('--cells <spec>', '"x,y,c;x,y,c": semicolon-separated cells, x/y are 0-based column/row'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'paintTiles', () =>
      runAndEmit(cmd, 'paintTiles', { scene, entity, cells: parseCells(opts.cells) }),
    );
  });

  const fill = program.command('fill').description('fill a rectangular region of a Tilemap component');
  addGlobalOptions(fill);
  addGlobalOptions(
    fill
      .command('tiles <scene> <entity>')
      .description('fill x,y,width,height with one char in one undo step, e.g. --rect 0,0,4,2 --char G')
      .requiredOption('--rect <x,y,w,h>', 'top-left x,y plus width,height')
      .requiredOption('--char <c>', 'tile char: "." / " " (empty) or a tileAssets key'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'fillTilemapRect', () => {
      const rect = parseRect(opts.rect);
      return runAndEmit(cmd, 'fillTilemapRect', { scene, entity, ...rect, char: opts.char });
    });
  });

  const resize = program.command('resize').description('resize a Tilemap component\'s grid');
  addGlobalOptions(resize);
  addGlobalOptions(
    resize
      .command('tilemap <scene> <entity>')
      .description(
        'resize the grid to width,height, e.g. --size 40,20. Growing pads with "."; shrinking crops the right/bottom edges.',
      )
      .requiredOption('--size <w,h>', 'new width,height')
      .option('--anchor <anchor>', 'anchor point (only "top-left" is supported today)'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'resizeTilemap', () => {
      const { width, height } = parseWidthHeight(opts.size);
      const params: Record<string, unknown> = { scene, entity, width, height };
      if (opts.anchor) params.anchor = opts.anchor;
      return runAndEmit(cmd, 'resizeTilemap', params);
    });
  });

  const autotile = program.command('autotile').description('bind a Tilemap tile char to an autotile rule');
  addGlobalOptions(autotile);
  addGlobalOptions(
    autotile
      .command('set <scene> <entity>')
      .description(
        'bind a tile char to a blob47 autotile rule, e.g. --char G --sheet GroundSheet. The char picks its ' +
          'per-cell frame from its 8 neighbours at render time. Use --clear to remove an existing rule.',
      )
      .requiredOption('--char <c>', 'the tile char to bind (a single char, not "." or " ")')
      .option('--sheet <asset>', 'spritesheet asset id or name (required unless --clear)')
      .option('--template <t>', 'autotile template (only "blob47" is supported today)')
      .option('--mapping <json>', 'shape-key -> frame-name overrides JSON, e.g. \'{"255":"center"}\'')
      .option('--clear', 'remove the char\'s autotile rule instead of setting one'),
  ).action(async (scene: string, entity: string, opts, cmd) => {
    await guarded(cmd, 'setTileAutotile', () => {
      const params: Record<string, unknown> = { scene, entity, char: opts.char };
      if (opts.clear) params.clear = true;
      if (opts.sheet) params.sheet = opts.sheet;
      if (opts.template) params.template = opts.template;
      if (opts.mapping) params.mapping = parseJsonObject(opts.mapping, '--mapping');
      return runAndEmit(cmd, 'setTileAutotile', params);
    });
  });

  // ---------------------------------------------------------------------
  // snapshot / diff / revert
  // ---------------------------------------------------------------------
  addGlobalOptions(program.command('snapshot').description('save the current project state as the diff baseline')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'snapshotProject', () => runAndEmit(cmd, 'snapshotProject', {}));
    },
  );
  addGlobalOptions(program.command('diff').description('structural diff vs the last snapshot baseline')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'diffProject', () => runAndEmit(cmd, 'diffProject', {}));
    },
  );
  addGlobalOptions(
    program
      .command('revert')
      .description('restore the project to the last snapshot baseline')
      .option('--confirm', 'confirm the revert (required)'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'revertProject', () => runAndEmit(cmd, 'revertProject', { confirm: !!opts.confirm }));
  });

  // ---------------------------------------------------------------------
  // undo / redo / history
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program.command('undo').description('undo the most recent recorded change (see history)'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'undo', () => runAndEmit(cmd, 'undo', {}));
  });
  addGlobalOptions(
    program.command('redo').description('redo the most recently undone change (see history)'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'redo', () => runAndEmit(cmd, 'redo', {}));
  });
  addGlobalOptions(
    program.command('history').description('list recorded undo/redo history entries'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'listHistory', () => runHistoryCommand(cmd));
  });

  // ---------------------------------------------------------------------
  // log (command journal)
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('log')
      .description(
        'list recorded command journal entries (.hearth/log/commands.jsonl): every mutation, plus read-only ' +
          'playtest/validate runs, successes and failures alike, never rewound by undo/redo',
      )
      .option('--since <seq>', 'only entries after this seq (forward page)', (v) => parseInt(v, 10))
      .option('--limit <n>', 'max entries to return (default 50, max 500)', (v) => parseInt(v, 10)),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'listJournal', () => runLogCommand(cmd, opts.since, opts.limit));
  });

  // ---------------------------------------------------------------------
  // remember / recall — durable agent memory (.hearth/memory.md)
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('remember <note>')
      .description(
        'record a durable note in project memory (.hearth/memory.md) that survives across sessions — a decision, ' +
          'a todo, or a gotcha already hit; read it back with `hearth recall`',
      )
      .option('--section <section>', 'note | decision | todo | gotcha (default: note)'),
  ).action(async (note: string, opts, cmd) => {
    await guarded(cmd, 'rememberNote', () =>
      runAndEmit(cmd, 'rememberNote', { note, section: opts.section }),
    );
  });

  addGlobalOptions(
    program
      .command('recall')
      .description('read the durable project memory (.hearth/memory.md): decisions, todos, and gotchas across sessions'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'recallNotes', () => runRecallCommand(cmd));
  });

  // ---------------------------------------------------------------------
  // run / playtest / test
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('run <scene>')
      .description('run a scene headlessly for N frames and report script/runtime errors')
      .option('--frames <n>', 'frames to run', (v) => parseInt(v, 10)),
  ).action(async (scene: string, opts, cmd) => {
    await guarded(cmd, 'runScene', () =>
      runAndEmit(
        cmd,
        'runScene',
        { scene, frames: opts.frames },
        { okIf: (data) => (data as { passed: boolean }).passed },
      ),
    );
  });

  addGlobalOptions(
    program
      .command('playtest [name]')
      .description('run one playtest by name, or all playtests (--all or no name)')
      .option('--all', 'run every playtest'),
  ).action(async (name: string | undefined, opts, cmd) => {
    await guarded(cmd, 'playtest', () => runPlaytestCommand(cmd, name, !!opts.all));
  });

  addGlobalOptions(program.command('test').description('CI command: validate the project and run all playtests')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'test', () => runTestCommand(cmd));
    },
  );

  // ---------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('build')
      .description('validate then export the project to build/ (requires --allow build or all)')
      .option('--out <dir>', 'output directory', 'build'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'buildProject', () => runAndEmit(cmd, 'buildProject', { outDir: opts.out }));
  });

  // ---------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------
  const exportGroup = program.command('export').description('export the project for distribution');
  addGlobalOptions(exportGroup);
  addGlobalOptions(
    exportGroup
      .command('web')
      .description(
        'export a static, self-contained playable web build (requires --allow build or all). ' +
          '--zip also writes <project-slug>-web.zip next to the output folder (itch.io-ready)',
      )
      .option('--out <dir>', 'output directory (project-relative)', 'export/web')
      .option('--single-file', 'emit one index.html with the player and assets inlined')
      .option('--zip', 'also write <project-slug>-web.zip next to the output folder'),
  ).action(async (opts, cmd) => {
    await guarded(cmd, 'exportWeb', async () => {
      const g = globalOpts(cmd);
      const session = await openSession(g);
      const result = await session.execute<{ outDir: string; slug: string }>('exportWeb', {
        outDir: opts.out,
        singleFile: !!opts.singleFile,
      });
      if (result.success && opts.zip && result.data) {
        const zipRel = await zipExportedWebDir(session.root, result.data.outDir, result.data.slug);
        (result.data as Record<string, unknown>).zip = zipRel;
        result.files.push(zipRel);
      }
      process.exitCode = emit(result, g);
    });
  });

  addGlobalOptions(
    exportGroup
      .command('desktop')
      .description(
        'export native desktop builds: wraps the web build in an Electron shell and zips one app per platform ' +
          '(requires --allow build or all)',
      )
      .option('--out <dir>', 'output directory (project-relative)', 'export/desktop')
      .option(
        '--platform <id>',
        `target platform id (repeatable; default: all four: ${DESKTOP_PLATFORMS.join(', ')})`,
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      ),
  ).action(async (opts: { out: string; platform: string[] }, cmd) => {
    await guarded(cmd, 'exportDesktop', async () => {
      const g = globalOpts(cmd);
      for (const p of opts.platform) {
        if (!(DESKTOP_PLATFORMS as readonly string[]).includes(p)) {
          throw new ParseError(
            `Unknown --platform "${p}". Valid platforms: ${DESKTOP_PLATFORMS.join(', ')}`,
          );
        }
      }
      const session = await openSession(g);
      const result = await session.execute<{
        outDir: string;
        slug: string;
        builds: Array<{ platform: DesktopPlatformId; appDir: string; zip: string; signed: string; notarized: boolean }>;
      }>('exportDesktop', {
        outDir: opts.out,
        platforms: opts.platform.length > 0 ? opts.platform : undefined,
      });

      if (g.json) {
        process.exitCode = emit(result, g);
        return;
      }

      const capability = describeSigningCapability();
      const prefix = result.success ? '✓' : '✗';
      console.log(`${prefix} exportDesktop (signing: ${formatSigningCapability(capability)})`);
      if (result.success && result.data) {
        for (const build of result.data.builds) {
          console.log(`  ${build.platform}: ${build.zip} (signed: ${build.signed}${build.notarized ? ', notarized' : ''})`);
        }
      }
      for (const w of result.warnings) console.log(`  warning [${w.code}]: ${w.message}`);
      for (const e of result.errors) console.log(`  error [${e.code}]: ${e.message}`);
      process.exitCode = result.success ? 0 : 1;
    });
  });

  // ---------------------------------------------------------------------
  // screenshot
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('screenshot [scene]')
      .description(
        'capture a deterministic PNG screenshot of a scene via headless Chrome/Chromium. ' +
          'Scene defaults to the project\'s initial scene.',
      )
      .option('--frame <n>', 'fixed frames to step before capture (default: 0)', (v) => parseInt(v, 10))
      .option('--seed <n>', 'session seed (default: 0)', (v) => parseInt(v, 10))
      .option('--size <WxH>', 'canvas size, e.g. 800x600 (default: buildSettings size)')
      .option('--debug', 'enable the debug overlay (collider/velocity/light outlines)')
      .option('--out <path>', 'output PNG path, project-relative (absolute paths and ".." are rejected)', 'screenshot.png'),
  ).action(async (scene: string | undefined, opts, cmd) => {
    await guarded(cmd, 'screenshot', async () => {
      const g = globalOpts(cmd);
      const session = await openSession(g);
      // No permission gate: a screenshot is read-only observation (the visual
      // sibling of inspect/playtest), so the agent can always see its own work.
      const size = opts.size ? parseSize(opts.size) : undefined;
      const meta = await captureScreenshot(session.store, {
        scene,
        frame: opts.frame,
        seed: opts.seed,
        width: size?.width,
        height: size?.height,
        debug: !!opts.debug,
        out: opts.out,
      });
      process.exitCode = emit(makeResult('screenshot', true, meta, { files: [meta.path] }), g);
    });
  });

  // ---------------------------------------------------------------------
  // capture (frame sequence / contact sheet)
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('capture [scene]')
      .description(
        'capture a deterministic frame sequence of a scene via headless Chrome/Chromium and lay it out ' +
          'as a contact sheet (or one PNG per frame with --no-sheet). Scene defaults to the initial scene. ' +
          `At most ${MAX_SEQUENCE_FRAMES} frames per capture.`,
      )
      .requiredOption('--to <n>', 'last frame to capture (inclusive)', (v) => parseInt(v, 10))
      .option('--from <n>', 'first frame to capture (default: 0)', (v) => parseInt(v, 10))
      .option('--step <n>', 'frames between captures (default: auto, ≤32 frames)', (v) => parseInt(v, 10))
      .option('--no-sheet', 'emit one PNG per frame instead of a single contact sheet')
      .option('--seed <n>', 'session seed (default: 0)', (v) => parseInt(v, 10))
      .option('--size <WxH>', 'per-frame canvas size, e.g. 800x600 (default: buildSettings size)')
      .option('--out <path>', 'output PNG path, project-relative (absolute paths and ".." are rejected)', 'capture.png'),
  ).action(async (scene: string | undefined, opts, cmd) => {
    await guarded(cmd, 'capture', async () => {
      const g = globalOpts(cmd);
      const session = await openSession(g);
      // No permission gate: like screenshot, a capture is read-only observation.
      const size = opts.size ? parseSize(opts.size) : undefined;
      const meta = await captureSequence(session.store, {
        scene,
        from: opts.from,
        to: opts.to,
        step: opts.step,
        // commander's --no-sheet sets opts.sheet=false; absent leaves it undefined (default true).
        sheet: opts.sheet,
        seed: opts.seed,
        size,
        outPath: opts.out,
      });
      process.exitCode = emit(makeResult('capture', true, meta, { files: meta.outPaths }), g);
    });
  });

  // ---------------------------------------------------------------------
  // bench (headless performance)
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('bench [scene]')
      .description(
        'benchmark a scene headlessly: step warmup frames, then time N measured frames and report per-frame ' +
          'ms (avg/median/p95/max) so you can check whether it holds 60fps. Scene defaults to the initial scene.',
      )
      .option('--frames <n>', 'measured frames (default: 600)', (v) => parseInt(v, 10))
      .option('--warmup <n>', 'warmup frames, stepped but not measured (default: 60)', (v) => parseInt(v, 10))
      .option('--budget-ms <n>', 'per-frame budget in ms; adds a withinBudget verdict', (v) => parseFloat(v)),
  ).action(async (scene: string | undefined, opts, cmd) => {
    await guarded(cmd, 'benchScene', () =>
      runAndEmit(cmd, 'benchScene', {
        scene,
        frames: opts.frames,
        warmupFrames: opts.warmup,
        budgetMs: opts.budgetMs,
      }),
    );
  });

  // ---------------------------------------------------------------------
  // doctor
  // ---------------------------------------------------------------------
  addGlobalOptions(program.command('doctor').description('project + environment health report')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'doctor', () => runDoctorCommand(cmd));
    },
  );

  // ---------------------------------------------------------------------
  // commands
  // ---------------------------------------------------------------------
  addGlobalOptions(program.command('commands').description('list every available engine command (the full registry)')).action(
    async (opts, cmd) => {
      await guarded(cmd, 'commands', async () => {
        const g = globalOpts(cmd);
        const data = { commands: listCommands() };
        process.exitCode = emit(makeResult('commands', true, data), g);
      });
    },
  );

  return program;
}

// ---------------------------------------------------------------------------
// init helpers
// ---------------------------------------------------------------------------

async function resolveInitTarget(name: string, dirOpt: string | undefined): Promise<string> {
  const slug = slugify(name);
  if (!dirOpt) return path.join(process.cwd(), slug);
  const dirAbs = path.resolve(dirOpt);
  if (existsSync(dirAbs)) {
    const entries = await fsp.readdir(dirAbs);
    if (entries.length === 0) return dirAbs;
    // Non-empty existing directory: don't clobber it, nest the slug inside.
    return path.join(dirAbs, slug);
  }
  // Explicit, not-yet-existing target: use it directly.
  return dirAbs;
}

// ---------------------------------------------------------------------------
// export helpers
// ---------------------------------------------------------------------------

/**
 * Zip an exported web build (STORE-only, via @hearth/shipping's zipDirectory).
 * The archive contains the folder's files at its root (index.html at the top
 * level, as itch.io expects) and is written next to the folder as
 * <slug>-web.zip. Returns the project-relative zip path.
 */
async function zipExportedWebDir(projectRoot: string, outDirRel: string, slug: string): Promise<string> {
  const outAbs = path.resolve(projectRoot, outDirRel);
  const zipAbs = path.join(path.dirname(outAbs), `${slug}-web.zip`);
  await zipDirectory(outAbs, zipAbs);
  return path.relative(projectRoot, zipAbs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// playtest (single / all)
// ---------------------------------------------------------------------------

async function runPlaytestCommand(cmd: Command, name: string | undefined, all: boolean): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);

  if (name && !all) {
    const result = await session.execute('runPlaytest', { playtest: name });
    let code = emit(result, opts);
    if (code === 0 && !(result.data as { passed?: boolean } | null)?.passed) code = 1;
    process.exitCode = code;
    return;
  }

  const listResult = await session.execute<{ playtests: { id: string; name: string }[] }>('listPlaytests', {});
  if (!listResult.success) {
    process.exitCode = emit(listResult, opts);
    return;
  }
  const playtests = listResult.data?.playtests ?? [];
  const runs: unknown[] = [];
  let allPassed = true;
  const errors = [...listResult.errors];
  for (const pt of playtests) {
    const r = await session.execute('runPlaytest', { playtest: pt.id });
    runs.push({ name: pt.name, ...(r.data as object | null), success: r.success });
    if (!r.success || !(r.data as { passed?: boolean } | null)?.passed) allPassed = false;
    if (!r.success) errors.push(...r.errors);
  }
  const result = makeResult(
    'playtest',
    allPassed,
    { total: playtests.length, passed: runs.filter((r: any) => r.passed).length, runs },
    { errors },
  );
  process.exitCode = emit(result, opts);
}

// ---------------------------------------------------------------------------
// test (CI command)
// ---------------------------------------------------------------------------

async function runTestCommand(cmd: Command): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);

  const validation = await session.execute('validateProject', {});
  const validData = validation.data as { valid: boolean } | null;

  const listResult = await session.execute<{ playtests: { id: string; name: string }[] }>('listPlaytests', {});
  const playtests = listResult.data?.playtests ?? [];
  const runs: unknown[] = [];
  let playtestsPassed = true;
  for (const pt of playtests) {
    const r = await session.execute('runPlaytest', { playtest: pt.id });
    runs.push({ name: pt.name, ...(r.data as object | null), success: r.success });
    if (!r.success || !(r.data as { passed?: boolean } | null)?.passed) playtestsPassed = false;
  }

  const success = validation.success && !!validData?.valid && playtestsPassed;
  const errors = [...validation.errors, ...(listResult.success ? [] : listResult.errors)];
  const warnings = [...validation.warnings];
  const result = makeResult(
    'test',
    success,
    { validate: validation.data, playtests: { total: playtests.length, runs } },
    { errors, warnings },
  );
  process.exitCode = emit(result, opts);
}

// ---------------------------------------------------------------------------
// history (custom human formatting: one compact line per entry)
// ---------------------------------------------------------------------------

interface HistoryEntryView {
  seq: number;
  command: string;
  summary: string;
  undone: boolean;
}

async function runHistoryCommand(cmd: Command): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);
  const result = await session.execute<{ entries: HistoryEntryView[]; cursor: number }>('listHistory', {});
  if (opts.json || !result.success) {
    process.exitCode = emit(result, opts);
    return;
  }
  const entries = result.data?.entries ?? [];
  console.log('✓ listHistory');
  if (entries.length === 0) {
    console.log('  (no recorded history yet)');
  } else {
    for (const entry of entries) {
      const marker = entry.undone ? '~' : ' ';
      // `summary` already leads with the command name (see summarizeCommand in
      // core's session.ts), e.g. "createScene Level2" — don't repeat it.
      console.log(`${marker} [${entry.seq}] ${entry.summary}`);
    }
  }
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// log (command journal: custom human formatting, one compact line per entry)
// ---------------------------------------------------------------------------

interface JournalEntryView {
  seq: number;
  source: string;
  summary: string;
  ok: boolean;
  error?: string;
}

async function runLogCommand(cmd: Command, since: number | undefined, limit: number | undefined): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);
  const result = await session.execute<{ entries: JournalEntryView[]; lastSeq: number }>('listJournal', {
    since,
    limit,
  });
  if (opts.json || !result.success) {
    process.exitCode = emit(result, opts);
    return;
  }
  const entries = result.data?.entries ?? [];
  console.log('✓ listJournal');
  if (entries.length === 0) {
    console.log('  (no recorded journal entries yet)');
  } else {
    for (const entry of entries) {
      // `summary` already leads with the command name (see summarizeCommand in
      // core's session.ts), e.g. "createScene Level2" — don't repeat it.
      const suffix = entry.ok ? '' : ` (${entry.error})`;
      console.log(`#${entry.seq} [${entry.source}] ${entry.summary}${suffix}`);
    }
  }
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// recall (custom human formatting: print the memory markdown directly, so
// `hearth recall` reads like a document rather than a JSON envelope)
// ---------------------------------------------------------------------------
async function runRecallCommand(cmd: Command): Promise<void> {
  const opts = globalOpts(cmd);
  const session = await openSession(opts);
  const result = await session.execute<{ memory: string }>('recallNotes', {});
  if (opts.json || !result.success) {
    process.exitCode = emit(result, opts);
    return;
  }
  process.stdout.write((result.data?.memory ?? '') + '\n');
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// check-script (custom human formatting: one "path:line message" line per
// diagnostic, matching `hearth validate`'s exit-code-on-invalid behavior)
// ---------------------------------------------------------------------------

interface CheckScriptDiagnostic {
  line: number | null;
  message: string;
  severity: 'error' | 'warning';
}

async function runEditScriptCommand(
  cmd: Command,
  scriptPath: string,
  opts: { sourceFile?: string; format?: boolean },
): Promise<void> {
  const source = opts.sourceFile ? await fsp.readFile(path.resolve(opts.sourceFile), 'utf8') : await readStdin();
  if (source === null) {
    throw new CliError('INVALID_INPUT', 'edit-script needs --source-file <path>, or source piped via stdin.');
  }
  // commander's --no-format sets opts.format=false; absent means "use the
  // project's codeStyle.formatOnSave" (send nothing).
  const format = opts.format === false ? false : undefined;
  await runAndEmit(cmd, 'editScript', { path: scriptPath, source, format });
}

async function runFormatScriptCommand(
  cmd: Command,
  scriptPath: string | undefined,
  opts: { all?: boolean },
): Promise<void> {
  if (opts.all) {
    await runAndEmit(cmd, 'formatScript', { all: true });
  } else if (scriptPath) {
    await runAndEmit(cmd, 'formatScript', { path: scriptPath });
  } else {
    throw new CliError('INVALID_INPUT', 'script format needs a <path> or --all.');
  }
}

async function runSearchScriptsCommand(
  cmd: Command,
  query: string,
  opts: { regex?: boolean; case?: boolean; glob?: string },
): Promise<void> {
  const g = globalOpts(cmd);
  const session = await openSession(g);
  const result = await session.execute<{
    matches: Array<{ path: string; line: number; column: number; preview: string }>;
    total: number;
    capped: boolean;
  }>('searchScripts', { query, regex: opts.regex, caseSensitive: opts.case, pathGlob: opts.glob });

  if (g.json) {
    process.exitCode = emit(result, g);
    return;
  }

  if (!result.success) {
    console.log('✗ searchScripts');
    for (const e of result.errors) console.log(`  error [${e.code}]: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  for (const m of result.data!.matches) {
    console.log(`${m.path}:${m.line}:${m.column}  ${m.preview}`);
  }
  if (result.data!.capped) {
    console.log(
      `  (capped at ${result.data!.matches.length} of ${result.data!.total} matches; narrow with --glob)`,
    );
  }
  // A search finding zero matches is not a failure — exit 0 regardless.
  process.exitCode = 0;
}

async function runReplaceScriptsCommand(
  cmd: Command,
  query: string,
  replacement: string,
  opts: { regex?: boolean; case?: boolean; glob?: string; dryRun?: boolean },
): Promise<void> {
  const g = globalOpts(cmd);
  const session = await openSession(g);
  const result = await session.execute<{
    changes: Array<{ path: string; count: number; preview?: string }>;
    total: number;
    applied: boolean;
  }>('replaceInScripts', {
    query,
    replacement,
    regex: opts.regex,
    caseSensitive: opts.case,
    pathGlob: opts.glob,
    dryRun: opts.dryRun,
  });

  if (g.json) {
    process.exitCode = emit(result, g);
    return;
  }

  if (!result.success) {
    console.log('✗ replaceInScripts');
    for (const e of result.errors) console.log(`  error [${e.code}]: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.data!.applied ? '✓ replaceInScripts' : '✓ replaceInScripts (dry run: nothing written)');
  for (const c of result.data!.changes) {
    console.log(`  ${c.path}: ${c.count} replacement${c.count === 1 ? '' : 's'}`);
  }
  console.log(`  total: ${result.data!.total}`);
  process.exitCode = 0;
}

async function runCheckScriptCommand(
  cmd: Command,
  scriptPath: string,
  opts: { source?: string; language?: string },
): Promise<void> {
  const g = globalOpts(cmd);
  const session = await openSession(g);

  const params: Record<string, unknown> = {};
  if (opts.source !== undefined) {
    // Bare-source mode: never sent as `path` (checkScript reads `path` from
    // disk when present), so the language is inferred here from <path>'s
    // extension unless overridden.
    params.source = opts.source;
    params.language = opts.language ?? (scriptPath.endsWith('.js') ? 'js' : 'lua');
  } else {
    params.path = scriptPath;
    if (opts.language) params.language = opts.language;
  }

  const result = await session.execute<{ valid: boolean; language: string; diagnostics: CheckScriptDiagnostic[] }>(
    'checkScript',
    params,
  );

  if (g.json) {
    let code = emit(result, g);
    if (code === 0 && !result.data!.valid) code = 1;
    process.exitCode = code;
    return;
  }

  console.log(`${result.success ? '✓' : '✗'} checkScript`);
  if (!result.success) {
    for (const e of result.errors) console.log(`  error [${e.code}]: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  for (const d of result.data!.diagnostics) {
    console.log(`${scriptPath}${d.line !== null ? `:${d.line}` : ''} ${d.message}`);
  }
  process.exitCode = result.data!.valid ? 0 : 1;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function runDoctorCommand(cmd: Command): Promise<void> {
  const opts = globalOpts(cmd);
  const notes: string[] = [];
  const warnings: { code: string; message: string }[] = [];
  const data: Record<string, unknown> = {
    nodeVersion: process.version,
  };

  let root: string | null = null;
  try {
    root = resolveProjectRoot(opts);
    data.projectRoot = root;
    data.projectFound = true;
  } catch {
    data.projectFound = false;
    data.projectRoot = null;
    notes.push('No Hearth project found from the current directory (or --project).');
  }

  let session: HearthSession | null = null;
  if (root) {
    try {
      session = await openSession(opts);
      data.loads = true;
    } catch (err) {
      data.loads = false;
      data.loadError = (err as Error).message;
      warnings.push({ code: 'LOAD_FAILED', message: (err as Error).message });
    }
  }

  if (session) {
    const report = await validateProject(session.store);
    data.validation = { valid: report.valid, errors: report.errors.length, warnings: report.warnings.length };
    data.counts = {
      scenes: session.store.project.scenes.length,
      entities: [...session.store.scenes.values()].reduce((n, s) => n + s.entities.length, 0),
      assets: session.store.assets.assets.length,
      scripts: (await session.store.listScripts()).length,
      playtests: session.store.playtests.size,
    };
    const baselinePath = path.join(session.root, '.hearth', 'baseline.json');
    data.baselineExists = existsSync(baselinePath);
    data.grantedPermissions = session.granted;
    data.permissionNote = `Modes not granted require --allow <mode> or --allow all. Available: ${PERMISSION_MODES.join(', ')}.`;
  }

  const success = data.projectFound === false ? true : data.loads !== false && (data.validation as any)?.valid !== false;
  const result = makeResult('doctor', success, data, { warnings });
  if (!opts.json) {
    console.log(`hearth doctor`);
    console.log(`  node: ${data.nodeVersion}`);
    console.log(`  project found: ${data.projectFound}`);
    if (data.projectRoot) console.log(`  project root: ${data.projectRoot}`);
    if ('loads' in data) console.log(`  loads: ${data.loads}`);
    if (data.validation) {
      const v = data.validation as { valid: boolean; errors: number; warnings: number };
      console.log(`  validation: ${v.valid ? 'valid' : 'INVALID'} (${v.errors} errors, ${v.warnings} warnings)`);
    }
    if (data.counts) {
      const c = data.counts as Record<string, number>;
      console.log(`  counts: scenes=${c.scenes} entities=${c.entities} assets=${c.assets} scripts=${c.scripts} playtests=${c.playtests}`);
    }
    if ('baselineExists' in data) console.log(`  baseline: ${data.baselineExists ? 'present' : 'none'}`);
    if (data.grantedPermissions) console.log(`  permissions granted: ${(data.grantedPermissions as string[]).join(', ')}`);
    for (const note of notes) console.log(`  note: ${note}`);
    for (const w of warnings) console.log(`  warning [${w.code}]: ${w.message}`);
    process.exitCode = success ? 0 : 1;
  } else {
    process.exitCode = emit(result, opts);
  }
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString('utf8');
}
