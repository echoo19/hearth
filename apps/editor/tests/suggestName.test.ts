/**
 * The first draft of a project's name.
 *
 * Projects used to be named FROM the first message with no chance to object:
 * you typed a sentence and a folder appeared wearing four of its words. Now
 * the app asks, and this is only what it writes into the field before you
 * answer. So the bar is "obviously a draft, usually close enough to accept",
 * not "correct".
 *
 * The rule that matters most is the one that is not here: nothing in this file
 * knows what a game is. It never maps meaning onto a name, never recognises a
 * genre, never has an opinion about what you are making. It takes the words
 * that are already there and stops. Hearth supplies tools, it does not decide
 * what kind of game you are allowed to have written.
 */
import { describe, expect, it } from 'vitest';
import { suggestProjectName } from '../src/projects/suggestName';

describe('suggestProjectName', () => {
  it('takes the idea and leaves the ceremony in front of it', () => {
    expect(suggestProjectName('make me a top-down space shooter')).toBe('Top-down space shooter');
    expect(suggestProjectName('I want to make a puzzle game about tides')).toBe('Puzzle game about tides');
    expect(suggestProjectName("let's build a roguelike")).toBe('Roguelike');
  });

  it('peels off every opener, not just the first', () => {
    expect(suggestProjectName('can you please make a game where a raccoon steals bins')).toBe('Raccoon steals bins');
  });

  it('stops at the first sentence, because the rest is detail', () => {
    expect(suggestProjectName('A lighthouse keeper sim. It should have fog and boats.')).toBe('Lighthouse keeper sim');
  });

  it('keeps the opener when the opener is the whole idea', () => {
    // "make a game" reduced to nothing would put an empty field in front of
    // someone who did say something.
    expect(suggestProjectName('make a game')).toBe('Game');
    expect(suggestProjectName('build')).toBe('Build');
  });

  it('does not end on a word that is holding the door open', () => {
    expect(suggestProjectName('a game about the')).toBe('Game');
    expect(suggestProjectName('something with')).toBe('Something');
  });

  it('stays short enough to be a folder and a rail row', () => {
    const long = suggestProjectName('an enormous sprawling generational spacefaring civilisation simulator');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.split(' ').length).toBeLessThanOrEqual(4);
  });

  it('drops punctuation without gluing the words together', () => {
    expect(suggestProjectName('a game called "Deep Water", please')).toBe('Deep water');
  });

  it('is sentence case, not title case', () => {
    // A project is a thing you named, not a product with a wordmark.
    expect(suggestProjectName('cave diving horror')).toBe('Cave diving horror');
  });

  it('answers with nothing when there is nothing to work with', () => {
    expect(suggestProjectName('')).toBe('');
    expect(suggestProjectName('   ')).toBe('');
    expect(suggestProjectName('!!! ???')).toBe('');
    // A run of punctuation is not a name. These used to survive verbatim and
    // then enable Create.
    expect(suggestProjectName('-----')).toBe('');
    expect(suggestProjectName("'''''")).toBe('');
  });

  it('does not lose the idea to punctuation in front of it', () => {
    // `.split(/[.!?]/)[0]` took the first segment whether or not it held
    // anything, so a prompt that opened with punctuation suggested nothing.
    expect(suggestProjectName('?!?! make a platformer')).toBe('Platformer');
    expect(suggestProjectName('... a game about tides')).toBe('Tides');
  });

  it('names a game in any script, because people make games in any language', () => {
    // The character class was `[^a-z0-9\s'-]`, which is a claim that games are
    // named in English. It emptied the field entirely for anyone not writing
    // in Latin script, and shredded accented Latin on the way.
    expect(suggestProjectName('우주 게임')).toBe('우주 게임');
    expect(suggestProjectName('ゲーム')).toBe('ゲーム');
    expect(suggestProjectName('naïve résumé simulator')).toBe('Naïve résumé simulator');
    expect(suggestProjectName('Café Adventure')).toBe('Café adventure');
  });

  it('never shows a draft longer than the name it would make', () => {
    // The cap used to slice the joined string, so a hyphenated run showed a
    // 32-character draft and then created a four-letter folder.
    const long = suggestProjectName('an-extremely-long-hyphenated-single-token-name');
    expect(long.split(' ')).toHaveLength(1);
    expect(long.endsWith('-')).toBe(false);
  });

  it('has no idea what kind of game any of these are', () => {
    // Same shape in, same shape out. No genre is recognised, nothing is
    // renamed to something the app thinks is more appropriate, and a game
    // that is not a game at all is treated exactly like one that is.
    expect(suggestProjectName('a 2D platformer')).toBe('2d platformer');
    expect(suggestProjectName('a VR meditation space')).toBe('Vr meditation space');
    expect(suggestProjectName('an interactive poem')).toBe('Interactive poem');
    expect(suggestProjectName('a spreadsheet that screams')).toBe('Spreadsheet that screams');
  });
});
