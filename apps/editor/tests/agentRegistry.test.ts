/**
 * The registry of agents the user brought themselves.
 *
 * An entry here is a COMMAND LINE Hearth will spawn, which makes three of these
 * tests security tests rather than storage tests:
 *
 *   1. it is stored PER MACHINE, in `~/.hearth/`, and never inside a project.
 *      A folder carrying a command line would run it on whoever opened the
 *      folder next;
 *   2. confirmation is stored as the command string that was confirmed, so
 *      editing an agent into something else cannot inherit the yes given to the
 *      old command;
 *   3. everything that can go wrong reads as NO agents. There is no state in
 *      which failing to read this file makes Hearth spawn something.
 *
 * The rest is the shape the pane and the picker depend on: the cap refuses
 * rather than evicting somebody's configuration, and every write answers with
 * the whole list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_CUSTOM_AGENTS,
  agentCommandLine,
  agentRegistryPath,
  confirmCustomAgent,
  deleteCustomAgent,
  getAgents,
  isAgentConfirmed,
  mintAgentId,
  postAgents,
  readCustomAgent,
  readCustomAgents,
  toWire,
  writeCustomAgent,
} from '../server/agentRegistry';

let home = '';
let previous: string | undefined;

beforeEach(async () => {
  previous = process.env.HEARTH_HOME;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-agents-'));
  process.env.HEARTH_HOME = home;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.HEARTH_HOME;
  else process.env.HEARTH_HOME = previous;
  await fsp.rm(home, { recursive: true, force: true });
});

const wire = async (): Promise<{ agents: { id: string; commandLine: string; confirmed: boolean }[] }> =>
  (await getAgents()).body as { agents: { id: string; commandLine: string; confirmed: boolean }[] };

describe('where the registry lives', () => {
  it('writes to the machine home and nowhere near a project', async () => {
    await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: [] });
    expect(agentRegistryPath()).toBe(path.join(home, 'agents.json'));
    expect(await fsp.readFile(agentRegistryPath(), 'utf8')).toContain('my-agent');
  });

  it('keeps the whole file to one key, so nothing else can ride along', async () => {
    await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: ['--serve'] });
    const parsed = JSON.parse(await fsp.readFile(agentRegistryPath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['agents']);
  });

  it('removes the file once the last agent goes, rather than leaving an empty one', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: [] });
    await deleteCustomAgent(agent.id);
    await expect(fsp.readFile(agentRegistryPath(), 'utf8')).rejects.toThrow();
    expect(await readCustomAgents()).toEqual([]);
  });
});

describe('reading a file that has gone wrong', () => {
  it('reads no agents from a missing file', async () => {
    expect(await readCustomAgents()).toEqual([]);
  });

  it('reads no agents from bytes that are not JSON', async () => {
    await fsp.writeFile(agentRegistryPath(), 'not json at all');
    expect(await readCustomAgents()).toEqual([]);
  });

  it('reads no agents from JSON of the wrong shape', async () => {
    await fsp.writeFile(agentRegistryPath(), JSON.stringify(['my-agent']));
    expect(await readCustomAgents()).toEqual([]);
  });

  it('drops one rotted entry and keeps the rest', async () => {
    await fsp.writeFile(
      agentRegistryPath(),
      JSON.stringify({
        agents: {
          good: { label: 'Good', command: 'good-agent', args: ['--x'] },
          bad: { label: 'Bad', args: 7 },
          'no command': { label: 'Nameless' },
          'BAD ID': { label: 'Shouty', command: 'shouty' },
        },
      }),
    );
    expect((await readCustomAgents()).map((a) => a.id)).toEqual(['good']);
  });

  it('refuses an entry whose command carries a control character', async () => {
    await fsp.writeFile(
      agentRegistryPath(),
      JSON.stringify({ agents: { sneaky: { label: 'Sneaky', command: 'agent\nrm -rf /', args: [] } } }),
    );
    expect(await readCustomAgents()).toEqual([]);
  });

  it('falls back to the command when an entry lost its label', async () => {
    await fsp.writeFile(agentRegistryPath(), JSON.stringify({ agents: { a: { command: 'my-agent' } } }));
    expect((await readCustomAgents())[0].label).toBe('my-agent');
  });
});

describe('confirming a command', () => {
  it('starts unconfirmed, whatever the label says', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: [] });
    expect(isAgentConfirmed(agent)).toBe(false);
    expect(toWire(agent).confirmed).toBe(false);
  });

  it('confirms the exact command line', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: ['--serve'] });
    const confirmed = await confirmCustomAgent(agent.id);
    expect(confirmed.confirmedCommand).toBe('my-agent --serve');
    expect(isAgentConfirmed(confirmed)).toBe(true);
  });

  it('KEEPS the confirmation when only the label changes', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: ['--serve'] });
    await confirmCustomAgent(agent.id);
    const renamed = await writeCustomAgent({ id: agent.id, label: 'Renamed', command: 'my-agent', args: ['--serve'] });
    expect(isAgentConfirmed(renamed)).toBe(true);
  });

  it('LOSES the confirmation the moment the command changes', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: [] });
    await confirmCustomAgent(agent.id);
    const edited = await writeCustomAgent({ id: agent.id, label: 'My agent', command: 'rm', args: ['-rf', '/'] });
    expect(isAgentConfirmed(edited)).toBe(false);
    expect(edited.confirmedCommand).toBe('');
  });

  it('loses it for an added argument too, not only a new program', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: [] });
    await confirmCustomAgent(agent.id);
    const edited = await writeCustomAgent({
      id: agent.id,
      label: 'My agent',
      command: 'my-agent',
      args: ['--allow-anything'],
    });
    expect(isAgentConfirmed(edited)).toBe(false);
  });
});

describe('writing entries', () => {
  it('mints a readable id from the label and keeps ids unique', async () => {
    const first = await writeCustomAgent({ label: 'My Agent', command: 'a', args: [] });
    const second = await writeCustomAgent({ label: 'My Agent', command: 'b', args: [] });
    expect(first.id).toBe('my-agent');
    expect(second.id).toBe('my-agent-2');
    expect(mintAgentId('!!!', new Set())).toBe('agent');
  });

  it('drops blank argument fields rather than passing empty strings', async () => {
    const agent = await writeCustomAgent({ label: 'My agent', command: 'my-agent', args: ['--serve', '', ' '] });
    expect(agent.args).toEqual(['--serve']);
    expect(agentCommandLine(agent)).toBe('my-agent --serve');
  });

  it('refuses a command that is only whitespace', async () => {
    await expect(writeCustomAgent({ label: 'My agent', command: '   ', args: [] })).rejects.toThrow();
  });

  it('refuses an edit to an agent that is gone', async () => {
    await expect(writeCustomAgent({ id: 'ghost', label: 'Ghost', command: 'ghost', args: [] })).rejects.toThrow();
  });

  it('leaves every other entry alone', async () => {
    const first = await writeCustomAgent({ label: 'First', command: 'first', args: [] });
    await confirmCustomAgent(first.id);
    await writeCustomAgent({ label: 'Second', command: 'second', args: [] });
    expect(isAgentConfirmed((await readCustomAgent(first.id))!)).toBe(true);
    expect((await readCustomAgents()).map((a) => a.id)).toEqual(['first', 'second']);
  });

  it('REFUSES past the cap rather than evicting somebody configuration', async () => {
    for (let n = 0; n < MAX_CUSTOM_AGENTS; n++) {
      await writeCustomAgent({ label: `Agent ${n}`, command: `agent-${n}`, args: [] });
    }
    await expect(writeCustomAgent({ label: 'One more', command: 'one-more', args: [] })).rejects.toThrow();
    // ...and the ones already there are untouched, which is the point.
    expect(await readCustomAgents()).toHaveLength(MAX_CUSTOM_AGENTS);
  });

  it('still allows an EDIT at the cap', async () => {
    for (let n = 0; n < MAX_CUSTOM_AGENTS; n++) {
      await writeCustomAgent({ label: `Agent ${n}`, command: `agent-${n}`, args: [] });
    }
    const edited = await writeCustomAgent({ id: 'agent-0', label: 'Agent 0', command: 'renamed', args: [] });
    expect(edited.command).toBe('renamed');
  });
});

describe('over HTTP', () => {
  it('answers a save with the whole list, ids and confirmation included', async () => {
    const result = await postAgents({ action: 'save', label: 'My agent', command: 'my-agent', args: ['--serve'] });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; agents: { id: string; commandLine: string; confirmed: boolean }[] };
    expect(body.ok).toBe(true);
    expect(body.agents).toEqual([
      { id: 'my-agent', label: 'My agent', command: 'my-agent', args: ['--serve'], commandLine: 'my-agent --serve', confirmed: false },
    ]);
  });

  it('confirms through the route, and says so in the list', async () => {
    await postAgents({ action: 'save', label: 'My agent', command: 'my-agent', args: [] });
    const result = await postAgents({ action: 'confirm', id: 'my-agent' });
    expect(result.status).toBe(200);
    expect((await wire()).agents[0].confirmed).toBe(true);
  });

  it('deletes through the route', async () => {
    await postAgents({ action: 'save', label: 'My agent', command: 'my-agent', args: [] });
    await postAgents({ action: 'delete', id: 'my-agent' });
    expect((await wire()).agents).toEqual([]);
  });

  it('refuses a body it does not recognise', async () => {
    expect((await postAgents({ command: 'my-agent' })).status).toBe(400);
    expect((await postAgents({ action: 'save', label: '', command: 'x' })).status).toBe(400);
    expect((await postAgents({ action: 'confirm', id: 'NOT AN ID' })).status).toBe(400);
    expect((await postAgents(null)).status).toBe(400);
  });

  it('refuses an extra field rather than storing it', async () => {
    const result = await postAgents({ action: 'save', label: 'My agent', command: 'my-agent', env: { KEY: 'x' } });
    expect(result.status).toBe(400);
  });

  it('reports a refusal as a message the pane can show', async () => {
    for (let n = 0; n < MAX_CUSTOM_AGENTS; n++) {
      await writeCustomAgent({ label: `Agent ${n}`, command: `agent-${n}`, args: [] });
    }
    const result = await postAgents({ action: 'save', label: 'One more', command: 'one-more' });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain(String(MAX_CUSTOM_AGENTS));
  });
});
