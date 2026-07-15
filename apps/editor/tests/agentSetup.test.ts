/**
 * Tests for agent CLI detection and .mcp.json preparation.
 *
 * detectAgents() shells out to `which`/`--version`, so these tests point
 * PATH at real temp directories: an empty one to prove "missing" is clean,
 * and one with a fake executable script to prove "present" reports a
 * version. No real `claude`/`codex` binaries are invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, accessSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectAgents,
  prepareMcpConfig,
  prepareOpenCodeConfig,
  prepareHermesConfig,
  codexAddArgv,
  codexAlreadyConfigured,
  parseOllamaModels,
  ensureAgentSkill,
  McpConfigParseError,
} from '../server/agentSetup';
import yaml from 'js-yaml';
import { AGENT_SKILL_CONTENT, AGENT_SKILL_FILE, AGENT_CRAFT_SKILL_FILE } from '@hearth/core';

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-agentsetup-'));
  savedPath = process.env.PATH;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// Minimal system dirs so `which`/`where` itself is resolvable, without
// pulling in whatever real agent CLIs happen to be installed on the host
// running this test.
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d) => {
  try {
    accessSync(d);
    return true;
  } catch {
    return false;
  }
});

describe('detectAgents', () => {
  it('reports found=false cleanly when no agent binary is on PATH', async () => {
    process.env.PATH = SYSTEM_DIRS.join(path.delimiter);
    const result = await detectAgents();
    for (const tool of ['claude', 'codex', 'opencode', 'hermes', 'ollama'] as const) {
      expect(result[tool].found).toBe(false);
    }
    expect(result.claude.version).toBeUndefined();
    expect(result.ollama.models ?? []).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('detects opencode + reports an ollama model list', async () => {
    const binDir = path.join(tmpDir, 'bin');
    await fsp.mkdir(binDir, { recursive: true });
    const opencode = path.join(binDir, 'opencode');
    await fsp.writeFile(opencode, '#!/bin/sh\n[ "$1" = "--version" ] && echo "0.5.0"; exit 0\n');
    await fsp.chmod(opencode, 0o755);
    const ollama = path.join(binDir, 'ollama');
    await fsp.writeFile(
      ollama,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ollama version is 0.3.0"; exit 0; fi\n' +
        'if [ "$1" = "list" ]; then printf "NAME\\tID\\tSIZE\\nllama3:latest\\tabc\\t4GB\\nqwen2:7b\\tdef\\t4GB\\n"; exit 0; fi\nexit 1\n',
    );
    await fsp.chmod(ollama, 0o755);

    process.env.PATH = [binDir, ...SYSTEM_DIRS].join(path.delimiter);
    const result = await detectAgents();
    expect(result.opencode.found).toBe(true);
    expect(result.opencode.version).toBe('0.5.0');
    expect(result.ollama.found).toBe(true);
    expect(result.ollama.models).toEqual(['llama3:latest', 'qwen2:7b']);
  });

  // The fake binary is a `#!/bin/sh` script made executable via chmod — that
  // is a POSIX-only mechanism. On Windows `where` won't resolve an
  // extension-less script, and even a `.cmd` shim would trip Node's post-CVE
  // restriction on spawning batch files without `shell: true`, so the version
  // never comes back. Faking that faithfully would mean changing production
  // spawn behavior, which is out of scope here; the found=false path above
  // still exercises detection on Windows, and this found=true+version path is
  // covered on the Linux and macOS CI runners.
  it.skipIf(process.platform === 'win32')(
    'reports found=true with a version when the binary is on PATH',
    async () => {
      const binDir = path.join(tmpDir, 'bin');
      await fsp.mkdir(binDir, { recursive: true });
      const script = path.join(binDir, 'claude');
      await fsp.writeFile(
        script,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude-fake 1.2.3"; exit 0; fi\nexit 1\n',
      );
      await fsp.chmod(script, 0o755);

      process.env.PATH = [binDir, ...SYSTEM_DIRS].join(path.delimiter);
      const result = await detectAgents();
      expect(result.claude.found).toBe(true);
      expect(result.claude.version).toBe('claude-fake 1.2.3');
      // codex still absent.
      expect(result.codex.found).toBe(false);
    },
  );
});

describe('prepareMcpConfig', () => {
  it('creates .mcp.json fresh with the hearth entry', async () => {
    const root = path.join(tmpDir, 'proj-fresh');
    await fsp.mkdir(root, { recursive: true });

    const result = await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    expect(result.written).toBe(true);

    const raw = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.hearth).toEqual({
      command: 'node',
      args: ['/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit'],
    });
  });

  it('merges into an existing .mcp.json, preserving another server', async () => {
    const root = path.join(tmpDir, 'proj-merge');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'python', args: ['other.py'] } } }, null, 2),
    );

    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'full');

    const parsed = JSON.parse(await fsp.readFile(path.join(root, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'python', args: ['other.py'] });
    expect(parsed.mcpServers.hearth).toEqual({
      command: 'node',
      args: ['/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit,code-edit,asset-edit'],
    });
  });

  it('is idempotent: re-running with the same args produces the same file', async () => {
    const root = path.join(tmpDir, 'proj-idempotent');
    await fsp.mkdir(root, { recursive: true });

    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'all');
    const first = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'all');
    const second = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');

    expect(second).toBe(first);
  });

  it('refuses to clobber an .mcp.json that fails to parse', async () => {
    const root = path.join(tmpDir, 'proj-broken');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, '.mcp.json'), '{ not valid json');

    await expect(prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'read-only')).rejects.toThrow(
      McpConfigParseError,
    );

    // The broken file must be untouched.
    const raw = await fsp.readFile(path.join(root, '.mcp.json'), 'utf8');
    expect(raw).toBe('{ not valid json');
  });

  it('no-ops (written=false, alreadyConfigured) when the entry is already correct', async () => {
    const root = path.join(tmpDir, 'proj-noop');
    await fsp.mkdir(root, { recursive: true });
    await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    const again = await prepareMcpConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    expect(again.written).toBe(false);
    expect(again.alreadyConfigured).toBe(true);
  });
});

describe('prepareOpenCodeConfig', () => {
  it('writes opencode.json with a local hearth mcp entry + $schema', async () => {
    const root = path.join(tmpDir, 'oc-fresh');
    await fsp.mkdir(root, { recursive: true });
    const result = await prepareOpenCodeConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    expect(result.written).toBe(true);

    const parsed = JSON.parse(await fsp.readFile(path.join(root, 'opencode.json'), 'utf8'));
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.mcp.hearth).toEqual({
      type: 'local',
      enabled: true,
      command: ['node', '/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit'],
    });
    // No ollama provider when no models were passed.
    expect(parsed.provider).toBeUndefined();
  });

  it('adds an ollama provider from local models, preserving other keys', async () => {
    const root = path.join(tmpDir, 'oc-ollama');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      path.join(root, 'opencode.json'),
      JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'], enabled: true } } }),
    );
    await prepareOpenCodeConfig(root, '/tools/hearth-mcp/main.js', 'full', ['llama3', 'qwen2']);

    const parsed = JSON.parse(await fsp.readFile(path.join(root, 'opencode.json'), 'utf8'));
    expect(parsed.theme).toBe('dark'); // preserved
    expect(parsed.mcp.other).toBeDefined(); // preserved
    expect(parsed.mcp.hearth.command).toContain('safe-edit,code-edit,asset-edit');
    expect(parsed.provider.ollama.npm).toBe('@ai-sdk/openai-compatible');
    expect(parsed.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
    expect(Object.keys(parsed.provider.ollama.models)).toEqual(['llama3', 'qwen2']);
  });

  it('never clobbers a user-configured ollama provider', async () => {
    const root = path.join(tmpDir, 'oc-userprovider');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      path.join(root, 'opencode.json'),
      JSON.stringify({ provider: { ollama: { name: 'my tuned ollama' } } }),
    );
    await prepareOpenCodeConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit', ['llama3']);
    const parsed = JSON.parse(await fsp.readFile(path.join(root, 'opencode.json'), 'utf8'));
    expect(parsed.provider.ollama).toEqual({ name: 'my tuned ollama' });
  });

  it('no-ops when hearth entry already matches and no provider is wanted', async () => {
    const root = path.join(tmpDir, 'oc-noop');
    await fsp.mkdir(root, { recursive: true });
    await prepareOpenCodeConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    const again = await prepareOpenCodeConfig(root, '/tools/hearth-mcp/main.js', 'safe-edit');
    expect(again.written).toBe(false);
    expect(again.alreadyConfigured).toBe(true);
  });
});

describe('prepareHermesConfig (YAML, isolated $HOME)', () => {
  it('merges mcp_servers.hearth into ~/.hermes/config.yaml, preserving other settings', async () => {
    const home = path.join(tmpDir, 'home-hermes-merge');
    await fsp.mkdir(path.join(home, '.hermes'), { recursive: true });
    await fsp.writeFile(
      path.join(home, '.hermes', 'config.yaml'),
      yaml.dump({ model: 'gpt-5', provider: 'openai' }),
    );
    const root = path.join(tmpDir, 'proj-hermes');
    const result = await prepareHermesConfig('/tools/hearth-mcp/main.js', root, 'safe-edit', home);
    expect(result.written).toBe(true);

    const parsed = yaml.load(await fsp.readFile(path.join(home, '.hermes', 'config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(parsed.model).toBe('gpt-5'); // preserved
    expect(parsed.provider).toBe('openai'); // preserved
    expect(parsed.mcp_servers).toEqual({
      hearth: {
        command: 'node',
        args: ['/tools/hearth-mcp/main.js', '--project', root, '--mode', 'safe-edit'],
      },
    });
  });

  it('creates ~/.hermes/config.yaml when absent', async () => {
    const home = path.join(tmpDir, 'home-hermes-fresh');
    const root = path.join(tmpDir, 'proj-hermes2');
    await prepareHermesConfig('/tools/hearth-mcp/main.js', root, 'read-only', home);
    const parsed = yaml.load(await fsp.readFile(path.join(home, '.hermes', 'config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((parsed.mcp_servers as Record<string, unknown>).hearth).toBeDefined();
  });

  it('no-ops when already configured, and refuses to clobber invalid YAML', async () => {
    const home = path.join(tmpDir, 'home-hermes-noop');
    const root = path.join(tmpDir, 'proj-hermes3');
    await prepareHermesConfig('/tools/hearth-mcp/main.js', root, 'safe-edit', home);
    const again = await prepareHermesConfig('/tools/hearth-mcp/main.js', root, 'safe-edit', home);
    expect(again.written).toBe(false);
    expect(again.alreadyConfigured).toBe(true);

    // A YAML scalar (not a mapping) must be refused, not overwritten.
    const badHome = path.join(tmpDir, 'home-hermes-bad');
    await fsp.mkdir(path.join(badHome, '.hermes'), { recursive: true });
    await fsp.writeFile(path.join(badHome, '.hermes', 'config.yaml'), 'just a string');
    await expect(prepareHermesConfig('/tools/hearth-mcp/main.js', root, 'safe-edit', badHome)).rejects.toThrow(
      McpConfigParseError,
    );
  });
});

describe('codex config helpers (pure — the CLI writes the TOML)', () => {
  it('codexAddArgv builds `mcp add hearth -- node <mcp> --project <root> --mode <m>`', () => {
    expect(codexAddArgv('/tools/hearth-mcp/main.js', '/proj', 'full')).toEqual([
      'mcp',
      'add',
      'hearth',
      '--',
      'node',
      '/tools/hearth-mcp/main.js',
      '--project',
      '/proj',
      '--mode',
      'safe-edit,code-edit,asset-edit',
    ]);
  });

  it('codexAlreadyConfigured matches when `codex mcp get` output targets this project+mode', () => {
    const getOutput =
      'hearth\n  command: node\n  args: /tools/hearth-mcp/main.js --project /proj --mode safe-edit\n';
    expect(codexAlreadyConfigured(getOutput, '/tools/hearth-mcp/main.js', '/proj', 'safe-edit')).toBe(true);
    // Different project → not already configured (must be updated).
    expect(codexAlreadyConfigured(getOutput, '/tools/hearth-mcp/main.js', '/other', 'safe-edit')).toBe(false);
  });
});

describe('parseOllamaModels', () => {
  it('extracts model names from `ollama list` output, skipping the header', () => {
    const out = 'NAME            ID      SIZE\nllama3:latest   abc     4.7 GB\nqwen2:7b        def     4.4 GB\n';
    expect(parseOllamaModels(out)).toEqual(['llama3:latest', 'qwen2:7b']);
  });

  it('returns [] for empty/daemon-down output', () => {
    expect(parseOllamaModels('')).toEqual([]);
    expect(parseOllamaModels('NAME  ID  SIZE\n')).toEqual([]);
  });
});

describe('ensureAgentSkill', () => {
  const skillRel = AGENT_SKILL_FILE.split('/');

  it('backfills the skill for a project that lacks it', async () => {
    const root = path.join(tmpDir, 'proj-no-skill');
    await fsp.mkdir(root, { recursive: true });

    const result = await ensureAgentSkill(root);
    expect(result.written).toBe(true);

    const written = await fsp.readFile(path.join(root, ...skillRel), 'utf8');
    expect(written).toBe(AGENT_SKILL_CONTENT);
  });

  it('never overwrites an existing skill file (preserves local edits)', async () => {
    const root = path.join(tmpDir, 'proj-has-skill');
    const skillPath = path.join(root, ...skillRel);
    // Seed BOTH backfilled skills so ensureAgentSkill has nothing to write —
    // it backfills the engine skill AND the craft skill.
    await fsp.mkdir(path.dirname(skillPath), { recursive: true });
    await fsp.writeFile(skillPath, 'my local edits');
    const craftPath = path.join(root, ...AGENT_CRAFT_SKILL_FILE.split('/'));
    await fsp.mkdir(path.dirname(craftPath), { recursive: true });
    await fsp.writeFile(craftPath, 'my craft edits');

    const result = await ensureAgentSkill(root);
    expect(result.written).toBe(false);
    expect(await fsp.readFile(skillPath, 'utf8')).toBe('my local edits');
    expect(await fsp.readFile(craftPath, 'utf8')).toBe('my craft edits');
  });
});
