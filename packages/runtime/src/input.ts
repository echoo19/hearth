/**
 * InputState — action-based input for the Hearth runtime.
 *
 * Actions are named in the project's inputMappings (action name → list of
 * KeyboardEvent.code values). The runtime and scripts only ever see actions;
 * raw key codes enter through `handleKeyDown/Up` (browser hosts) while
 * playtests drive actions directly via `setActionDown/Up`.
 */
export class InputState {
  private codeToActions = new Map<string, string[]>();
  private actionToCodes: Record<string, string[]>;
  private downActions = new Set<string>();
  private justPressedActions = new Set<string>();
  private downCodes = new Set<string>();

  constructor(actions: Record<string, string[]> = {}) {
    this.actionToCodes = actions;
    for (const [action, codes] of Object.entries(actions)) {
      for (const code of codes) {
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }
  }

  /** Is the action currently held? */
  isDown(action: string): boolean {
    return this.downActions.has(action);
  }

  /** Did the action transition to down this frame? Cleared by `endFrame()`. */
  justPressed(action: string): boolean {
    return this.justPressedActions.has(action);
  }

  /** Programmatically press an action (used by playtests). */
  setActionDown(action: string): void {
    if (!this.downActions.has(action)) {
      this.downActions.add(action);
      this.justPressedActions.add(action);
    }
  }

  /** Programmatically release an action (used by playtests). */
  setActionUp(action: string): void {
    this.downActions.delete(action);
  }

  /** Feed a KeyboardEvent.code keydown; maps to actions, ignores key repeat. */
  handleKeyDown(code: string): void {
    if (this.downCodes.has(code)) return; // OS key repeat
    this.downCodes.add(code);
    for (const action of this.codeToActions.get(code) ?? []) {
      this.setActionDown(action);
    }
  }

  /** Feed a KeyboardEvent.code keyup; releases actions with no other held key. */
  handleKeyUp(code: string): void {
    this.downCodes.delete(code);
    for (const action of this.codeToActions.get(code) ?? []) {
      const codes = this.actionToCodes[action] ?? [];
      if (!codes.some((c) => this.downCodes.has(c))) this.setActionUp(action);
    }
  }

  /** True when a KeyboardEvent.code is bound to any action (for preventDefault). */
  isMappedCode(code: string): boolean {
    return this.codeToActions.has(code);
  }

  /** Internal: called by the runtime at the end of each fixed frame. */
  endFrame(): void {
    this.justPressedActions.clear();
  }
}
