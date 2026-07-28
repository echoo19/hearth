/**
 * The words Hearth hands to the agent about skills, and the reading of a
 * folder someone picked.
 *
 * Kept out of the screens because neither screen owns them. The prompts are
 * copy — the exact sentence the agent is asked — and copy is easier to get
 * right when it can be read on its own, away from layout. The folder reader is
 * here for the same reason: both the list and the editor may need it, and
 * neither should have to import the other.
 */
import { base64FromDataUrl } from '../../chat/attachments';

/** What the agent is asked, when a skill is made "with chat". */
export function createWithChatPrompt(root: string): string {
  return [
    'Write me a new skill.',
    '',
    `Create a folder in ${root} named after the skill (lowercase, dashes), containing a SKILL.md`,
    'whose frontmatter has a `name` and a one-sentence `description` of when to use it,',
    'followed by the instructions themselves.',
    '',
    'First ask me what the skill should do, unless I have already told you.',
  ].join('\n');
}

/**
 * What the agent is asked, when someone presses "Improve description".
 *
 * A real job with a real result: the skill is already a file on disk and the
 * agent has the tools to read and rewrite it, so this asks for the edit rather
 * than for a suggestion that would have to be copied back by hand.
 */
export function improveDescriptionPrompt(name: string, folder: string): string {
  return [
    `Rewrite the description of my "${name}" skill.`,
    '',
    `The skill is the folder at ${folder}. Read its SKILL.md, then replace the`,
    '`description` line in the frontmatter with one sentence saying when you should',
    'reach for the skill, not what is inside it. Change nothing else in the file.',
    '',
    'Show me the old line and the new one when you are done.',
  ].join('\n');
}

/** Read a picked folder into what the import route wants. */
export async function readFolder(files: readonly File[]): Promise<{ relPath: string; data: string }[]> {
  const out: { relPath: string; data: string }[] = [];
  for (const file of files) {
    // webkitRelativePath is `<chosen-folder>/<rest>`; the folder itself is
    // named by the slug we derive, so only the rest matters.
    const full = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
    const relPath = full.split('/').slice(1).join('/') || file.name;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`could not read ${file.name}`));
      reader.onload = () => resolve(base64FromDataUrl(String(reader.result ?? '')));
      reader.readAsDataURL(file);
    });
    out.push({ relPath, data });
  }
  return out;
}

/** The name a picked folder suggests, used when its SKILL.md names nothing. */
export function folderNameOf(files: readonly File[]): string {
  const first = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
  return first?.split('/')[0] ?? 'skill';
}
