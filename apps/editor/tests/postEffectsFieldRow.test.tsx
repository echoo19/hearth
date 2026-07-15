// @vitest-environment jsdom
/**
 * PostEffectsField field rows (INSPSPEC-2 / L-043): every effect field label
 * is humanized like the rest of the Inspector, not shown as a raw camelCase
 * schema key. (The illegible-input width fix INSPSPEC-3 / L-042 is CSS-only —
 * covered by styleGates; nothing to assert at the DOM level here.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { PostEffectsField } from '../src/components/PostEffectsField';
import type { PostEffect } from '@hearth/core';

afterEach(() => cleanup());

describe('PostEffectsField field labels', () => {
  it('humanizes camelCase field keys', () => {
    const value: PostEffect[] = [{ type: 'crt', curvature: 0.2, scanlineIntensity: 0.5, noise: 0.1 }];
    render(<PostEffectsField value={value} onCommit={vi.fn()} />);
    expect(screen.getByText('Scanline Intensity')).toBeTruthy();
    expect(screen.getByText('Curvature')).toBeTruthy();
    // The raw camelCase key must not be shown as the visible label.
    expect(screen.queryByText('scanlineIntensity')).toBeNull();
  });
});
