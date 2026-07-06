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
import { captureScreenshot } from '@hearth/playtest';
import { CliError, openSession, resolveProjectRoot, type GlobalOpts } from './context.js';
import { emit, errorResult, makeResult, logStderr } from './output.js';
import { parseJsonArray, parseJsonObject, parseList, parsePosition, parseSize, parseFrameSize, parseValue, ParseError } from './parse.js';
import { createZip } from './zip.js';

// Hardcoded rather than imported from package.json: this package builds
// under NodeNext + esbuild-bundled single-file tool builds (see
// apps/editor/scripts/build-electron.mjs), and a JSON import needs an
// import-attribute syntax (`with { type: 'json' }`) that's a bigger change
// than a version bump justifies here. Keep this in sync with package.json's
// "version" on every release — see the version-bump checklist in
// .superpowers/sdd/task-12-report.md.
const VERSION = '0.6.0';

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
    .description('hearth — the Hearth engine command-line interface for humans and coding agents')
    .version(VERSION)
    .showHelpAfterError(true);
  addGlobalOptions(program);

  // ---------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('init <name>')
      .description('create a new Hearth project')
      .option('--dir <path>', 'target directory (default: ./<slug-of-name> under cwd)')
      .option('--description <text>', 'project description')
      .option('--no-starter', 'skip the starter scene (camera + ground + player)')
      .option('--width <n>', 'build width in pixels', (v) => parseInt(v, 10))
      .option('--height <n>', 'build height in pixels', (v) => parseInt(v, 10)),
  ).action(async (name: string, opts, cmd: Command) => {
    await guarded(cmd, 'init', async () => {
      const g = globalOpts(cmd);
      const target = await resolveInitTarget(name, opts.dir);
      await fsp.mkdir(target, { recursive: true });
      const { files } = await createProject(new NodeFileSystem(), target, {
        name,
        description: opts.description,
        starterScene: opts.starter !== false,
        width: opts.width,
        height: opts.height,
      });
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
      .description('create a script from the standard template (Lua by default)')
      .option('--language <language>', 'scripting language: lua (default) or js')
      .option('--source-file <path>', 'read initial source from a file instead of the template'),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createScript', async () => {
      const source = opts.sourceFile ? await fsp.readFile(path.resolve(opts.sourceFile), 'utf8') : undefined;
      await runAndEmit(cmd, 'createScript', { name, language: opts.language, source });
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
      .option('--corner-radius <n>', 'corner radius', (v) => parseFloat(v)),
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
      }),
    );
  });
  addGlobalOptions(
    createAsset
      .command('tile <name>')
      .description('create a procedural tile asset')
      .option('--color <color>', 'hex or named color')
      .option('--size <n>', 'tile size in px', (v) => parseInt(v, 10)),
  ).action(async (name: string, opts, cmd) => {
    await guarded(cmd, 'createTileAsset', () =>
      runAndEmit(cmd, 'createTileAsset', { name, color: opts.color, size: opts.size }),
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
  addGlobalOptions(
    program
      .command('set <scene> <entity> <property> <value>')
      .description('set a component property, e.g. hearth set MyScene Coin Transform.position.x 200'),
  ).action(async (scene: string, entity: string, property: string, value: string, opts, cmd) => {
    await guarded(cmd, 'setComponentProperty', () =>
      runAndEmit(cmd, 'setComponentProperty', { scene, entity, property, value: parseValue(value) }),
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
      .description('update project settings: partial buildSettings (deep-merged), initial scene, input mappings')
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
      .option('--input-deadzone <number>', 'global gamepad stick deadzone (0-1)', (v) => parseFloat(v)),
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
      return runAndEmit(cmd, 'updateSettings', params);
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

  addGlobalOptions(
    program
      .command('edit-script <path>')
      .description('replace the full source of a script file')
      .option('--source-file <path>', 'read new source from a file instead of stdin'),
  ).action(async (scriptPath: string, opts, cmd) => {
    await guarded(cmd, 'editScript', async () => {
      const source = opts.sourceFile
        ? await fsp.readFile(path.resolve(opts.sourceFile), 'utf8')
        : await readStdin();
      if (source === null) {
        throw new CliError('INVALID_INPUT', 'edit-script needs --source-file <path>, or source piped via stdin.');
      }
      await runAndEmit(cmd, 'editScript', { path: scriptPath, source });
    });
  });

  // ---------------------------------------------------------------------
  // import
  // ---------------------------------------------------------------------
  const importGroup = program.command('import').description('import external files as assets');
  addGlobalOptions(importGroup);
  addGlobalOptions(
    importGroup
      .command('asset <source-path>')
      .description('import an external file into assets/ and register it')
      .option('--name <name>', 'asset name (default: filename without extension)')
      .option('--type <type>', 'asset type override (sprite, tile, audio, animation, font, data, other)'),
  ).action(async (sourcePath: string, opts, cmd) => {
    await guarded(cmd, 'importAsset', () =>
      runAndEmit(cmd, 'importAsset', { sourcePath, name: opts.name, type: opts.type }),
    );
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

  const del = program.command('delete').description('delete a scene or entity');
  addGlobalOptions(del);
  addGlobalOptions(del.command('scene <scene>').description('delete a scene')).action(async (scene: string, opts, cmd) => {
    await guarded(cmd, 'deleteScene', () => runAndEmit(cmd, 'deleteScene', { scene }));
  });
  addGlobalOptions(del.command('entity <scene> <entity>').description('delete an entity')).action(
    async (scene: string, entity: string, opts, cmd) => {
      await guarded(cmd, 'deleteEntity', () => runAndEmit(cmd, 'deleteEntity', { scene, entity }));
    },
  );

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
        const zipRel = await zipExportedDir(session.root, result.data.outDir, result.data.slug);
        (result.data as Record<string, unknown>).zip = zipRel;
        result.files.push(zipRel);
      }
      process.exitCode = emit(result, g);
    });
  });

  // ---------------------------------------------------------------------
  // screenshot
  // ---------------------------------------------------------------------
  addGlobalOptions(
    program
      .command('screenshot [scene]')
      .description(
        'capture a deterministic PNG screenshot of a scene via headless Chrome/Chromium ' +
          '(requires --allow build or all). Scene defaults to the project\'s initial scene.',
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
      if (!hasPermission(session.granted, 'build')) {
        throw new CliError('PERMISSION_DENIED', new PermissionError('build', session.granted, 'screenshot').message);
      }
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
 * Zip an exported web build (STORE-only). The archive contains the folder's
 * files at its root (index.html at the top level, as itch.io expects) and is
 * written next to the folder as <slug>-web.zip. Returns the project-relative
 * zip path.
 */
async function zipExportedDir(projectRoot: string, outDirRel: string, slug: string): Promise<string> {
  const outAbs = path.resolve(projectRoot, outDirRel);
  const entries: { path: string; data: Uint8Array }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else entries.push({ path: path.relative(outAbs, abs).split(path.sep).join('/'), data: await fsp.readFile(abs) });
    }
  };
  await walk(outAbs);
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const zipAbs = path.join(path.dirname(outAbs), `${slug}-web.zip`);
  await fsp.writeFile(zipAbs, createZip(entries));
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
