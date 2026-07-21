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
const os = require('node:os');
const path = require('node:path');

function findDeveloperIdIdentity(keychain) {
  const out = execSync(
    keychain
      ? `security find-identity -v -p codesigning "${keychain}"`
      : 'security find-identity -v -p codesigning',
    { encoding: 'utf8' },
  );
  // lines look like:  1) <40-hex-sha1> "Developer ID Application: Name (TEAMID)"
  const match = out.split('\n').find((l) => l.includes('Developer ID Application'));
  if (!match) return null;
  const hash = match.match(/\)\s+([0-9A-F]{40})\s+"/i);
  return hash ? hash[1] : null;
}

/**
 * CI fallback: electron-builder imports CSC_LINK into a private keychain of
 * its own and signs with it explicitly, so on a fresh runner the Developer ID
 * never appears in the default keychain search list — find-identity comes up
 * empty even though the .app just got signed. (Locally the cert lives in the
 * login keychain, so the fallback never triggers.) Import the same p12 into a
 * throwaway keychain and hand back the identity plus the keychain to sign
 * against. The keychain password is random and never logged; the p12 password
 * rides argv exactly like electron-builder's own import does on the same
 * single-tenant runner.
 */
function importSigningKeychain() {
  const link = process.env.CSC_LINK || process.env.MAC_CSC_LINK;
  const p12Password = process.env.CSC_KEY_PASSWORD ?? process.env.MAC_CSC_KEY_PASSWORD ?? '';
  if (!link) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-dmg-sign-'));
  // codesign resolves identities through the keychain SEARCH LIST — the
  // --keychain flag alone is not enough (find-identity accepts an explicit
  // keychain; codesign does not). Capture the current user search list so the
  // throwaway keychain can be prepended and the list restored on cleanup.
  const originalSearchList = execSync('security list-keychains -d user', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const quotedOriginal = originalSearchList.map((k) => `"${k}"`).join(' ');
  const cleanup = (keychain) => {
    if (keychain) {
      try {
        execSync(`security list-keychains -d user -s ${quotedOriginal}`, { stdio: 'ignore' });
      } catch {
        /* best-effort */
      }
      try {
        execSync(`security delete-keychain "${keychain}"`, { stdio: 'ignore' });
      } catch {
        /* best-effort */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // CSC_LINK is base64 p12 in our CI; also accept a plain/file:// path so the
    // fallback behaves like electron-builder's loader for local experiments.
    const asPath = link.startsWith('file://') ? link.slice('file://'.length) : link;
    const p12 = path.join(dir, 'cert.p12');
    if (fs.existsSync(asPath)) fs.copyFileSync(asPath, p12);
    else fs.writeFileSync(p12, Buffer.from(link.replace(/\s/g, ''), 'base64'));
    const keychain = path.join(dir, 'dmg-sign.keychain-db');
    const keychainPassword = crypto.randomBytes(24).toString('hex');
    // Secrets ride as env vars the shell expands at runtime, never as JS
    // string interpolation: execSync failures embed the command line in
    // err.message, and that must stay free of password material.
    const run = (cmd) =>
      execSync(cmd, {
        stdio: 'ignore',
        env: { ...process.env, HEARTH_KC_PW: keychainPassword, HEARTH_P12_PW: p12Password },
      });
    run(`security create-keychain -p "$HEARTH_KC_PW" "${keychain}"`);
    // No auto-lock: notarization waits can outlive the default 300s timeout.
    run(`security set-keychain-settings "${keychain}"`);
    run(`security unlock-keychain -p "$HEARTH_KC_PW" "${keychain}"`);
    run(`security list-keychains -d user -s "${keychain}" ${quotedOriginal}`);
    run(`security import "${p12}" -k "${keychain}" -P "$HEARTH_P12_PW" -T /usr/bin/codesign`);
    // Chain building needs the Developer ID intermediate and the p12 may only
    // carry the leaf; fetch Apple's G2 intermediate into the same keychain.
    // Best-effort: when the p12 bundles the chain (or the runner has it), the
    // signing below works without this.
    try {
      const cer = path.join(dir, 'DeveloperIDG2CA.cer');
      run(`curl -fsSL -o "${cer}" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`);
      run(`security import "${cer}" -k "${keychain}"`);
    } catch {
      /* best-effort */
    }
    // Let codesign use the key non-interactively (no UI prompt on the runner).
    run(`security set-key-partition-list -S apple-tool:,apple: -s -k "$HEARTH_KC_PW" "${keychain}"`);
    const identity = findDeveloperIdIdentity(keychain);
    if (!identity) {
      cleanup(keychain);
      return null;
    }
    return { identity, keychain, cleanup: () => cleanup(keychain) };
  } catch (err) {
    cleanup();
    throw err;
  }
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

  let imported = null;
  let identity = findDeveloperIdIdentity(null);
  if (!identity) {
    imported = importSigningKeychain();
    identity = imported ? imported.identity : null;
  }
  if (!identity) {
    throw new Error('afterAllArtifactBuild: signing configured but no "Developer ID Application" identity found to sign the dmg');
  }
  const creds = notarytoolCreds();
  if (!creds) {
    if (imported) imported.cleanup();
    throw new Error('afterAllArtifactBuild: signing configured but no notarization credentials (set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_KEYCHAIN_PROFILE)');
  }
  const keychainArg = imported ? ` --keychain "${imported.keychain}"` : '';

  try {
    for (const dmg of dmgs) {
      console.log(`  • signing + notarizing dmg: ${path.basename(dmg)}`);
      execSync(`codesign --force --sign ${identity}${keychainArg} --timestamp "${dmg}"`, { stdio: 'inherit' });
      execSync(`xcrun notarytool submit "${dmg}" ${creds} --wait --timeout 30m`, { stdio: 'inherit' });
      execSync(`xcrun stapler staple "${dmg}"`, { stdio: 'inherit' });
    }
  } finally {
    if (imported) imported.cleanup();
  }

  const ymlUpdated = rewriteYmlDmgHashes(dmgs);
  console.log(
    `  • ${dmgs.length} dmg(s) signed, notarized, stapled` +
      (ymlUpdated ? '; latest-mac.yml dmg hashes updated' : ' (no latest-mac.yml alongside to update)')
  );
  return [];
};
