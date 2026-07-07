/**
 * electron-builder afterPack hook: ad-hoc code-sign the macOS app.
 *
 * We have no Apple Developer identity yet, and electron-builder's
 * `identity: null` skips signing entirely — but repacking the asar
 * invalidates Electron's own ad-hoc signature, so a downloaded (quarantined)
 * app shows macOS's "damaged and can't be opened" dialog with no way
 * through. Re-signing ad-hoc ("-") makes the signature valid again, which
 * downgrades Gatekeeper to the standard "unidentified developer" flow:
 * right-click → Open works. Real signing + notarization is on the roadmap.
 *
 * `codesign --deep` only walks recognized nested *bundle* structures
 * (frameworks, .app, xpc services, etc) — it does NOT descend into loose
 * files sitting under Contents/Resources/app.asar.unpacked/, which is
 * exactly where asarUnpack'd native modules (e.g. @lydell/node-pty's
 * prebuilt pty.node + spawn-helper) live. Verified empirically: stripping
 * pty.node's signature and re-running `codesign --deep --force --sign -`
 * over the app left it unsigned, and `codesign --verify --deep --strict`
 * didn't even flag it as a problem. An unsigned Mach-O binary under
 * asar.unpacked would ship silently broken — arm64 macOS refuses to load
 * any unsigned code, ad-hoc or not. So sign every Mach-O file found under
 * app.asar.unpacked explicitly, before the whole-app deep sign.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function isMachO(file) {
  try {
    return /Mach-O/.test(execSync(`file -b "${file}"`).toString());
  } catch {
    return false;
  }
}

function signUnpackedBinaries(appPath) {
  const unpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (!fs.existsSync(unpackedDir)) return;
  const binaries = collectFiles(unpackedDir).filter(isMachO);
  if (binaries.length === 0) return;
  console.log(`  • ad-hoc signing ${binaries.length} unpacked native binary(ies)`);
  for (const file of binaries) {
    execSync(`codesign --force --sign - "${file}"`, { stdio: 'inherit' });
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // When a real Developer ID certificate is configured (CSC_LINK), electron-
  // builder signs + notarizes after this hook — skip the ad-hoc pass so we
  // never race the real signature.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('  • real signing configured; skipping ad-hoc fallback');
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc signing ${appName} (no Developer ID configured)`);
  signUnpackedBinaries(appPath);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
};
