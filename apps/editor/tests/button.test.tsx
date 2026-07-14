// @vitest-environment jsdom
/**
 * Button / IconButton primitive behavior. Runs under jsdom (per-file
 * docblock — see tooltip.test.tsx/menu.test.tsx for the same convention).
 *
 * These are thin primitives on purpose: they render the exact `.btn` class
 * family the editor already ships. No visual change is introduced here —
 * these tests pin the variant→class mapping, not any new styling.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { createRef } from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Button, IconButton } from '../src/components/ui/Button';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders the base .btn class with the default variant', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn.className.split(' ')).toEqual(expect.arrayContaining(['btn']));
    expect(btn.className).not.toContain('btn-primary');
    expect(btn.className).not.toContain('btn-danger');
    expect(btn.className).not.toContain('btn-ghost');
  });

  it('maps variant="primary" to btn-primary', () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('btn-primary');
  });

  it('maps variant="danger" to btn-danger', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('btn-danger');
  });

  it('maps variant="ghost" to btn-ghost', () => {
    render(<Button variant="ghost">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('btn-ghost');
  });

  it('maps size="sm" to btn-sm', () => {
    render(<Button size="sm">Add</Button>);
    expect(screen.getByRole('button', { name: 'Add' }).className).toContain('btn-sm');
  });

  it('does not add btn-sm for the default (md) size', () => {
    render(<Button>Add</Button>);
    expect(screen.getByRole('button', { name: 'Add' }).className).not.toContain('btn-sm');
  });

  it('renders an icon before the children when icon is set', () => {
    render(<Button icon="plus">Add</Button>);
    const btn = screen.getByRole('button', { name: /Add/ });
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('renders no icon when icon is omitted', () => {
    render(<Button>Add</Button>);
    expect(screen.getByRole('button', { name: 'Add' }).querySelector('svg')).toBeNull();
  });

  it('defaults type to "button" (never submits a form by accident)', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('button');
  });

  it('honors an explicit type override', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('submit');
  });

  it('merges a passed className alongside the variant classes', () => {
    render(
      <Button variant="ghost" size="sm" className="copy-btn">
        Copy
      </Button>,
    );
    const classes = screen.getByRole('button', { name: 'Copy' }).className.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['btn', 'btn-ghost', 'btn-sm', 'copy-btn']));
  });

  it('forwards native button props (onClick, disabled)', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards a ref to the underlying <button> element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Go</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});

describe('IconButton', () => {
  it('sets aria-label from the required label prop', () => {
    render(<IconButton icon="trash" label="Delete entity" />);
    expect(screen.getByRole('button', { name: 'Delete entity' })).toBeTruthy();
  });

  it('renders the icon glyph', () => {
    render(<IconButton icon="trash" label="Delete entity" />);
    expect(screen.getByRole('button', { name: 'Delete entity' }).querySelector('svg')).not.toBeNull();
  });

  it('always wraps itself in a Tooltip using the label as content', () => {
    render(<IconButton icon="trash" label="Delete entity" />);
    const btn = screen.getByRole('button', { name: 'Delete entity' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(btn);
    const tip = screen.queryByRole('tooltip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('Delete entity');
  });

  it('threads the shortcut prop to the Tooltip as a kbd chip', () => {
    const { baseElement } = render(<IconButton icon="trash" label="Delete entity" shortcut="Del" />);
    fireEvent.focus(screen.getByRole('button', { name: 'Delete entity' }));
    const kbd = baseElement.querySelector('kbd');
    expect(kbd).not.toBeNull();
    expect(kbd!.textContent).toBe('Del');
  });

  it('applies variant and size classes like Button', () => {
    render(<IconButton icon="trash" label="Delete entity" variant="danger" size="sm" />);
    const classes = screen.getByRole('button', { name: 'Delete entity' }).className.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['btn', 'btn-danger', 'btn-sm']));
  });

  it('merges a passed className alongside the variant classes', () => {
    render(<IconButton icon="trash" label="Delete entity" className="field-revert-btn" />);
    expect(screen.getByRole('button', { name: 'Delete entity' }).className).toContain('field-revert-btn');
  });

  it('defaults type to "button"', () => {
    render(<IconButton icon="trash" label="Delete entity" />);
    expect(screen.getByRole('button', { name: 'Delete entity' }).getAttribute('type')).toBe('button');
  });

  it('forwards native button props (onClick, disabled)', () => {
    const onClick = vi.fn();
    render(<IconButton icon="trash" label="Delete entity" onClick={onClick} disabled />);
    const btn = screen.getByRole('button', { name: 'Delete entity' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
