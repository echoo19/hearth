/**
 * The conversation column's pure pieces: the composer's send/disable contract
 * and the tool chip's labelling. All DOM-free.
 */
import { describe, expect, it } from 'vitest';
import { composerBlockReason, composerKeyAction } from '../src/components/chat/Composer';
import { detailIsFile, relativeTo, shortenPath, toolVerb } from '../src/components/chat/ToolChip';
import { capabilityLabel, connectionLabel } from '../src/components/shell/TopBar';
import { isNearBottom } from '../src/components/chat/MessageList';
import { anyChatProviderReady } from '../src/store';

describe('composerBlockReason', () => {
  it('names the reason when the socket is down', () => {
    expect(composerBlockReason({ connected: false })).toBe('Reconnecting…');
  });

  it('says nothing at all once the socket is up', () => {
    // Including while a turn is running: that state belongs to the transcript
    // (WorkingRow), not to a caption under the box. A note here beside a Stop
    // button was the app explaining its own controls.
    expect(composerBlockReason({ connected: true })).toBeNull();
  });
});

describe('composerKeyAction — Enter sends, Shift+Enter breaks the line', () => {
  const key = (over: Partial<Parameters<typeof composerKeyAction>[0]> = {}) =>
    composerKeyAction({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

  it('sends on a bare Enter — the idiom every other chat app uses', () => {
    expect(key()).toBe('send');
  });

  it('keeps the ⌘↵ / Ctrl+↵ chord this app shipped with', () => {
    expect(key({ metaKey: true })).toBe('send');
    expect(key({ ctrlKey: true })).toBe('send');
    // Even held together with Shift, an explicit chord is an explicit send.
    expect(key({ metaKey: true, shiftKey: true })).toBe('send');
  });

  it('breaks the line on Shift+Enter and Alt+Enter', () => {
    expect(key({ shiftKey: true })).toBe('newline');
    expect(key({ altKey: true })).toBe('newline');
  });

  it('stays out of the way of an IME composition', () => {
    // Enter is confirming a candidate here; sending would eat the choice.
    expect(key({ isComposing: true })).toBeNull();
  });

  it('claims nothing but Enter', () => {
    expect(key({ key: 'a' })).toBeNull();
    expect(key({ key: 'Tab' })).toBeNull();
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

// The `activeSenses` suite lived here. The capability chip row it backed was
// removed from the game pane, and with it the function — the game pane's strip
// now carries only its two actions.

describe('capabilityLabel — silence is the resting state', () => {
  it('says nothing at all when everything is working', () => {
    // It used to read "Ready" / "Agent connected" whenever things were fine.
    // A tool that keeps announcing it is connected invites the reader to
    // wonder how often it isn't, and a localhost socket being up is not news.
    expect(capabilityLabel('connected', 'agent-sdk', true)).toBeNull();
    expect(capabilityLabel('connected', 'codex', true)).toBeNull();
    expect(capabilityLabel('connected', null, true)).toBeNull();
  });

  it('still says when nothing could answer a turn', () => {
    // This one is not reassurance, it is the difference between typing doing
    // something and typing doing nothing — and it is the reader's to fix.
    expect(capabilityLabel('connected', 'stub', false)).toBe('No agent connected');
    expect(capabilityLabel('connected', null, false)).toBe('No agent connected');
  });

  it('keeps quiet about a connection that comes straight back', () => {
    // A blip narrated is the same self-doubt in a shorter sentence.
    expect(capabilityLabel('connecting', 'agent-sdk', true)).toBeNull();
    expect(capabilityLabel('disconnected', 'agent-sdk', true)).toBeNull();
  });

  it('speaks once the wait is long enough to be felt', () => {
    expect(capabilityLabel('connecting', 'agent-sdk', true, true)).toBe(connectionLabel('connecting'));
    expect(capabilityLabel('disconnected', 'agent-sdk', true, true)).toBe('Disconnected');
  });

  it('counts a signed-in provider as ready, not only a stored key', () => {
    // Someone signed in with ChatGPT and no Anthropic key can be answered, so
    // they must not be told nothing is connected.
    const providers = {
      active: 'openai' as const,
      anthropic: { hasKey: false, source: null },
      openai: { installed: true, loggedIn: true, hasKey: false },
    } as unknown as Parameters<typeof anyChatProviderReady>[1];
    expect(anyChatProviderReady({ hasKey: false, source: null }, providers)).toBe(true);
    expect(capabilityLabel('connected', null, anyChatProviderReady({ hasKey: false, source: null }, providers))).toBeNull();
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
