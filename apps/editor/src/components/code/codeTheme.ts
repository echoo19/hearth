/**
 * CM6 theme built from the editor's own design tokens (apps/editor/src/styles.css)
 * — charcoal surfaces, ember accent for selection/active-line/caret. No stock
 * light theme; this is the only palette the Code panel renders. Values below
 * are read off styles.css's `:root` block rather than re-derived, so a token
 * change there is the only place to update.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Mirrors apps/editor/src/styles.css :root — keep these two lists in sync by
// hand (a build-time CSS-var read would be neat but isn't worth the
// indirection for a fixed, intentionally-single palette).
const BG_0 = 'oklch(0.115 0.006 285)'; // window chrome, deepest
const BG_1 = 'oklch(0.15 0.008 285)'; // panels
const BG_2 = 'oklch(0.19 0.01 285)'; // inputs, cards, tab strip
const BORDER = 'oklch(0.32 0.014 285)';
const GUIDE = 'oklch(0.27 0.012 285)';
const INK = 'oklch(0.95 0.006 85)';
const INK_MUTE = 'oklch(0.74 0.012 85)';
const INK_FAINT = 'oklch(0.58 0.01 85)';
const ACCENT = 'oklch(0.684 0.192 42)';
const ACCENT_SOFT = 'oklch(0.684 0.192 42 / 0.14)';
const ACCENT_FAINT = 'oklch(0.684 0.192 42 / 0.055)';
const ERR = 'oklch(0.7 0.17 25)';
const ERR_SOFT = 'oklch(0.7 0.17 25 / 0.14)';
const FONT_MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** EditorView.theme: chrome (gutters, selection, cursor, panels) — everything but token colors. */
export const codeEditorTheme = EditorView.theme(
  {
    '&': {
      color: INK,
      backgroundColor: BG_1,
      height: '100%',
      // Intentionally 13px, not the 12px mono spec used elsewhere (Console,
      // values/scripts chrome) — a deliberate readability bump for the
      // editor's primary code-authoring surface, not a drift. See
      // .superpowers/polish/audit-visual.md P2-6.
      fontSize: '13px',
    },
    '.cm-content': {
      fontFamily: FONT_MONO,
      caretColor: ACCENT,
      padding: '10px 0',
    },
    '.cm-scroller': {
      fontFamily: FONT_MONO,
      lineHeight: '1.5',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: ACCENT,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: `${ACCENT_SOFT} !important`,
    },
    '.cm-activeLine': {
      backgroundColor: ACCENT_FAINT,
    },
    '.cm-activeLineGutter': {
      backgroundColor: ACCENT_FAINT,
      color: INK_MUTE,
    },
    '.cm-gutters': {
      backgroundColor: BG_0,
      color: INK_FAINT,
      border: 'none',
      borderRight: `1px solid ${BORDER}`,
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: BG_2,
      border: `1px solid ${BORDER}`,
      color: INK_MUTE,
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: ACCENT_SOFT,
      outline: 'none',
    },
    '.cm-searchMatch': {
      backgroundColor: ACCENT_FAINT,
      outline: `1px solid ${ACCENT}`,
    },
    '.cm-searchMatch-selected': {
      backgroundColor: ACCENT_SOFT,
    },
    '.cm-panels': {
      backgroundColor: BG_2,
      color: INK,
    },
    '.cm-panels-top': {
      borderBottom: `1px solid ${BORDER}`,
    },
    '.cm-tooltip': {
      backgroundColor: BG_2,
      border: `1px solid ${BORDER}`,
      color: INK,
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: ACCENT_SOFT,
      color: INK,
    },
    '.cm-diagnostic-error': {
      borderLeft: `3px solid ${ERR}`,
    },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      borderBottom: `1.5px dotted ${ERR}`,
    },
    '.cm-lint-marker-error': {
      color: ERR,
    },
  },
  { dark: true },
);

/** Token colors: an ember-tinted palette, muted rather than rainbow. */
const codeHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: INK_FAINT, fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: ACCENT },
  { tag: [t.string, t.special(t.string)], color: 'oklch(0.76 0.14 150)' },
  { tag: [t.number, t.bool, t.null], color: 'oklch(0.75 0.09 230)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'oklch(0.8 0.13 85)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: INK },
  { tag: [t.variableName, t.propertyName], color: INK },
  { tag: t.operator, color: INK_MUTE },
  { tag: [t.punctuation, t.bracket], color: INK_MUTE },
  { tag: t.className, color: 'oklch(0.8 0.13 85)' },
  { tag: t.invalid, color: ERR, backgroundColor: ERR_SOFT },
]);

export const codeTheme = [codeEditorTheme, syntaxHighlighting(codeHighlightStyle)];
