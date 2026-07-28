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
      return 'No key yet. Without one, the conversation can only point you at the Terminal.';
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
  return openai.hasKey ? 'Installed. Using the API key saved for this project.' : 'Installed, not signed in.';
}

/** Can this provider answer a turn right now? */
export function anthropicUsable(status: ChatProviderStatus | null): boolean {
  return status?.anthropic.hasKey === true;
}

export function openAiUsable(status: ChatProviderStatus | null): boolean {
  return status?.openai.installed === true && (status.openai.loggedIn || status.openai.hasKey);
}
