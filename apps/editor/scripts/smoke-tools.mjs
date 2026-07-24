#!/usr/bin/env node
/**
 * Smoke-test the BUNDLED agent tools (dist-electron/hearth-cli.mjs and
 * hearth-mcp.mjs) by actually running them — the single-file esbuild bundles,
 * not the per-package tsc source that the other CLI smoke step covers.
 *
 * This exists because those bundles shipped broken in v1.3.0–v1.3.2: an ESM
 * `__dirname` double-declaration (parse error) plus eager-eval of native/CJS
 * shipping deps (extract-zip, png2icons) made `hearth --version` and the MCP
 * server throw at startup — and nothing in CI ever executed the bundle. Run
 * this right after `app:bundle`, on every OS, so a broken bundle fails the
 * build instead of the user.
 *
 * Usage: node scripts/smoke-tools.mjs [distElectronDir] [projectDir]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..', '..');
const expectedVersion = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
).version;
const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(appRoot, 'dist-electron');
const projectDir = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, 'packages', 'examples', 'mini-platformer');

const cli = path.join(distDir, 'hearth-cli.mjs');
const mcp = path.join(distDir, 'hearth-mcp.mjs');
for (const f of [cli, mcp]) {
  if (!existsSync(f)) {
    console.error(`[smoke-tools] missing ${f} — run \`npm run app:bundle\` first`);
    process.exit(1);
  }
}

function fail(msg) {
  console.error(`[smoke-tools] FAIL: ${msg}`);
  process.exit(1);
}

// 1. The CLI bundle must run and print a version.
const cliOut = await new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => resolve({ code, out, err }));
});
if (cliOut.code !== 0) fail(`hearth-cli.mjs --version exited ${cliOut.code}: ${cliOut.err || cliOut.out}`);
const cliVersion = cliOut.out.trim();
if (cliVersion !== expectedVersion) {
  fail(`hearth-cli.mjs reported ${cliVersion || 'no version'}; expected ${expectedVersion}`);
}
console.log(`[smoke-tools] CLI ok: ${cliVersion}`);

// 2. The MCP bundle must boot and serve tools over stdio.
const mcpChild = spawn(process.execPath, [mcp, '--project', projectDir, '--mode', 'read-only'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const waiters = new Map();
mcpChild.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});
let mcpErr = '';
mcpChild.stderr.on('data', (d) => (mcpErr += d));
mcpChild.on('close', (code) => {
  if (code && code !== 0 && waiters.size) fail(`hearth-mcp.mjs exited ${code}: ${mcpErr}`);
});

let id = 0;
function rpc(method, params) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    waiters.set(mid, resolve);
    mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method} (stderr: ${mcpErr})`)), 20000);
  });
}

try {
  const initialized = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-tools', version: '1.0.0' },
  });
  const mcpVersion = initialized.result?.serverInfo?.version;
  if (mcpVersion !== expectedVersion) {
    fail(`hearth-mcp.mjs reported ${mcpVersion || 'no version'}; expected ${expectedVersion}`);
  }
  mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const tools = await rpc('tools/list', {});
  const count = (tools.result?.tools ?? []).length;
  if (count < 1) fail(`hearth-mcp.mjs served no tools`);
  console.log(`[smoke-tools] MCP ok: ${mcpVersion}, ${count} tools`);
} catch (e) {
  fail(e.message);
} finally {
  mcpChild.kill();
}
console.log('[smoke-tools] bundled agent tools OK');
process.exit(0);
