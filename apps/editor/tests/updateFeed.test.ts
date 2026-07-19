import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The auto-updater is only as real as its feed. electron-updater reads
 * latest.yml / latest-mac.yml / latest-linux.yml from the GitHub release, and
 * electron-builder only *generates* those files when a publish provider is
 * configured — so a missing `build.publish` or a release workflow that drops
 * the yml files ships an updater that silently never finds updates ("the
 * half-wired-feed trap"). These pins keep both halves wired.
 */
const editorRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(editorRoot, '..', '..');

describe('auto-update feed wiring', () => {
  it('electron-builder has a GitHub publish provider (emits latest*.yml + app-update.yml)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(editorRoot, 'package.json'), 'utf8'));
    const publish = pkg.build?.publish;
    expect(publish, 'apps/editor package.json build.publish missing').toBeTruthy();
    const entry = Array.isArray(publish) ? publish[0] : publish;
    expect(entry.provider).toBe('github');
    expect(entry.owner).toBe('echoo19');
    expect(entry.repo).toBe('hearth');
  });

  it('the release workflow uploads the update-info ymls and blockmaps', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('apps/editor/release/latest*.yml');
    expect(workflow).toContain('apps/editor/release/*.blockmap');
  });
});
