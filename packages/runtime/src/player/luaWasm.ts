/**
 * Placeholder for the inlined wasmoon glue.wasm.
 *
 * The player build (scripts/build-player.mjs) substitutes this module with
 * one exporting the real `data:application/wasm;base64,...` URI, embedded at
 * build time so the exported player is fully self-contained. The plain tsc
 * package build keeps this empty string, in which case setLuaWasmUri is not
 * called and wasmoon falls back to its own module resolution (Node hosts).
 */
export const LUA_WASM_DATA_URI = '';
