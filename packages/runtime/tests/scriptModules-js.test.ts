import { describe, expect, it } from 'vitest';
import { compileScript } from '../src/scripts.js';

describe('compileScript with a resolver', () => {
  it('passes require through to the script body', () => {
    const hooks = compileScript(
      `const lib = require('lib/math'); export default { onStart(ctx) { ctx.log(lib.two()); } }`,
      () => ({ two: () => 2 }),
    );
    const logged: unknown[] = [];
    hooks.onStart?.({ log: (v: unknown) => logged.push(v) } as never);
    expect(logged).toEqual([2]);
  });

  it('still compiles without a resolver (unchanged behavior)', () => {
    const hooks = compileScript(`export default { onStart() {} }`);
    expect(typeof hooks.onStart).toBe('function');
  });

  it('throws a clear error when a script requires without a resolver', () => {
    expect(() => compileScript(`const x = require('a'); export default {}`)).toThrow(/require/i);
  });
});
