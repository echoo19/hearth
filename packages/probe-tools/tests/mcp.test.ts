/**
 * The MCP surface, driven through the SDK's in-memory transport — a real
 * client, a real server, real JSON-RPC, no stdio and no subprocess.
 *
 * The contract under test is the one an agent depends on: the tool list is
 * complete and its descriptions teach the loop, and every tool result is the
 * same envelope the CLI prints. Tools that need a browser are exercised
 * through the ones that don't (report, install_shim) plus their input schemas.
 */
import { describe, it, expect } from 'vitest';
import { shellQuote } from '../src/target.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createProbeMcpServer }  from '../src/mcp.js';
import { SHIM_FILENAME } from '../src/actions.js';
import type { Envelope } from '../src/envelope.js';
import type { SweepView } from '../src/format.js';
import { cannedReport } from './support.js';

const TOOL_NAMES = [
  'probe_sweep',
  'probe_screenshot',
  'probe_report',
  'probe_capabilities',
  'probe_install_shim',
];

async function connect(root: string): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createProbeMcpServer({ root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe-tools-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Pull the JSON envelope out of a tool result's text block. */
function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  const text = result.content.find((part) => part.type === 'text');
  if (!text || text.type !== 'text') throw new Error('tool result carried no text block');
  return JSON.parse(text.text) as Envelope<T>;
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'hearth-probe-mcp-'));
}

describe('the probe MCP server', () => {
  it('lists exactly the five probe tools', async () => {
    const root = await tempRoot();
    const { client, close } = await connect(root);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('teaches the loop and names the evidence directory in its descriptions', async () => {
    const root = await tempRoot();
    const { client, close } = await connect(root);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description ?? '').toContain('probe_sweep');
        expect((tool.description ?? '').toLowerCase()).toContain('fix');
      }
      const sweep = tools.find((t) => t.name === 'probe_sweep')!;
      expect(sweep.description).toContain('.hearth/evidence');
      expect(sweep.description).toContain('Hearth app');
      expect(sweep.description).toContain('repro');
      // Zod shapes made it across as a real JSON schema.
      expect(Object.keys(sweep.inputSchema.properties ?? {}).sort()).toEqual([
        'dir',
        'maxSteps',
        'out',
        'policies',
        'seedStart',
        'seeds',
        'stepMs',
        'url',
      ]);
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers probe_report with the same envelope the CLI prints', async () => {
    const root = await tempRoot();
    const dir = path.join(root, '.hearth/evidence/sweeps/0003');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify(cannedReport({ evidenceDir: dir, target: root })),
    );

    const { client, close } = await connect(root);
    try {
      const result = (await client.callTool({ name: 'probe_report', arguments: {} })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const envelope = envelopeOf<SweepView>(result);
      expect(envelope.success).toBe(true);
      expect(envelope.command).toBe('report');
      expect(envelope.errors).toEqual([]);
      expect(envelope.data!.sweepId).toBe('0003');
      expect(envelope.data!.passed).toBe(false);
      expect(envelope.data!.failures[0]!.repro).toBe(
        `hearth-probe sweep ${shellQuote(root)} --policies mash --seeds 1 --seed-start 3`,
      );
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flags a failing tool result as an error and keeps the envelope shape', async () => {
    const root = await tempRoot();
    const { client, close } = await connect(root);
    try {
      const result = (await client.callTool({ name: 'probe_report', arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      const envelope = envelopeOf(result);
      expect(envelope.success).toBe(false);
      expect(envelope.data).toBeNull();
      expect(envelope.errors[0]!.code).toBe('NO_EVIDENCE');
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs the shim into a directory under the project root', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'game'), { recursive: true });
    const { client, close } = await connect(root);
    try {
      const result = (await client.callTool({
        name: 'probe_install_shim',
        arguments: { dir: 'game' },
      })) as CallToolResult;
      const envelope = envelopeOf<{ path: string; snippet: string }>(result);
      expect(envelope.success).toBe(true);
      expect(envelope.data!.path).toBe(path.join(root, 'game', SHIM_FILENAME));
      expect(envelope.data!.snippet.split('\n')).toHaveLength(2);
      expect(await readFile(envelope.data!.path, 'utf8')).toContain('__hearthProbe');
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-schema argument before it reaches the probe', async () => {
    const root = await tempRoot();
    const { client, close } = await connect(root);
    try {
      const result = (await client.callTool({
        name: 'probe_sweep',
        arguments: { seeds: 0 },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
