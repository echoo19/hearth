/**
 * A skill the agent used, from either backend, all the way to a transcript row.
 *
 * The two drivers surface a skill in completely different ways, and the point
 * of these tests is that only ONE of them is a real event:
 *
 *  - The Agent SDK invokes a skill as a tool named `Skill`, whose input is
 *    `{ skill, args? }`. That schema was read out of the shipped binary, not
 *    guessed, and it is what `sdkSkillCall` pins.
 *  - codex has nothing. `ThreadItem` on CODEX_TESTED_VERSION carries no skill
 *    member; skills reach the model as prose, and using one means reading its
 *    `SKILL.md` through the shell. So the row is inferred from the path, and
 *    what these tests hold is the REFUSAL half: anything ambiguous stays an
 *    ordinary command row rather than becoming a confident lie about which
 *    skill ran.
 */
import { describe, expect, it } from 'vitest';
import { mapSdkMessage, sdkSkillCall, sdkToolKind } from '../server/chat';
import { codexSkillRead, mapCodexNotification } from '../server/chatDrivers/codexWire';
import { applyChatEvent } from '../src/store';
import type { ChatMessage } from '../src/types';

const ROOTS = ['/home/me/.hearth/skills', '/home/me/.claude/skills', 'C:\\Users\\me\\.hearth\\skills'];

function turn(): ChatMessage[] {
  return [{ id: 'a1', role: 'agent', parts: [], streaming: true }];
}

describe('Agent SDK', () => {
  it('reads the skill and its arguments off a Skill call', () => {
    expect(sdkToolKind('Skill')).toBe('skill');
    expect(sdkSkillCall('Skill', { skill: 'brainstorming', args: 'the jump feel' })).toEqual({
      skill: 'brainstorming',
      args: 'the jump feel',
    });
    expect(sdkSkillCall('Skill', { skill: 'humanizer' })).toEqual({ skill: 'humanizer', args: undefined });
    expect(sdkSkillCall('Bash', { command: 'ls' })).toBeNull();
  });

  it('opens a skill row, and falls back to a plain tool row when nothing named a skill', () => {
    const events = mapSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'impeccable', args: 'audit the row' } },
          { type: 'tool_use', id: 't2', name: 'Skill', input: {} },
        ],
      },
    });
    expect(events[0]).toEqual({
      type: 'tool-begin',
      toolId: 't1',
      kind: 'skill',
      title: 'impeccable',
      detail: 'audit the row',
    });
    // "Used Skill skill" would be worse than the generic line it replaced.
    expect(events[1]).toMatchObject({ toolId: 't2', kind: 'other', title: 'Skill' });
  });
});

describe('codex', () => {
  it('names the skill a command is reading, under any known root', () => {
    expect(codexSkillRead("sed -n '1,200p' /home/me/.hearth/skills/brainstorming/SKILL.md", ROOTS)).toBe('brainstorming');
    expect(codexSkillRead('cat /home/me/.claude/skills/impeccable/SKILL.md', ROOTS)).toBe('impeccable');
    // Backslashes and case are a Windows path, not a different skill.
    expect(codexSkillRead('type C:\\Users\\me\\.hearth\\skills\\humanizer\\SKILL.md', ROOTS)).toBe('humanizer');
  });

  it('refuses anything that does not name exactly one skill', () => {
    expect(codexSkillRead('grep -rn foo /home/me/.hearth/skills/*/SKILL.md', ROOTS)).toBeNull();
    expect(codexSkillRead('cat /home/me/notes/skills/x/SKILL.md', ROOTS)).toBeNull();
    expect(codexSkillRead('cat /home/me/.hearth/skills/a/references/SKILL.md', ROOTS)).toBeNull();
    expect(
      codexSkillRead('cat /home/me/.hearth/skills/a/SKILL.md /home/me/.hearth/skills/b/SKILL.md', ROOTS),
    ).toBeNull();
    expect(codexSkillRead('npm test', ROOTS)).toBeNull();
    // No roots known: every command is just a command, as it was before.
    expect(codexSkillRead('cat /home/me/.hearth/skills/a/SKILL.md', [])).toBeNull();
  });

  it('replaces the command row with the skill row, and settles it', () => {
    const command = 'cat /home/me/.hearth/skills/brainstorming/SKILL.md';
    expect(
      mapCodexNotification('item/started', { item: { id: 'c1', type: 'commandExecution', command, cwd: '/p' } }, ROOTS),
    ).toEqual([{ type: 'tool-begin', toolId: 'c1', kind: 'skill', title: 'brainstorming', detail: command }]);
    // No summary: the captured output is the skill's own text.
    expect(
      mapCodexNotification(
        'item/completed',
        { item: { id: 'c1', type: 'commandExecution', command, status: 'completed', aggregatedOutput: 'x'.repeat(80) } },
        ROOTS,
      ),
    ).toEqual([{ type: 'tool-end', toolId: 'c1', status: 'ok' }]);
  });

  it('leaves an ordinary command alone', () => {
    expect(
      mapCodexNotification(
        'item/started',
        { item: { id: 'c2', type: 'commandExecution', command: 'npm test', cwd: '/p' } },
        ROOTS,
      ),
    ).toEqual([{ type: 'tool-begin', toolId: 'c2', kind: 'command', title: 'npm test', detail: '/p' }]);
  });
});

describe('the fold', () => {
  it('opens a skill part and settles it without losing what it was asked for', () => {
    let messages = applyChatEvent(turn(), {
      type: 'tool-begin',
      toolId: 't1',
      kind: 'skill',
      title: 'brainstorming',
      detail: 'the jump feel',
    });
    expect(messages[0].parts).toEqual([
      { kind: 'skill', id: 't1', name: 'brainstorming', detail: 'the jump feel', state: 'running' },
    ]);

    // The result of a Skill call is the skill's own instructions, so the
    // summary is dropped rather than pasted under the row.
    messages = applyChatEvent(messages, {
      type: 'tool-end',
      toolId: 't1',
      status: 'ok',
      summary: '# Brainstorming\n\nA very long skill document.',
    });
    expect(messages[0].parts[0]).toEqual({
      kind: 'skill',
      id: 't1',
      name: 'brainstorming',
      detail: 'the jump feel',
      state: 'ok',
    });
  });

  it('marks a skill that failed to load', () => {
    const opened = applyChatEvent(turn(), { type: 'tool-begin', toolId: 't1', kind: 'skill', title: 'humanizer' });
    const settled = applyChatEvent(opened, { type: 'tool-end', toolId: 't1', status: 'error' });
    expect(settled[0].parts[0]).toMatchObject({ kind: 'skill', state: 'error' });
  });
});
