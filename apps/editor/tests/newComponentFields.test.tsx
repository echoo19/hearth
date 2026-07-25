// @vitest-environment jsdom
/**
 * Typed Inspector controls for the fields the generic value-driven path can't
 * reach on the movement/health/respawn components:
 *
 *  - CharacterController.actions — an object of five action names, which used
 *    to render as the read-only raw-JSON fallback.
 *  - Respawn.point — a nullable Vec2 whose DEFAULT is null, so the fallback
 *    was its normal state.
 *  - Checkpoint.target — a string with structure (an entity name, or
 *    "tag:<tag>"), which the generic path gave a bare text input.
 *
 * CharacterController.mode and Health.deathAction are deliberately absent:
 * they're `z.enum`s, so COMPONENT_ENUMS -> inspectComponents -> `doc.enums`
 * already gives them a dropdown with no per-field code. componentEnums.test.ts
 * pins that path instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  ActionMapField,
  CHARACTER_ACTION_SLOTS,
  CheckpointTargetField,
  RespawnPointField,
  tagTargets,
  targetMatches,
} from '../src/components/Inspector';

afterEach(() => cleanup());

const DEFAULT_ACTIONS = { left: 'left', right: 'right', up: 'up', down: 'down', jump: 'jump' };
const DECLARED = ['left', 'right', 'up', 'down', 'jump', 'action'];

function entity(
  id: string,
  name: string,
  tags: string[] = [],
  components: Record<string, unknown> = {},
) {
  return { id, name, tags, components };
}

describe('ActionMapField (CharacterController.actions)', () => {
  it('renders one labelled row per schema slot', () => {
    render(<ActionMapField value={DEFAULT_ACTIONS} declared={DECLARED} onCommit={vi.fn()} />);
    for (const slot of CHARACTER_ACTION_SLOTS) {
      expect(screen.getByTitle(`CharacterController.actions.${slot}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('combobox')).toHaveLength(5);
  });

  it('writes one slot at a time through actions.<slot>', () => {
    const onCommit = vi.fn();
    render(<ActionMapField value={DEFAULT_ACTIONS} declared={DECLARED} onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText('Jump action'), { target: { value: 'action' } });
    expect(onCommit).toHaveBeenCalledWith('jump', 'action');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('picks from declared input actions rather than free text', () => {
    render(<ActionMapField value={DEFAULT_ACTIONS} declared={DECLARED} onCommit={vi.fn()} />);
    const select = screen.getByLabelText('Left action') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([...DECLARED, 'Custom…']);
    // Nothing is a bare text input while every slot holds a declared action.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows an undeclared action as a marked custom value instead of rewriting it', () => {
    render(
      <ActionMapField
        value={{ ...DEFAULT_ACTIONS, jump: 'jmp' }}
        declared={DECLARED}
        onCommit={vi.fn()}
      />,
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('jmp');
    expect(screen.getByText(/isn't a declared input action/i)).toBeTruthy();
  });

  it('falls back to text inputs when the project declares no actions', () => {
    render(<ActionMapField value={DEFAULT_ACTIONS} declared={[]} onCommit={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(5);
  });

  it('never renders a raw-JSON dump', () => {
    render(<ActionMapField value={DEFAULT_ACTIONS} declared={DECLARED} onCommit={vi.fn()} />);
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByText(/\{"/)).toBeNull();
  });
});

describe('RespawnPointField (Respawn.point)', () => {
  const fallback = { x: 120, y: 380 };

  it('offers no Vec2 pair while the point is null', () => {
    render(
      <RespawnPointField value={null} useSpawnPosition fallback={fallback} onCommit={vi.fn()} />,
    );
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('seeds a fresh point from the entity position, not {0,0}', () => {
    const onCommit = vi.fn();
    render(
      <RespawnPointField value={null} useSpawnPosition fallback={fallback} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith({ x: 120, y: 380 });
  });

  it('clears the point back to null', () => {
    const onCommit = vi.fn();
    render(
      <RespawnPointField
        value={{ x: 10, y: 20 }}
        useSpawnPosition
        fallback={fallback}
        onCommit={onCommit}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('commits the whole Vec2 when one axis changes (the field is nullable)', () => {
    const onCommit = vi.fn();
    render(
      <RespawnPointField
        value={{ x: 10, y: 20 }}
        useSpawnPosition={false}
        fallback={fallback}
        onCommit={onCommit}
      />,
    );
    const [x] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.change(x, { target: { value: '64' } });
    fireEvent.blur(x);
    expect(onCommit).toHaveBeenCalledWith({ x: 64, y: 20 });
  });

  it('says a fixed point outranks Use Spawn Position (runtime: point ?? captured)', () => {
    render(
      <RespawnPointField
        value={{ x: 10, y: 20 }}
        useSpawnPosition
        fallback={fallback}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/A fixed point wins/i)).toBeTruthy();
  });

  it('warns when neither a point nor Use Spawn Position gives ctx.respawn a target', () => {
    render(
      <RespawnPointField
        value={null}
        useSpawnPosition={false}
        fallback={fallback}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/No respawn point/i)).toBeTruthy();
  });
});

describe('Checkpoint.target matching helpers', () => {
  const entities = [
    entity('e1', 'Player', ['player'], { Respawn: {} }),
    entity('e2', 'Coin 1', ['coin']),
    entity('e3', 'Coin 2', ['coin']),
  ];

  it('lists every distinct tag once, sorted, as a tag: target', () => {
    expect(tagTargets(entities)).toEqual(['tag:coin', 'tag:player']);
  });

  it('matches by tag prefix and by exact name, like the validator and runtime', () => {
    expect(targetMatches(entities, 'tag:coin').map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(targetMatches(entities, 'Player').map((e) => e.id)).toEqual(['e1']);
    expect(targetMatches(entities, 'tag:nope')).toEqual([]);
    expect(targetMatches(entities, 'Playerr')).toEqual([]);
  });
});

describe('CheckpointTargetField (Checkpoint.target)', () => {
  const entities = [
    entity('cp', 'Checkpoint Flag', ['checkpoint']),
    entity('e1', 'Player', ['player'], { Respawn: {} }),
    entity('e2', 'Coin 1', ['coin']),
  ];

  function targetField(value: string, selfId = 'cp') {
    const onCommit = vi.fn();
    render(
      <CheckpointTargetField
        value={value}
        entities={entities}
        selfId={selfId}
        onCommit={onCommit}
      />,
    );
    return { onCommit };
  }

  it('offers the scene tags and entity names instead of a bare text input', () => {
    targetField('tag:player');
    const select = screen.getByLabelText('Checkpoint target') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      'tag:checkpoint',
      'tag:coin',
      'tag:player',
      'Checkpoint Flag',
      'Player',
      'Coin 1',
      '__custom__',
    ]);
    expect(select.value).toBe('tag:player');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('commits the picked target', () => {
    const { onCommit } = targetField('tag:player');
    fireEvent.change(screen.getByLabelText('Checkpoint target'), { target: { value: 'Player' } });
    expect(onCommit).toHaveBeenCalledWith('Player');
  });

  it('keeps a value that matches nothing as a custom entry, and says it is inert', () => {
    targetField('tag:playre');
    const select = screen.getByLabelText('Checkpoint target') as HTMLSelectElement;
    expect(select.value).toBe('__custom__');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('tag:playre');
    expect(screen.getByText(/Nothing in this scene matches/i)).toBeTruthy();
  });

  it('flags a match with no Respawn component', () => {
    targetField('tag:coin');
    expect(screen.getByText(/has no Respawn component/i)).toBeTruthy();
  });

  it('flags a target that only matches the checkpoint itself', () => {
    targetField('tag:checkpoint');
    expect(screen.getByText(/can't overlap itself/i)).toBeTruthy();
  });

  it('stays quiet when the target resolves to something with a Respawn', () => {
    targetField('tag:player');
    expect(screen.queryByText(/Nothing in this scene matches/i)).toBeNull();
    expect(screen.queryByText(/has no Respawn component/i)).toBeNull();
    expect(screen.queryByText(/can't overlap itself/i)).toBeNull();
  });
});
