/**
 * electron-builder afterAllArtifactBuild hook: sign + notarize + staple the
 * macOS .dmg *containers*.
 *
 * electron-builder signs and notarizes the .app inside the disk image, but it
 * leaves the .dmg itself unsigned and un-notarized. On modern macOS a
 * downloaded (quarantined) unsigned dmg trips Gatekeeper on mount ("Apple
 * could not verify this dmg is free of malware"), even though the app inside
 * is fine. So we sign the dmg with the same Developer ID, submit it to Apple,
 * and staple the ticket — giving a warning-free first-launch download.
 *
 * Runs only on macOS, and only when real Developer ID signing is configured
 * (CSC_LINK / MAC_CSC_LINK / CSC_NAME). Ad-hoc builds have no dmg targets and
 * no signing, so this no-ops. Credentials come from either the Apple ID env
 * vars (CI) or the notarytool keychain profile (local). Signing the dmg
 * changes its hash, so we rewrite the dmg entries in latest-mac.yml to match
 * (the auto-updater downloads the zip, but keep the feed honest).
 */
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function findDeveloperIdIdentity() {
  const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
  // lines look like:  1) <40-hex-sha1> "Developer ID Application: Name (TEAMID)"
  const match = out.split('\n').find((l) => l.includes('Developer ID Application'));
  if (!match) return null;
  const hash = match.match(/\)\s+([0-9A-F]{40})\s+"/i);
  return hash ? hash[1] : null;
}

function notarytoolCreds() {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE } = process.env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return `--apple-id "${APPLE_ID}" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_SPECIFIC_PASSWORD}"`;
  }
  if (APPLE_KEYCHAIN_PROFILE) {
    return `--keychain-profile "${APPLE_KEYCHAIN_PROFILE}"`;
  }
  return null;
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(file));
  return hash.digest('base64');
}

function rewriteYmlDmgHashes(dmgs) {
  // latest-mac.yml sits alongside the dmgs, not necessarily at context.outDir.
  const ymlPath = path.join(path.dirname(dmgs[0]), 'latest-mac.yml');
  if (!fs.existsSync(ymlPath)) return false;
  let yml = fs.readFileSync(ymlPath, 'utf8');
  for (const dmg of dmgs) {
    const name = path.basename(dmg);
    const sha = sha512Base64(dmg);
    const size = fs.statSync(dmg).size;
    const re = new RegExp(
      `(- url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s*sha512: )[^\\n]+(\\n\\s*size: )\\d+`
    );
    yml = yml.replace(re, (_m, a, b) => a + sha + b + size);
  }
  fs.writeFileSync(ymlPath, yml);
  return true;
}

module.exports = async function afterAllArtifactBuild(context) {
  if (process.platform !== 'darwin') return [];
  const signingConfigured =
    process.env.CSC_LINK || process.env.MAC_CSC_LINK || process.env.CSC_NAME;
  if (!signingConfigured) return [];

  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];

  const identity = findDeveloperIdIdentity();
  if (!identity) {
    throw new Error('afterAllArtifactBuild: signing configured but no "Developer ID Application" identity found to sign the dmg');
  }
  const creds = notarytoolCreds();
  if (!creds) {
    throw new Error('afterAllArtifactBuild: signing configured but no notarization credentials (set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_KEYCHAIN_PROFILE)');
  }

  for (const dmg of dmgs) {
    console.log(`  • signing + notarizing dmg: ${path.basename(dmg)}`);
    execSync(`codesign --force --sign ${identity} --timestamp "${dmg}"`, { stdio: 'inherit' });
    execSync(`xcrun notarytool submit "${dmg}" ${creds} --wait --timeout 30m`, { stdio: 'inherit' });
    execSync(`xcrun stapler staple "${dmg}"`, { stdio: 'inherit' });
  }

  const ymlUpdated = rewriteYmlDmgHashes(dmgs);
  console.log(
    `  • ${dmgs.length} dmg(s) signed, notarized, stapled` +
      (ymlUpdated ? '; latest-mac.yml dmg hashes updated' : ' (no latest-mac.yml alongside to update)')
  );
  return [];
};
