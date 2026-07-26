/**
 * The conversation column's pure pieces: the composer's send/disable contract
 * and the tool chip's labelling. All DOM-free.
 */
import { describe, expect, it } from 'vitest';
import { composerBlockReason, isSendChord } from '../src/components/chat/Composer';
import { detailIsFile, relativeTo, shortenPath, toolVerb } from '../src/components/chat/ToolChip';
import { activeSenses } from '../src/components/game/CapabilityStrip';
import { capabilityLabel, connectionLabel } from '../src/components/shell/TopBar';
import { isNearBottom } from '../src/components/chat/MessageList';

describe('composerBlockReason', () => {
  it('names the reason when the socket is down', () => {
    expect(composerBlockReason({ connected: false, busy: false, empty: false })).toBe('Reconnecting…');
  });

  it('names the reason (and the way out) while a turn is running', () => {
    expect(composerBlockReason({ connected: true, busy: true, empty: false })).toContain('Stop');
  });

  it('gives no reason for an empty box — that is not a failure state', () => {
    expect(composerBlockReason({ connected: true, busy: false, empty: true })).toBeNull();
    expect(composerBlockReason({ connected: true, busy: false, empty: false })).toBeNull();
  });
});

describe('isSendChord', () => {
  it('sends on ⌘↵ and Ctrl+↵', () => {
    expect(isSendChord({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSendChord({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true);
  });

  it('leaves a bare Enter to insert a newline', () => {
    expect(isSendChord({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isSendChord({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe('toolVerb', () => {
  it('reads the common tools as plain verbs', () => {
    expect(toolVerb('Write')).toBe('Wrote');
    expect(toolVerb('Edit')).toBe('Edited');
    expect(toolVerb('Bash')).toBe('Ran');
  });

  it('passes an unmapped tool name straight through', () => {
    expect(toolVerb('SomeNewTool')).toBe('SomeNewTool');
  });
});

describe('path shortening', () => {
  it('drops the folder prefix', () => {
    expect(relativeTo('/w/game/src/main.js', '/w/game')).toBe('src/main.js');
    expect(relativeTo('/elsewhere/x.js', '/w/game')).toBe('/elsewhere/x.js');
  });

  it('clips from the left so the filename always survives', () => {
    const long = `/w/game/${'deep/'.repeat(12)}main.js`;
    const short = shortenPath(long, '/w/game', 20);
    expect(short.endsWith('main.js')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(20);
  });
});

describe('detailIsFile', () => {
  it('recognises a path with an extension', () => {
    expect(detailIsFile('src/game.js')).toBe(true);
  });

  it('rejects a shell command or a bare word', () => {
    expect(detailIsFile('npm run build')).toBe(false);
    expect(detailIsFile('src')).toBe(false);
    expect(detailIsFile(undefined)).toBe(false);
  });
});

describe('activeSenses', () => {
  it('lights nothing while there is no game', () => {
    expect(activeSenses(['preview'], false).size).toBe(0);
  });

  it('always includes what a plain web game gives up for free', () => {
    const senses = activeSenses([], true);
    expect(senses.has('preview')).toBe(true);
    expect(senses.has('errors')).toBe(true);
    expect(senses.has('screenshots')).toBe(true);
    expect(senses.has('entities')).toBe(false);
  });

  it('adds the deeper senses only when the server reports them', () => {
    expect(activeSenses(['entities', 'events'], true).has('entities')).toBe(true);
  });
});

describe('capabilityLabel', () => {
  it('reports the connection first — nothing else matters while it is down', () => {
    expect(capabilityLabel('connecting', 'agent-sdk', true)).toBe(connectionLabel('connecting'));
    expect(capabilityLabel('disconnected', 'agent-sdk', true)).toBe('Disconnected');
  });

  it('distinguishes a real agent from the stub', () => {
    expect(capabilityLabel('connected', 'agent-sdk', true)).toBe('Agent connected');
    expect(capabilityLabel('connected', 'stub', false)).toBe('No agent connected');
  });

  it('falls back to the configured key before a driver has bound', () => {
    expect(capabilityLabel('connected', null, true)).toBe('Ready');
    expect(capabilityLabel('connected', null, false)).toBe('No agent connected');
  });
});

describe('isNearBottom (conversation follow)', () => {
  it('counts an empty/short column as parked at the bottom', () => {
    expect(isNearBottom({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })).toBe(true);
  });

  it('unsticks once the reader scrolls up past the slack', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 100 })).toBe(false);
  });
});
