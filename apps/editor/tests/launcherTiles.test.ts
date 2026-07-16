/**
 * Pure tile-model tests for the Agent panel's "Launch your agent" first-run
 * flow. Mirrors agentPanelGuards.test.ts's style: exported pure functions,
 * no DOM.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CONNECT_HERMES_URL, INSTALL_COMMANDS, Launcher, launcherTiles } from '../src/components/agent/Launcher';
import type { DetectAgentsResult } from '../server/agentSetup';

function detect(found: Partial<Record<'claude' | 'codex' | 'opencode' | 'hermes', boolean>>): DetectAgentsResult {
  const entry = (f: boolean) => ({ found: f });
  return {
    claude: entry(found.claude ?? false),
    codex: entry(found.codex ?? false),
    opencode: entry(found.opencode ?? false),
    hermes: entry(found.hermes ?? false),
    ollama: { found: false, models: [] },
  };
}

describe('launcherTiles', () => {
  it('orders installed agents first, keeping the canonical order within each half', () => {
    const tiles = launcherTiles(detect({ codex: true, hermes: true }), false, []);
    expect(tiles.map((t) => `${t.id}:${t.status}`)).toEqual([
      'codex:ready',
      'hermes:ready',
      'claude:missing',
      'opencode:missing',
    ]);
  });

  it('reports every tile as checking while detection runs or before the first result', () => {
    for (const tiles of [launcherTiles(null, true, []), launcherTiles(null, false, []), launcherTiles(detect({ claude: true }), true, [])]) {
      expect(tiles.every((t) => t.status === 'checking')).toBe(true);
    }
  });

  it('carries an install command only for launchers with a known installer', () => {
    const tiles = launcherTiles(detect({}), false, []);
    for (const tile of tiles) {
      expect(tile.installCommand).toBe(INSTALL_COMMANDS[tile.id]);
    }
    expect(INSTALL_COMMANDS.claude).toBe('npm install -g @anthropic-ai/claude-code');
  });

  it('gives each tile the launcher description as its hint', () => {
    const tiles = launcherTiles(detect({ opencode: true }), false, ['llama3']);
    const opencode = tiles.find((t) => t.id === 'opencode')!;
    expect(opencode.hint).toContain('opencode.json');
  });
});

describe('Launcher — Hermes tile (no blessed installer)', () => {
  it('links to the connect guide instead of a dead-end "Not installed" label', () => {
    const tiles = launcherTiles(detect({}), false, []);
    const html = renderToStaticMarkup(
      React.createElement(Launcher, {
        tiles,
        detectFailed: false,
        disabledReason: null,
        pending: null,
        errors: {},
        modeLabel: 'Safe edit',
        gear: null,
        onLaunch: () => {},
        onInstall: () => {},
        onRetryDetect: () => {},
      }),
    );
    expect(html).toContain(`href="${CONNECT_HERMES_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('Setup guide');
    expect(html).not.toContain('Not installed');
  });
});
