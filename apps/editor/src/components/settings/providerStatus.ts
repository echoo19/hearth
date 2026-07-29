/**
 * How each provider's state reads in one line.
 *
 * Pulled out of the settings dialog because the dialog is now a shell and the
 * provider question lives in one pane inside it. These are the sentences the
 * app says about credentials, and they are worth keeping in one file: two
 * providers asked for in the terms each one actually uses — Anthropic is a key
 * you paste, OpenAI is a CLI you install and sign into — but answered in one
 * vocabulary, so neither reads as the afterthought.
 *
 * Pure functions over the status the server reports. Nothing here touches a
 * secret: a key written in Hearth goes to `.hearth/app.json` and never comes
 * back, so the most the UI ever learns is whether one exists and where it came
 * from.
 */
import type { ChatProviderStatus } from '../../types';

/** How the current Anthropic credential source reads in one line. */
export function keySourceLabel(source: 'project' | 'environment' | null): string {
  switch (source) {
    case 'project':
      return 'A key is saved for this project.';
    case 'environment':
      return 'Using ANTHROPIC_API_KEY from the environment.';
    default:
      // Not a problem to fix. The CLI answers on the sign-in it already has,
      // and this line used to tell people with a working Claude that their
      // conversation could only point them at the Terminal.
      return 'No key. It answers on the Claude Code you are signed into.';
  }
}

/**
 * Where the Codex side stands, as one line. Ordered by what blocks the user
 * first: a missing binary is a different problem from a missing sign-in, and
 * saying "not signed in" to someone who hasn't installed it wastes their time.
 */
export function openAiStatusLabel(openai: ChatProviderStatus['openai'] | undefined): string {
  if (!openai || !openai.installed) return 'Not installed.';
  if (openai.loggedIn) {
    if (openai.authMode === 'apikey') return 'Signed in with an API key.';
    const who = openai.email ?? 'ChatGPT';
    return openai.planType ? `Signed in as ${who} (${openai.planType}).` : `Signed in as ${who}.`;
  }
  if (openai.hasKey) return 'Installed. Using the API key saved for this project.';
  // NOT "Installed, not signed in." The wire cannot tell those two apart.
  // `readCodexStatus` (server/chatDrivers/codex.ts) spawns a fresh
  // `codex app-server` for every probe and falls back to `loggedIn: hasKey` on
  // any failure, so a machine that is merely busy answers exactly like a
  // machine nobody has signed into, and this pane was then offering a sign-in
  // to someone already signed in. Until the driver reports a third state, the
  // honest sentence claims only what Hearth managed to find out. The row's
  // body carries the rest.
  return 'Installed. No sign-in confirmed.';
}

/**
 * Can this provider answer a turn right now?
 *
 * Two ways in, and the sign-in is the ordinary one. The SDK runs the Claude
 * Code CLI, which authenticates with whatever the person is signed into, so a
 * key is an alternative rather than a requirement.
 */
export function anthropicUsable(status: ChatProviderStatus | null): boolean {
  // Signed in, not merely installed. `cli` is only the binary's presence, and
  // treating that as usable made every claude-on-PATH machine claim it could
  // answer whether or not anybody had ever signed into it.
  return status?.anthropic.hasKey === true || status?.anthropic.loggedIn === true;
}

export function openAiUsable(status: ChatProviderStatus | null): boolean {
  return status?.openai.installed === true && (status.openai.loggedIn || status.openai.hasKey);
}
