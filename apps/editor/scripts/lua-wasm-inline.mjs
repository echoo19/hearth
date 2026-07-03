/**
 * esbuild inject shim: makes the single-file Node bundles (Electron main,
 * hearth-cli.mjs, hearth-mcp.mjs) self-contained for Lua projects.
 *
 * wasmoon normally locates glue.wasm next to its own module on disk via
 * __filename/__dirname — which points at the *bundle* after esbuild inlines
 * it. And in Node, wasmoon's emscripten loader cannot consume data: URIs
 * (it falls back to fs and dies with ENAMETOOLONG), so unlike the browser
 * player we cannot hand it the bytes inline. Instead the wasm ships inside
 * the bundle as base64 (esbuild loader '.wasm': 'base64'), gets
 * materialized once into a content-addressed file in the OS temp dir, and
 * setLuaWasmUri points wasmoon at that path. Inject files run before any
 * entry code, so the override is in place before the first Lua engine
 * boots. If the temp write fails we leave wasmoon's default resolution
 * alone — JS-only projects are unaffected either way.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import glueWasmBase64 from 'wasmoon/dist/glue.wasm';
import { setLuaWasmUri } from '@hearth/runtime/lua';

try {
  const bytes = Buffer.from(glueWasmBase64, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'hearth-lua-wasm');
  const wasmPath = join(dir, `glue-${hash}.wasm`);
  let ok = false;
  try {
    // Content-addressed cache hit only counts if the bytes really match
    // (the temp dir is shared; never trust a file just because it exists).
    ok = readFileSync(wasmPath).equals(bytes);
  } catch {
    /* not cached yet */
  }
  if (!ok) {
    mkdirSync(dir, { recursive: true });
    // Write-then-rename so concurrent CLI/MCP processes never observe a
    // half-written wasm file.
    const staging = join(dir, `glue-${hash}.${process.pid}.tmp`);
    writeFileSync(staging, bytes);
    renameSync(staging, wasmPath);
  }
  setLuaWasmUri(wasmPath);
} catch {
  // Best-effort: without the override, .lua projects will report a clear
  // engine-load error while everything else keeps working.
}
