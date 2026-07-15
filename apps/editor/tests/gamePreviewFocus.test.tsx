// @vitest-environment jsdom
/**
 * L-122 (CODE-PLAY-2): clicking the Game preview must arm keyboard capture.
 *
 * The runtime's shouldCaptureGameKey only captures when document.activeElement
 * is inside the capture root (the `.game-canvas-host` div passed as the runtime
 * container). A plain click on the canvas otherwise leaves focus on dockview's
 * own content wrapper — an ANCESTOR of the host, so containment fails and WASD
 * is dead. GamePreview now gives the host tabIndex={-1} and focuses it on
 * pointerdown, so a normal click puts activeElement on the capture root exactly
 * as the (deliberately unchanged) capture contract expects.
 *
 * With no project loaded the runtime never mounts (the mount effect returns
 * early), so this exercises only the focus wiring — no Pixi/canvas needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { GamePreview } from '../src/components/GamePreview';

afterEach(() => {
  cleanup();
});

describe('GamePreview keyboard-capture arming (L-122)', () => {
  it('pointerdown on the canvas host focuses it so capture arms', () => {
    const { container } = render(<GamePreview />);
    const host = container.querySelector('.game-canvas-host') as HTMLElement;
    expect(host).not.toBeNull();
    // The host is a focus target (tabIndex -1) but not a keyboard tab-stop.
    expect(host.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(host);

    fireEvent.pointerDown(host);

    expect(document.activeElement).toBe(host);
  });
});
