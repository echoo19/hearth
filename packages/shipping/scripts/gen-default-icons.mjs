/**
 * Regenerate the bundled default desktop icons (assets/hearth.icns and
 * assets/hearth.ico) from the real 512x512 assets/hearth-icon.png using
 * png2icons. Run once and check the outputs in; re-run only when the source
 * PNG changes.
 *
 *   node packages/shipping/scripts/gen-default-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import png2icons from 'png2icons';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '..', 'assets');
const src = readFileSync(path.join(assets, 'hearth-icon.png'));

const icns = png2icons.createICNS(src, png2icons.BICUBIC, 0);
if (!icns) throw new Error('createICNS returned null');
writeFileSync(path.join(assets, 'hearth.icns'), icns);

const ico = png2icons.createICO(src, png2icons.BICUBIC, 0, false);
if (!ico) throw new Error('createICO returned null');
writeFileSync(path.join(assets, 'hearth.ico'), ico);

console.log(`Wrote hearth.icns (${icns.length} B) and hearth.ico (${ico.length} B)`);
