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
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc signing ${appName} (no Developer ID yet)`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
};
