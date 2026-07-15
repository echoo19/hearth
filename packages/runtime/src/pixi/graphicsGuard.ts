/**
 * Guard against Pixi v8's destroy-then-clear race (see L-116 in
 * .superpowers/sdd/waveL/LEDGER.md): `Graphics.destroy()` sets its internal
 * `_context` to null, but — unlike most of Pixi's post-destroy API, which
 * quietly no-ops — `clear()` (and every other draw call) happily dereferences
 * it, throwing "Cannot read properties of null (reading 'clear')". The
 * investigation could not reproduce the live crash (it only manifests under
 * real-GPU + foreground-tab timing a sandboxed browser can't provide), but
 * this is the only code path in the codebase that provably yields that exact
 * error, so every retained-Graphics redraw helper in ./index.ts calls this
 * instead of `g.clear()` directly: it returns `false` (and skips the clear)
 * when `g` is already destroyed, so callers can bail out of the rest of
 * their draw calls too — those would otherwise throw the same way on the
 * same null `_context`.
 */
export function clearGraphics(g: { readonly destroyed: boolean; clear(): unknown }): boolean {
  if (g.destroyed) return false;
  g.clear();
  return true;
}
