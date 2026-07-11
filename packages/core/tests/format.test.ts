/**
 * formatSource: fixed Hearth style formatting for Lua (StyLua-WASM) and JS
 * (Prettier standalone). Core-side, but browser-safe (deps load only via
 * dynamic import) since the core barrel is also bundled client-side.
 */
import { describe, it, expect } from 'vitest';
import { formatSource, FormatError } from '@hearth/core';

describe('formatSource — lua', () => {
  it('normalizes indentation to 2 spaces', async () => {
    const messy = [
      'local function foo(x)',
      '    if x then',
      '        return 1',
      '    end',
      'end',
      '',
    ].join('\n');
    const result = await formatSource('lua', messy);
    expect(result.formatted).toContain('\n  if x then\n');
    expect(result.formatted).toContain('\n    return 1\n');
    expect(result.changed).toBe(true);
  });

  it('is idempotent: formatting formatted output changes nothing', async () => {
    const messy = [
      'local function foo(x)',
      '\tif x then',
      '\t\treturn 1',
      '\tend',
      'end',
      '',
    ].join('\n');
    const first = await formatSource('lua', messy);
    const second = await formatSource('lua', first.formatted);
    expect(second.formatted).toBe(first.formatted);
    expect(second.changed).toBe(false);
  });

  it('throws a FormatError (not a raw stylua panic string) on unformattable source', async () => {
    const broken = 'local x = 1\nlocal y = 2\nif x then\n'; // missing "end"
    await expect(formatSource('lua', broken)).rejects.toBeInstanceOf(FormatError);
    await expect(formatSource('lua', broken)).rejects.toThrow(/./); // has a real message, not thrown as a bare string
  });
});

describe('formatSource — js', () => {
  it('formats via prettier defaults (2-space indent, semicolons)', async () => {
    const messy = 'function foo(x){if(x){return 1}}\n';
    const result = await formatSource('js', messy);
    expect(result.formatted).toBe('function foo(x) {\n  if (x) {\n    return 1;\n  }\n}\n');
    expect(result.changed).toBe(true);
  });

  it('is idempotent: formatting formatted output changes nothing', async () => {
    const messy = 'const   x = {a:1,   b:2}\n';
    const first = await formatSource('js', messy);
    const second = await formatSource('js', first.formatted);
    expect(second.formatted).toBe(first.formatted);
    expect(second.changed).toBe(false);
  });

  it('throws a FormatError (not a raw prettier SyntaxError) on unformattable source', async () => {
    const broken = 'function foo(x) { [ }';
    await expect(formatSource('js', broken)).rejects.toBeInstanceOf(FormatError);
  });
});
