/**
 * How a tab strip answers the keyboard. One rule, two presentations.
 *
 * The app had two tab strips and only one of them worked. `Switch` (the
 * segmented control in the composer) implemented the whole pattern: roving
 * tabindex, arrow keys, Home and End. The playtest column's strip claimed
 * `role="tablist"` and `role="tab"` and implemented none of it, so a keyboard
 * user landed on a group of three separate tab stops that arrow keys did
 * nothing to, and a screen reader was told about panels that had no `role` and
 * no `aria-controls` pointing at them.
 *
 * Claiming a role is a promise about behaviour. Rather than write the promise
 * out twice and have it drift a third time, both strips call this.
 *
 * `nextTabIndex` is pure, which is the point: the wrapping and the Home/End
 * cases are the parts that get written wrong, and they are checkable without a
 * DOM.
 */

/** Which tab a key moves focus to, or null when the key is not ours. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      // Wraps. A tab strip is a ring: stopping at the end would make the last
      // tab a dead end for the one gesture that exists to get you out of it.
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The two attributes that tie a tab to the panel it shows. Both directions are
 * needed: `aria-controls` so the tab says what it opens, `aria-labelledby` so
 * the panel says what it is. Derived from one id so they cannot disagree.
 */
export function tabIds(strip: string, id: string): { tab: string; panel: string } {
  return { tab: `${strip}-tab-${id}`, panel: `${strip}-panel-${id}` };
}
