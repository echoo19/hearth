/**
 * xterm wrapper for the embedded agent terminal. Owns only DOM/xterm
 * plumbing: it creates one xterm instance for its lifetime, fits it to the
 * container, forwards keystrokes and resizes, and streams the buffered
 * scrollback into the instance.
 *
 * Scrollback is consumed imperatively — subscribeAgentSocket + a write
 * cursor, not React props — so a torrent of pty-data frames writes straight
 * into xterm without re-rendering any React tree. The diffing itself
 * (planTerminalWrite: what a freshly mounted instance missed, what a live
 * one still needs) is pure and DOM-free in useAgentSocket.ts, unit-tested
 * without a real xterm instance. On mount the cursor starts fresh, so
 * reattaching after the panel was closed replays the buffered session.
 *
 * Disposing this component tears down the xterm instance but never touches
 * the pty: hiding/closing the Agent panel's dockview tab must not kill a
 * running `claude`/`codex`/shell session, only stop rendering it.
 */
import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  getAgentSocketSnapshot,
  initialWriteCursor,
  planTerminalWrite,
  subscribeAgentSocket,
} from './useAgentSocket';

// Matches the editor's charcoal ember palette (styles.css :root) — xterm needs
// literal color strings for its theme, not CSS custom properties.
const XTERM_THEME = {
  background: 'oklch(0.115 0.006 285)',
  foreground: 'oklch(0.95 0.006 85)',
  cursor: 'oklch(0.684 0.192 42)',
  cursorAccent: 'oklch(0.115 0.006 285)',
  selectionBackground: 'oklch(0.684 0.192 42 / 0.14)',
  black: 'oklch(0.19 0.01 285)',
  brightBlack: 'oklch(0.42 0.016 285)',
  red: 'oklch(0.7 0.17 25)',
  brightRed: 'oklch(0.75 0.18 25)',
  green: 'oklch(0.76 0.14 150)',
  brightGreen: 'oklch(0.8 0.14 150)',
  yellow: 'oklch(0.8 0.13 85)',
  brightYellow: 'oklch(0.85 0.13 85)',
  blue: 'oklch(0.75 0.09 230)',
  brightBlue: 'oklch(0.8 0.09 230)',
  magenta: 'oklch(0.74 0.15 320)',
  brightMagenta: 'oklch(0.8 0.15 320)',
  cyan: 'oklch(0.78 0.1 200)',
  brightCyan: 'oklch(0.83 0.1 200)',
  white: 'oklch(0.95 0.006 85)',
  brightWhite: 'oklch(0.97 0.006 70)',
};

export interface TerminalProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export function Terminal({ onData, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Always read the latest callbacks without re-creating the xterm instance;
  // assigning during render is fine for this always-read-latest pattern.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;

  // Create the xterm instance once for this component's lifetime.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
      theme: XTERM_THEME,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    term.onData((data) => onDataRef.current(data));

    // Fit to the container and tell the pty — but only when the grid really
    // changed (a hidden dockview tab reports zero size; fit() is then a no-op
    // and re-sending the same cols/rows would be noise).
    let lastCols = -1;
    let lastRows = -1;
    function fitAndReport(): void {
      fitAddon.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        onResizeRef.current(term.cols, term.rows);
      }
    }
    fitAndReport();
    const resizeObserver = new ResizeObserver(fitAndReport);
    resizeObserver.observe(container);

    // Stream the buffered session into this instance: replay everything the
    // fresh cursor missed (the whole scrollback on mount — this is how a
    // reopened panel restores a live session), then each new delta as the
    // store commits. No React re-render is involved in this path.
    let cursor = initialWriteCursor();
    function drain(): void {
      const plan = planTerminalWrite(cursor, getAgentSocketSnapshot());
      if (plan.reset) term.reset();
      if (plan.text) term.write(plan.text);
      cursor = plan.cursor;
    }
    drain();
    const unsubscribe = subscribeAgentSocket(drain);

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, []);

  return <div className="agent-xterm" ref={containerRef} />;
}
