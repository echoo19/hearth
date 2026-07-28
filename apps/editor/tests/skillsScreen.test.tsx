/**
 * The Skills screen's pure pieces.
 *
 * Three things decide what this screen is honest about, and none of them need
 * a DOM to be checked:
 *
 *   1. how the list is grouped — "Installed" is everything Hearth found in
 *      Claude Code's and Codex's own folders and may not touch, "Created by
 *      me" is everything written here. The same flag draws both the heading
 *      and the line around what the row's menu is allowed to offer, so this
 *      is where read-only actually gets decided;
 *   2. what the search field keeps — every word, in any order, across
 *      everything a person might type to find a skill;
 *   3. what the app says when a request never came back. This one is here
 *      because the answer used to be "Failed to fetch": the browser's own
 *      words, put on screen unread, in front of someone trying to write a
 *      skill.
 *
 * The prompts are covered too, because they are the whole of two features:
 * "Create with chat" and "Improve description" are a sentence handed to an
 * agent, and if the sentence is wrong the feature is.
 */
import { describe, expect, it } from 'vitest';
import {
  groupSkills,
  matchesQuery,
  requestFailedMessage,
  skillEditable,
  skillSource,
  skillSourceLabel,
  type SkillRecord,
} from '../src/skills/useSkills';
import {
  createWithChatPrompt,
  folderNameOf,
  improveDescriptionPrompt,
} from '../src/components/skills/skillPrompt';

/**
 * `source` and `editable` are written into the fixture through this widening
 * rather than assumed on SkillRecord, for the same reason the accessors read
 * them defensively: the discovery that fills them in lives in a server file
 * this suite does not own, and a record without them still has to behave.
 */
type Marked = SkillRecord & { source?: 'hearth' | 'claude' | 'codex'; editable?: boolean };

function skill(over: Partial<Marked> = {}): SkillRecord {
  const base: Marked = {
    id: 'pixel-art',
    name: 'Pixel art',
    description: 'Drawing sprites and tilesets for a 2D game.',
    path: '/home/dev/.hearth/skills/pixel-art',
    enabled: true,
    files: 1,
    updatedAt: '2026-07-20T10:00:00.000Z',
    source: 'hearth',
    editable: true,
  };
  return { ...base, ...over };
}

/** One Hearth found in Claude Code's folder: listed, readable, untouchable. */
function borrowed(over: Partial<Marked> = {}): SkillRecord {
  return skill({
    id: 'code-review',
    name: 'Code review',
    path: '/home/dev/.claude/skills/code-review',
    source: 'claude',
    editable: false,
    ...over,
  });
}

describe('skillSource / skillEditable — read off the record, cautiously', () => {
  it('says what the record says', () => {
    expect(skillSource(borrowed())).toBe('claude');
    expect(skillEditable(borrowed())).toBe(false);
    expect(skillSource(skill())).toBe('hearth');
    expect(skillEditable(skill())).toBe(true);
  });

  it('treats a record that says nothing as read-only, and as Hearth\'s own', () => {
    // An answer from a server that predates discovery. Assuming it is
    // editable would put a Delete in front of somebody on a guess; assuming
    // some other tool owns it would invent a folder that isn't there.
    const bare = { ...skill() } as Partial<Marked>;
    delete bare.source;
    delete bare.editable;
    const older = bare as SkillRecord;
    expect(skillSource(older)).toBe('hearth');
    expect(skillEditable(older)).toBe(false);
  });

  it('names each tool the way that tool is known', () => {
    expect(skillSourceLabel('claude')).toBe('Claude Code');
    expect(skillSourceLabel('codex')).toBe('Codex');
    expect(skillSourceLabel('hearth')).toBe('Hearth');
  });
});

describe('groupSkills — installed, then the ones you wrote', () => {
  it('has nothing to show for an empty list', () => {
    expect(groupSkills([])).toEqual([]);
  });

  it('splits on what Hearth may change, and puts installed first', () => {
    const groups = groupSkills([skill({ id: 'mine' }), borrowed({ id: 'theirs' })]);
    expect(groups.map((group) => group.title)).toEqual(['Installed', 'Created by me']);
    expect(groups[0].skills.map((s) => s.id)).toEqual(['theirs']);
    expect(groups[1].skills.map((s) => s.id)).toEqual(['mine']);
  });

  it('keeps a heading only while it has something under it', () => {
    // A library with nothing installed shows one list and no headings at all,
    // rather than a lone "Created by me" over everything.
    expect(groupSkills([skill({ id: 'a' }), skill({ id: 'b' })]).map((g) => g.title)).toEqual(['Created by me']);
    expect(groupSkills([borrowed()]).map((g) => g.title)).toEqual(['Installed']);
  });

  it('holds the order it was given inside each group', () => {
    const groups = groupSkills([borrowed({ id: 'a' }), borrowed({ id: 'b' }), borrowed({ id: 'c' })]);
    expect(groups[0].skills.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps Claude Code and Codex together under Installed', () => {
    // They are two folders but one relationship: found elsewhere, read only.
    const groups = groupSkills([
      borrowed({ id: 'from-claude', source: 'claude' }),
      borrowed({ id: 'from-codex', source: 'codex', path: '/home/dev/.codex/skills/from-codex' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].skills).toHaveLength(2);
  });

  it('hands back its own arrays, so a caller cannot reorder the store', () => {
    const skills = [skill({ id: 'a' }), skill({ id: 'b' })];
    const groups = groupSkills(skills);
    groups[0].skills.reverse();
    expect(skills.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('matchesQuery — what the search field keeps', () => {
  it('keeps everything while the field is empty or only spaces', () => {
    expect(matchesQuery(skill(), '')).toBe(true);
    expect(matchesQuery(skill(), '   ')).toBe(true);
  });

  it('does not care about case', () => {
    expect(matchesQuery(skill(), 'PIXEL')).toBe(true);
  });

  it('looks in the description as well as the name', () => {
    expect(matchesQuery(skill(), 'tilesets')).toBe(true);
  });

  it('looks in the folder name too, which is what an agent matches on', () => {
    // Someone who has only ever seen the slug should still find the skill.
    expect(matchesQuery(skill({ name: 'Sprites', id: 'pixel-art' }), 'pixel-art')).toBe(true);
  });

  it('wants every word, but in any order', () => {
    expect(matchesQuery(skill(), 'sprites pixel')).toBe(true);
    expect(matchesQuery(skill(), 'pixel voxel')).toBe(false);
  });

  it('drops a skill that matches nothing typed', () => {
    expect(matchesQuery(skill(), 'audio')).toBe(false);
  });

  it('filters a list down to what was asked for', () => {
    const skills = [
      skill({ id: 'pixel-art', name: 'Pixel art' }),
      skill({ id: 'sfx', name: 'Sound effects', description: 'Making short game sounds.' }),
    ];
    expect(skills.filter((s) => matchesQuery(s, 'sound')).map((s) => s.id)).toEqual(['sfx']);
  });
});

describe('requestFailedMessage — a sentence a person wrote', () => {
  it('never repeats the browser its own words back at the user', () => {
    const said = requestFailedMessage(new TypeError('Failed to fetch'));
    expect(said).not.toContain('Failed to fetch');
    expect(said).not.toContain('fetch');
    // Says what actually happened: the app could not reach the server it runs.
    expect(said).toContain('reach its own server');
    expect(said.endsWith('.')).toBe(true);
  });

  it('tells a server that did not answer apart from one that answered nonsense', () => {
    const unreadable = requestFailedMessage(new SyntaxError('Unexpected token < in JSON at position 0'));
    expect(unreadable).not.toContain('JSON');
    expect(unreadable).not.toBe(requestFailedMessage(new TypeError('Failed to fetch')));
    expect(unreadable).toContain('could not read');
  });

  it('still says something plain when what was thrown is not an Error', () => {
    expect(requestFailedMessage('boom')).toContain('reach its own server');
    expect(requestFailedMessage(undefined)).toContain('reach its own server');
  });
});

describe('the sentences handed to the agent', () => {
  it('tells it where skills live and what a skill is', () => {
    const asked = createWithChatPrompt('/home/dev/.hearth/skills');
    expect(asked).toContain('/home/dev/.hearth/skills');
    expect(asked).toContain('SKILL.md');
    // The agent asks first rather than inventing a skill nobody wanted.
    expect(asked).toContain('First ask me what the skill should do');
  });

  it('asks for the description to be rewritten in place, and nothing else', () => {
    const asked = improveDescriptionPrompt('Pixel art', '/home/dev/.hearth/skills/pixel-art');
    expect(asked).toContain('Pixel art');
    expect(asked).toContain('/home/dev/.hearth/skills/pixel-art');
    expect(asked).toContain('description');
    expect(asked).toContain('Change nothing else in the file.');
  });
});

describe('folderNameOf — the name a picked folder suggests', () => {
  const picked = (relPath: string): File => ({ webkitRelativePath: relPath, name: 'SKILL.md' }) as unknown as File;

  it('takes the folder someone chose, not the file inside it', () => {
    expect(folderNameOf([picked('pixel-art/SKILL.md'), picked('pixel-art/palette.png')])).toBe('pixel-art');
  });

  it('falls back to a name rather than an empty one when nothing was picked', () => {
    expect(folderNameOf([])).toBe('skill');
  });
});
