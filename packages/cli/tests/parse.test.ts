import { describe, it, expect } from 'vitest';
import { parseCells, parseRect, parseWidthHeight, ParseError } from '../src/parse.js';

describe('parseCells', () => {
  it('parses a single cell entry', () => {
    const cells = parseCells('0,0,G');
    expect(cells).toEqual([{ x: 0, y: 0, char: 'G' }]);
  });

  it('parses multiple cell entries separated by semicolons', () => {
    const cells = parseCells('0,0,G;1,1,W;2,2,.');
    expect(cells).toEqual([
      { x: 0, y: 0, char: 'G' },
      { x: 1, y: 1, char: 'W' },
      { x: 2, y: 2, char: '.' },
    ]);
  });

  it('accepts a literal space as the eraser/empty char', () => {
    const cells = parseCells('0,0, ');
    expect(cells).toEqual([{ x: 0, y: 0, char: ' ' }]);
  });

  it('accepts mixed valid chars including space', () => {
    const cells = parseCells('0,0,G;1,0, ;2,0,.');
    expect(cells).toEqual([
      { x: 0, y: 0, char: 'G' },
      { x: 1, y: 0, char: ' ' },
      { x: 2, y: 0, char: '.' },
    ]);
  });

  it('throws ParseError for malformed entry (missing char)', () => {
    expect(() => parseCells('0,0')).toThrow(ParseError);
    expect(() => parseCells('0,0')).toThrow('expected "x,y,char"');
  });

  it('throws ParseError for non-numeric x', () => {
    expect(() => parseCells('a,0,G')).toThrow(ParseError);
    expect(() => parseCells('a,0,G')).toThrow('expected integer x,y');
  });

  it('throws ParseError for non-numeric y', () => {
    expect(() => parseCells('0,b,G')).toThrow(ParseError);
    expect(() => parseCells('0,b,G')).toThrow('expected integer x,y');
  });

  it('throws ParseError for floating-point coordinates', () => {
    expect(() => parseCells('0.5,0,G')).toThrow(ParseError);
    expect(() => parseCells('0,0.5,G')).toThrow(ParseError);
  });

  it('throws ParseError for empty input', () => {
    expect(() => parseCells('')).toThrow(ParseError);
    expect(() => parseCells('')).toThrow('expected at least one');
  });

  it('skips empty entries from trailing semicolons', () => {
    const cells = parseCells('0,0,G;');
    expect(cells).toEqual([{ x: 0, y: 0, char: 'G' }]);
  });
});

describe('parseRect', () => {
  it('parses a valid rect', () => {
    const rect = parseRect('0,0,4,2');
    expect(rect).toEqual({ x: 0, y: 0, width: 4, height: 2 });
  });

  it('parses negative coordinates', () => {
    const rect = parseRect('-1,-2,4,2');
    expect(rect).toEqual({ x: -1, y: -2, width: 4, height: 2 });
  });

  it('throws ParseError for wrong arity (less than 4 parts)', () => {
    expect(() => parseRect('0,0,4')).toThrow(ParseError);
    expect(() => parseRect('0,0,4')).toThrow('expected "x,y,width,height"');
  });

  it('throws ParseError for wrong arity (more than 4 parts)', () => {
    expect(() => parseRect('0,0,4,2,5')).toThrow(ParseError);
    expect(() => parseRect('0,0,4,2,5')).toThrow('expected "x,y,width,height"');
  });

  it('throws ParseError for non-numeric x', () => {
    expect(() => parseRect('a,0,4,2')).toThrow(ParseError);
    expect(() => parseRect('a,0,4,2')).toThrow('expected integer');
  });

  it('throws ParseError for non-numeric width', () => {
    expect(() => parseRect('0,0,x,2')).toThrow(ParseError);
    expect(() => parseRect('0,0,x,2')).toThrow('expected integer');
  });

  it('throws ParseError for floating-point values', () => {
    expect(() => parseRect('0.5,0,4,2')).toThrow(ParseError);
    expect(() => parseRect('0,0.5,4,2')).toThrow(ParseError);
    expect(() => parseRect('0,0,4.5,2')).toThrow(ParseError);
  });

  it('throws ParseError for NaN values', () => {
    expect(() => parseRect('NaN,0,4,2')).toThrow(ParseError);
    expect(() => parseRect('0,NaN,4,2')).toThrow(ParseError);
  });
});

describe('parseWidthHeight', () => {
  it('parses a valid width,height pair', () => {
    const wh = parseWidthHeight('40,20');
    expect(wh).toEqual({ width: 40, height: 20 });
  });

  it('parses with leading/trailing spaces', () => {
    const wh = parseWidthHeight('  40 , 20  ');
    expect(wh).toEqual({ width: 40, height: 20 });
  });

  it('throws ParseError for non-numeric width', () => {
    expect(() => parseWidthHeight('x,20')).toThrow(ParseError);
    expect(() => parseWidthHeight('x,20')).toThrow('expected integer');
  });

  it('throws ParseError for non-numeric height', () => {
    expect(() => parseWidthHeight('40,y')).toThrow(ParseError);
    expect(() => parseWidthHeight('40,y')).toThrow('expected integer');
  });

  it('throws ParseError for floating-point values', () => {
    expect(() => parseWidthHeight('40.5,20')).toThrow(ParseError);
    expect(() => parseWidthHeight('40,20.5')).toThrow(ParseError);
  });

  it('throws ParseError for NaN values', () => {
    expect(() => parseWidthHeight('NaN,20')).toThrow(ParseError);
    expect(() => parseWidthHeight('40,NaN')).toThrow(ParseError);
  });

  it('throws ParseError for wrong arity (single value)', () => {
    expect(() => parseWidthHeight('40')).toThrow(ParseError);
    expect(() => parseWidthHeight('40')).toThrow('expected "width,height"');
  });

  it('throws ParseError for wrong arity (three values)', () => {
    expect(() => parseWidthHeight('40,20,10')).toThrow(ParseError);
    expect(() => parseWidthHeight('40,20,10')).toThrow('expected "width,height"');
  });

  it('supports custom flag name in error messages', () => {
    expect(() => parseWidthHeight('x,20', '--custom-flag')).toThrow(ParseError);
    const error = new Error();
    try {
      parseWidthHeight('x,20', '--custom-flag');
    } catch (e) {
      expect((e as Error).message).toContain('--custom-flag');
    }
  });
});
