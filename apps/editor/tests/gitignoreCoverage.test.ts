/**
 * What a project folder leaks to git.
 *
 * A Hearth project is an ordinary folder that the person who made it will put
 * under git and push somewhere public. Hearth writes a lot into that folder
 * while they work — every word of every conversation, the private tester's
 * memory and its screenshots of the game, playtest evidence, and the API keys
 * for whichever agent answers. None of that is a source file and none of it is
 * theirs to publish by accident, so each one is either something they would
 * want committed or it is ignored. There is no third option, and this file is
 * where that is pinned.
 *
 * Two separate .gitignores answer for it, for two different sets of folders,
 * and both have failed in the same way before:
 *
 *  - PROJECT_GITIGNORE, written into every project Hearth creates.
 *  - the engine repo's own, which has to cover `packages/examples/*` — those
 *    are real Hearth projects, and the moment a contributor opens one in the
 *    app it starts collecting their conversations.
 *
 * The shared failure is ANCHORING. A gitignore pattern containing an interior
 * slash is anchored to its own file's directory, so `.hearth/chats/` in the
 * repo root matches `<repo>/.hearth/chats/` — a path nothing ever writes — and
 * NOT `packages/examples/pong/.hearth/chats/`, which is the only path it was
 * ever meant for. The rule reads as protection and protects nothing, silently,
 * with no way to notice short of pushing. `**​/` is what fixes it, and the
 * second half of this file exists because that prefix is easy to drop.
 */
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_GITIGNORE } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { createProject } from '@hearth/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * Everything the desktop app writes into a project that is the PERSON's record
 * of working there rather than part of the game, named by the module that
 * writes it so a reader can go and check.
 *
 * Deliberately not exhaustive over `.hearth/` — `context/` (projectContext.ts),
 * `project.json` (projectIdentity.ts) and `harness.json` are all things you WANT
 * committed, which is the whole reason this list is written out by hand rather
 * than derived from a wildcard over the folder.
 */
const PRIVATE_TO_THE_PERSON = [
  // server/chatStore.ts — index.json and one .jsonl per conversation.
  '.hearth/chats/',
  // server/tester/memory.ts — memory.md, notes, transcripts, and PNG frames.
  '.hearth/tester/',
  // server/evidenceWatcher.ts — playtest captures, journals, results.
  '.hearth/evidence/',
  // the older sweep runner's output, same character.
  '.hearth/sweeps/',
  // server/journalWatcher.ts — commands.jsonl, regenerated runtime state.
  '.hearth/log/',
  // server/chat.ts appSettingsPath — the saved Anthropic and OpenAI keys.
  '.hearth/app.json',
];

describe('the .gitignore Hearth writes into a project it creates', () => {
  const lines = PROJECT_GITIGNORE.split('\n').map((line) => line.trim());

  it.each(PRIVATE_TO_THE_PERSON)('keeps %s out of the repo', (pattern) => {
    expect(lines).toContain(pattern);
  });

  it('still commits the things that are about the GAME', () => {
    // The other direction, and the one a tidy-up gets wrong. memory.md is the
    // agent's decisions and gotchas, `context/` is reference material the person
    // handed the project, and `project.json` is the mark and colour the folder
    // opens with. All three are authored intent: a clone that arrives without
    // them is a worse copy of the game.
    expect(PROJECT_GITIGNORE).not.toContain('memory.md');
    expect(lines).not.toContain('.hearth/context/');
    expect(lines).not.toContain('.hearth/project.json');
    expect(lines).not.toContain('.hearth/');
  });

  it('reaches disk, not just the constant', async () => {
    // The constant is one thing and a folder on somebody's machine is another.
    // This is the only assertion here that proves a project created today
    // actually carries the rules.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-ignore-'));
    try {
      const root = path.join(tmp, 'game');
      await createProject(new NodeFileSystem(), root, { name: 'Game' });
      const written = (await fsp.readFile(path.join(root, '.gitignore'), 'utf8'))
        .split('\n')
        .map((line) => line.trim());
      for (const pattern of PRIVATE_TO_THE_PERSON) expect(written).toContain(pattern);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("the engine repo's own .gitignore, which has to cover packages/examples/*", () => {
  it('anchors every per-project rule with **/, or it protects nothing', async () => {
    const text = await fsp.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    const rules = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    for (const pattern of PRIVATE_TO_THE_PERSON) {
      const anchored = `**/${pattern}`;
      // The rule is present AND carries the prefix. Asserting only "some line
      // mentions .hearth/chats" is what let the broken form sit here reading as
      // though it worked.
      expect(rules, `${pattern} must be ignored inside an example project`).toContain(anchored);
      expect(rules, `${pattern} must not also appear anchored to the repo root`).not.toContain(pattern);
    }
  });

  it('leaves an example project’s OWN scaffolding tracked', async () => {
    // The mirror image of the rule above, and the reason none of this is a
    // blanket `**/.hearth/`. An example is a real game: its scenes, its
    // hearth.json and the `hearth-*` skills a template scaffolds into
    // `.claude/skills/` are all source, and a rule broad enough to catch a
    // conversation transcript is broad enough to delete an example from the
    // repo. See server/skills.ts writeMirrorIgnore for how the personal skills
    // that land in the same folder are kept out instead.
    const text = await fsp.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    const rules = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(rules).not.toContain('**/.hearth/');
    expect(rules).not.toContain('**/.claude/');
    expect(rules).not.toContain('**/.claude/skills/');
  });
});
