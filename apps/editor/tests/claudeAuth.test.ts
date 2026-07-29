/**
 * `parseClaudeAuth` — turning `claude auth status`'s stdout into a fact Hearth
 * can show.
 *
 * This is the parser only, never the real binary: a test whose result depends
 * on whether whoever runs it happens to have claude installed and signed in
 * would pass on one laptop and fail on the next, and on CI. `readClaudeAuth`
 * (the half that spawns the process) has its own coverage elsewhere; this
 * file exists so the shape of every payload the CLI might print is pinned
 * without a process in sight.
 */
import { describe, expect, it } from 'vitest';
import { SIGNED_OUT, parseClaudeAuth } from '../server/claudeAuth';

describe('a real payload', () => {
  it('reads every field claude auth status actually prints', () => {
    const raw = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'a@b.com',
      subscriptionType: 'max',
    });
    expect(parseClaudeAuth(raw)).toEqual({
      installed: true,
      loggedIn: true,
      email: 'a@b.com',
      planType: 'max',
    });
  });
});

describe('loggedIn — strict on purpose', () => {
  it('is false when the field is simply missing', () => {
    // A payload with no opinion on sign-in is not a sign-in. Reading absence as
    // true is the exact bug this type exists to prevent: Claude reported ready
    // on no evidence and then failed the turn.
    expect(parseClaudeAuth(JSON.stringify({ email: 'a@b.com' })).loggedIn).toBe(false);
  });

  it('is false for anything that is not the literal boolean true', () => {
    // `=== true` rather than a truthy check, because a build that prints the
    // string "true" or a 1 must not slip through as signed in.
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: 'true' })).loggedIn).toBe(false);
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: 1 })).loggedIn).toBe(false);
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false })).loggedIn).toBe(false);
  });
});

describe('planType — Anthropic\'s vocabulary, not ours', () => {
  it('is null when the CLI does not report a subscription', () => {
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: true })).planType).toBeNull();
  });

  it('passes an unrecognised tier through verbatim rather than mapping it', () => {
    // The vocabulary is Anthropic's and will grow. A switch statement here
    // would silently render a brand new tier as "unknown"; this must survive
    // untouched even though nothing in this codebase has heard of it yet.
    const raw = JSON.stringify({ loggedIn: true, subscriptionType: 'enterprise-plus' });
    expect(parseClaudeAuth(raw).planType).toBe('enterprise-plus');
  });
});

describe('payloads that are not a usable object', () => {
  it('reads non-JSON output as installed but signed out, never throwing', () => {
    // Some builds print a human sentence here instead of JSON. The binary was
    // still found (that is a fact from elsewhere), so `installed` stays true;
    // sign-in is simply unknown, which reports as signed out because that is
    // the direction that fails safe.
    expect(() => parseClaudeAuth('Not logged in. Run `claude login`.')).not.toThrow();
    expect(parseClaudeAuth('Not logged in. Run `claude login`.')).toEqual({ ...SIGNED_OUT, installed: true });
  });

  it('reads a JSON array the same way, since it is not a status object', () => {
    expect(() => parseClaudeAuth('[1,2,3]')).not.toThrow();
    expect(parseClaudeAuth('[1,2,3]')).toEqual({ ...SIGNED_OUT, installed: true });
  });

  it('reads JSON null the same way', () => {
    expect(() => parseClaudeAuth('null')).not.toThrow();
    expect(parseClaudeAuth('null')).toEqual({ ...SIGNED_OUT, installed: true });
  });

  it('never throws on an empty string', () => {
    // A status command that printed nothing at all is the emptiest case of
    // "some builds don't say JSON", and it must degrade exactly the same way
    // rather than taking the providers read-out down with it.
    expect(() => parseClaudeAuth('')).not.toThrow();
  });
});
