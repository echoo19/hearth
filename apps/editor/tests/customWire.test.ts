/**
 * The Hearth agent protocol, version 0, tested as strings.
 *
 * The module is pure, so this file is the whole of the format: what Hearth
 * writes, what it will read back, and what it refuses. Three properties matter
 * more than the rest and are the reason most of these tests exist:
 *
 *   1. **Three events are enough.** `message-delta`, `turn-complete` and
 *      `error` alone must produce a real turn. If that ever stops being true
 *      the promise this protocol is built on is gone.
 *   2. **An unknown event is dropped, never fatal.** A newer Hearth, or an
 *      agent inventing a type, must not end somebody's conversation.
 *   3. **Hearth owns the answer to an approval.** An agent cannot write
 *      `approval-resolved` and put a decision nobody made on the transcript.
 */
import { describe, expect, it } from 'vitest';
import {
  HEARTH_AGENT_ENV_VARS,
  HEARTH_PROTOCOL_VERSION,
  agentEnvVars,
  approvalFrame,
  decodeLines,
  encodeFrame,
  interruptFrame,
  parseAgentEvent,
  parseHandshake,
  permissionNotice,
  promptFrame,
  shutdownFrame,
} from '../server/chatDrivers/customWire';
import type { ChatAttachment } from '../server/chat';

const attachment = (name: string): ChatAttachment => ({
  name,
  mimeType: 'image/png',
  path: `/w/game/.hearth/chats/${name}`,
  relPath: `.hearth/chats/${name}`,
  bytes: 12,
});

describe('frames Hearth writes', () => {
  it('is one JSON object per line, newline terminated', () => {
    const line = encodeFrame(shutdownFrame());
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'shutdown' });
    expect(line.trim().includes('\n')).toBe(false);
  });

  it('carries the turn id, the words, the mode and the choice', () => {
    const frame = promptFrame('t1', 'make a platformer', [], { model: 'my-model', effort: 'high' }, 'ask');
    expect(frame).toEqual({
      type: 'prompt',
      turnId: 't1',
      text: 'make a platformer',
      attachments: [],
      model: 'my-model',
      effort: 'high',
      permissionMode: 'ask',
    });
  });

  it('sends a null model rather than omitting it, so the field is always there', () => {
    expect(promptFrame('t1', 'hi', [], null, 'auto')).toMatchObject({ model: null, effort: null });
  });

  it('hands attachments over as paths, never as bytes', () => {
    const frame = promptFrame('t1', '', [attachment('sprite.png')], null, 'auto');
    expect(frame.attachments).toEqual([
      { path: '/w/game/.hearth/chats/sprite.png', name: 'sprite.png', mimeType: 'image/png' },
    ]);
    // Nothing about Hearth's own layout, and no base64.
    expect(JSON.stringify(frame)).not.toContain('relPath');
  });

  it('answers an approval by id and nothing else', () => {
    expect(approvalFrame('a1', 'deny')).toEqual({ type: 'approval', approvalId: 'a1', decision: 'deny' });
    expect(interruptFrame('t2')).toEqual({ type: 'interrupt', turnId: 't2' });
  });
});

describe('reading lines', () => {
  it('keeps a partial line for the next chunk', () => {
    const first = decodeLines('{"type":"message-delta","text":"a"}\n{"type":"mess');
    expect(first.values).toHaveLength(1);
    const second = decodeLines(`${first.rest}age-delta","text":"b"}\n`);
    expect(second.values).toHaveLength(1);
    expect(second.rest).toBe('');
  });

  it('drops a line that is not JSON rather than failing the conversation', () => {
    // A wrapper printing a banner before it speaks protocol is common enough
    // that this must not be fatal.
    const read = decodeLines('starting my agent...\n{"type":"turn-complete"}\n');
    expect(read.values).toEqual([{ type: 'turn-complete' }]);
  });

  it('abandons a line that never ends rather than growing forever', () => {
    const read = decodeLines('x'.repeat(50), 10);
    expect(read.overflowed).toBe(true);
    expect(read.rest).toBe('');
  });
});

describe('the handshake', () => {
  it('reads the version and what the agent claims', () => {
    expect(
      parseHandshake({ type: 'ready', protocol: 0, supports: { approvals: true, permissionModes: ['ask', 'auto'] } }),
    ).toEqual({ protocol: 0, approvals: true, permissionModes: ['ask', 'auto'] });
  });

  it('treats a missing supports block as claiming nothing', () => {
    expect(parseHandshake({ type: 'ready', protocol: HEARTH_PROTOCOL_VERSION })).toEqual({
      protocol: 0,
      approvals: false,
      permissionModes: [],
    });
  });

  it('is not a handshake without the type and the version', () => {
    expect(parseHandshake({ protocol: 0 })).toBeNull();
    expect(parseHandshake({ type: 'ready' })).toBeNull();
    expect(parseHandshake({ type: 'ready', protocol: 'zero' })).toBeNull();
    expect(parseHandshake('ready')).toBeNull();
  });
});

describe('the three required events', () => {
  it('makes a whole turn out of prose and a completion', () => {
    expect(parseAgentEvent({ type: 'message-delta', text: 'building' })).toEqual({
      type: 'message-delta',
      text: 'building',
    });
    expect(parseAgentEvent({ type: 'turn-complete' })).toEqual({ type: 'turn-complete' });
  });

  it('always has something to say for an error', () => {
    expect(parseAgentEvent({ type: 'error', message: 'the model refused' })).toEqual({
      type: 'error',
      message: 'the model refused',
    });
    expect(parseAgentEvent({ type: 'error' })).toMatchObject({ type: 'error' });
  });

  it('drops a delta with no text, rather than rendering an empty bubble', () => {
    expect(parseAgentEvent({ type: 'message-delta' })).toBeNull();
    expect(parseAgentEvent({ type: 'message-delta', text: 42 })).toBeNull();
  });
});

describe('the opt-in richness', () => {
  it('reads a tool row, defaulting the kind rather than refusing it', () => {
    expect(parseAgentEvent({ type: 'tool-begin', toolId: 'x1', title: 'npm test' })).toEqual({
      type: 'tool-begin',
      toolId: 'x1',
      kind: 'other',
      title: 'npm test',
    });
    expect(parseAgentEvent({ type: 'tool-begin', toolId: 'x1', kind: 'command', title: 'npm test' })).toMatchObject({
      kind: 'command',
    });
    expect(parseAgentEvent({ type: 'tool-begin', toolId: 'x1', kind: 'nonsense', title: 'npm test' })).toMatchObject({
      kind: 'other',
    });
  });

  it('needs an id and a title for a tool row, since both are what it renders', () => {
    expect(parseAgentEvent({ type: 'tool-begin', title: 'npm test' })).toBeNull();
    expect(parseAgentEvent({ type: 'tool-begin', toolId: 'x1' })).toBeNull();
  });

  it('reads file changes and drops the entries with no path', () => {
    expect(
      parseAgentEvent({
        type: 'file-change',
        toolId: 'x1',
        files: [{ path: 'src/game.ts', kind: 'create' }, { kind: 'edit' }],
      }),
    ).toEqual({ type: 'file-change', toolId: 'x1', files: [{ path: 'src/game.ts', kind: 'create' }] });
    expect(parseAgentEvent({ type: 'file-change', files: [] })).toBeNull();
  });

  it('reads an approval request, and gives it an empty detail rather than none', () => {
    expect(parseAgentEvent({ type: 'approval-request', approvalId: 'a1', kind: 'command', title: 'Run rm?' })).toEqual({
      type: 'approval-request',
      approvalId: 'a1',
      kind: 'command',
      title: 'Run rm?',
      detail: '',
    });
  });

  it('reads plans, notices, images and subagents', () => {
    expect(parseAgentEvent({ type: 'plan-update', text: '[ ] one' })).toEqual({
      type: 'plan-update',
      planId: 'plan',
      text: '[ ] one',
    });
    expect(parseAgentEvent({ type: 'notice', text: 'context compacted' })).toEqual({
      type: 'notice',
      text: 'context compacted',
    });
    expect(parseAgentEvent({ type: 'image', toolId: 'x1', path: 'art/hero.png' })).toMatchObject({ type: 'image' });
    expect(parseAgentEvent({ type: 'subagent-start', agentId: 's1', title: 'research' })).toMatchObject({
      type: 'subagent-start',
    });
  });

  it('caps an id, because it keys a map on this side', () => {
    expect(parseAgentEvent({ type: 'tool-begin', toolId: 'x'.repeat(500), title: 'npm test' })).toBeNull();
  });
});

describe('what an agent may not say', () => {
  it('drops an unknown event instead of failing the turn', () => {
    expect(parseAgentEvent({ type: 'quantum-flux', text: 'hi' })).toBeNull();
    expect(parseAgentEvent({})).toBeNull();
    expect(parseAgentEvent(null)).toBeNull();
    expect(parseAgentEvent([{ type: 'message-delta', text: 'hi' }])).toBeNull();
  });

  it('refuses to let an agent resolve its own approval', () => {
    expect(parseAgentEvent({ type: 'approval-resolved', approvalId: 'a1', decision: 'allow' })).toBeNull();
  });

  it('refuses the legacy v0 spellings, so there is one way to say each thing', () => {
    expect(parseAgentEvent({ type: 'text-delta', text: 'hi' })).toBeNull();
    expect(parseAgentEvent({ type: 'tool-start', id: 'x1', name: 'Bash' })).toBeNull();
    expect(parseAgentEvent({ type: 'done' })).toBeNull();
  });
});

describe('what the child is told about its environment', () => {
  it('adds three variables and no credentials', () => {
    const env = agentEnvVars('/w/game', 'skip');
    expect(env).toEqual({
      HEARTH_PROJECT_ROOT: '/w/game',
      HEARTH_PERMISSION_MODE: 'skip',
      HEARTH_PROTOCOL_VERSION: '0',
    });
    expect(Object.keys(env)).toEqual([...HEARTH_AGENT_ENV_VARS]);
  });

  it('says who is enforcing permissions, naming the mode it passed', () => {
    const notice = permissionNotice('My agent', 'auto');
    expect(notice).toContain('My agent');
    expect(notice).toContain('HEARTH_PERMISSION_MODE=auto');
    // It must not claim Hearth gated anything: it did not.
    expect(notice).toContain('does not gate it');
  });
});
