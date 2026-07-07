#!/usr/bin/env node
/**
 * Headless benchmark harness.
 *
 * Steps each scenario in ./scenarios.mjs through a GameSession
 * (wall-clock-free `session.step()` — no DOM, no pixi, no setTimeout) for a
 * warmup window (untimed) followed by a timed window, and reports
 * mean/p95/max ms-per-frame plus the steady live entity count.
 *
 * Usage:
 *   node packages/runtime/bench/bench.mjs            full run: 120 warmup + 1000 timed frames
 *   node packages/runtime/bench/bench.mjs --smoke     fast harness check: 10 + 10 frames, no thresholds
 *   node packages/runtime/bench/bench.mjs --json       machine-readable output instead of the table
 *
 * Requires @hearth/core and @hearth/runtime's compiled `dist` output (run
 * `npm run build:packages` first — `npm run bench` does this for you).
 */
let GameSession, SCENARIOS;
try {
  ({ GameSession } = await import('@hearth/runtime'));
  ({ SCENARIOS } = await import('./scenarios.mjs'));
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      'bench: could not resolve @hearth/core or @hearth/runtime — run `npm run build:packages` first (or use `npm run bench`).',
    );
    process.exit(1);
  }
  throw err;
}

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const json = args.includes('--json');

const WARMUP_FRAMES = smoke ? 10 : 120;
const TIMED_FRAMES = smoke ? 10 : 1000;
/** Fixed across every scenario/run so before/after comparisons only vary by engine changes. */
const SEED = 424242;

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

async function runScenario(scenario) {
  const store = await scenario.build();
  const session = await GameSession.create(store, { seed: SEED });
  try {
    for (let i = 0; i < WARMUP_FRAMES; i++) session.step();

    const samples = new Array(TIMED_FRAMES);
    for (let i = 0; i < TIMED_FRAMES; i++) {
      const start = performance.now();
      session.step();
      samples[i] = performance.now() - start;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    return {
      name: scenario.name,
      frames: TIMED_FRAMES,
      meanMs: mean,
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
      entities: session.runtime.getEntities().length,
      errors: session.errors.length,
    };
  } finally {
    session.destroy();
  }
}

function formatTable(results) {
  const headers = ['scenario', 'mean ms', 'p95 ms', 'max ms', 'entities', 'errors'];
  const rows = results.map((r) => [
    r.name,
    r.meanMs.toFixed(3),
    r.p95Ms.toFixed(3),
    r.maxMs.toFixed(3),
    String(r.entities),
    String(r.errors),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

async function main() {
  const results = [];
  let failed = false;

  for (const scenario of SCENARIOS) {
    try {
      const result = await runScenario(scenario);
      results.push(result);
      if (result.errors > 0) {
        failed = true;
        console.error(`scenario "${scenario.name}" produced ${result.errors} runtime error(s)`);
      }
    } catch (err) {
      failed = true;
      console.error(`scenario "${scenario.name}" failed: ${err?.stack ?? err}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ node: process.version, smoke, warmupFrames: WARMUP_FRAMES, timedFrames: TIMED_FRAMES, results }, null, 2));
  } else {
    console.log(
      `node ${process.version}, ${smoke ? 'smoke' : 'full'} mode (${WARMUP_FRAMES} warmup / ${TIMED_FRAMES} timed frames)\n`,
    );
    console.log(formatTable(results));
  }

  if (failed || results.length !== SCENARIOS.length) {
    process.exitCode = 1;
  }
}

main();
