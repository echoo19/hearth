/**
 * Skills over HTTP.
 *
 *   GET  /api/skills            → every skill, and where they live
 *   GET  /api/skills/source     → one skill's markdown, for the editor
 *   POST /api/skills            → create / update / delete / enable / import
 *
 * Unlike every other route in this server, these are NOT scoped to a project:
 * a skill belongs to the person, not to the game they happen to have open, and
 * jailing them per folder would mean re-teaching the agent in every new one.
 * What that costs is the project jail as a safety net, so the validation here
 * carries the whole weight — every id goes through `safeSegment`, every
 * imported path through `safeRelativePath`, and the request shapes are checked
 * with zod before anything touches the disk.
 *
 * Some of what the list returns was only ever read — skills found in Claude
 * Code's and codex's own folders. Those can be switched on and off like any
 * other and nothing else, so the write actions refuse them here with a
 * sentence rather than letting the disk layer answer null and look like a
 * skill that went missing.
 *
 * Written against a host object rather than the http types so the behaviour is
 * testable without booting a server — the same shape harnessRegistry.ts uses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  deleteSkill,
  importSkill,
  listSkills,
  readSkill,
  readSkillSource,
  setSkillEnabled,
  skillsRoot,
  writeSkill,
  type SkillRecord,
  type SkillSourceId,
} from './skills.js';

export interface SkillsResult {
  status: number;
  body: unknown;
}

const Draft = z.object({
  name: z.string().trim().min(1, 'a skill needs a name').max(80),
  description: z.string().trim().max(400).default(''),
  body: z.string().max(200_000).default(''),
});

const ImportFile = z.object({
  relPath: z.string().min(1).max(400),
  data: z.string().max(6_000_000),
});

const Request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), draft: Draft }),
  z.object({ action: z.literal('update'), id: z.string().min(1).max(64), draft: Draft }),
  z.object({ action: z.literal('delete'), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal('enable'), id: z.string().min(1).max(64), enabled: z.boolean() }),
  z.object({
    action: z.literal('import'),
    name: z.string().trim().max(120).default('skill'),
    files: z.array(ImportFile).min(1).max(64),
  }),
]);

/** What GET /api/skills answers with. */
export interface SkillsPayload {
  skills: SkillRecord[];
  /** Shown in the panel so someone can go and look at the folder themselves. */
  root: string;
}

export async function getSkills(): Promise<SkillsResult> {
  return { status: 200, body: { skills: await listSkills(), root: skillsRoot() } satisfies SkillsPayload };
}

export async function getSkillSource(id: unknown): Promise<SkillsResult> {
  if (typeof id !== 'string' || id === '') {
    return { status: 400, body: { ok: false, error: 'Requires an "id".' } };
  }
  const draft = await readSkillSource(id);
  return draft ? { status: 200, body: { ok: true, draft } } : { status: 404, body: { ok: false, error: 'No such skill.' } };
}

/** What the user calls the thing whose folder a skill was found in. */
const AGENT: Record<SkillSourceId, string> = { hearth: 'Hearth', claude: 'Claude Code', codex: 'codex' };

/**
 * Refuse a write aimed at a skill Hearth only reads.
 *
 * `writeSkill` and `deleteSkill` both answer null for a discovered id, which
 * is the right answer on disk and a useless one on screen — indistinguishable
 * from a skill that isn't there. So the check happens here as well, ahead of
 * them, purely so the person gets told which agent's skill they just tried to
 * edit and what they can still do with it.
 */
async function readOnlyRefusal(id: string, verb: 'edit' | 'delete'): Promise<SkillsResult | null> {
  const skill = await readSkill(id);
  if (!skill || skill.editable) return null;
  const owner = AGENT[skill.source];
  // No name in front: a skill's `name` comes from frontmatter someone else
  // wrote, and a sentence starting in whatever case they used reads like a
  // bug. The folder path is the specific part, and it is the part that helps.
  const tail =
    verb === 'edit'
      ? `Hearth can switch it on or off, but it does not edit that folder. The file is at ${skill.path}.`
      : `Hearth can switch it off, but it does not delete that folder. It is at ${skill.path}.`;
  return { status: 403, body: { ok: false, error: `That skill belongs to ${owner}. ${tail}` } };
}

/**
 * Apply one change. Every branch answers with the full list, because the panel
 * is a list and re-reading the folder after a write is what keeps it honest
 * about what actually landed.
 */
export async function postSkills(raw: unknown): Promise<SkillsResult> {
  const parsed = Request.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: parsed.error.issues[0]?.message ?? 'Unusable request.' } };
  }
  const request = parsed.data;
  const answer = async (extra?: Record<string, unknown>): Promise<SkillsResult> => ({
    status: 200,
    body: { ok: true, skills: await listSkills(), root: skillsRoot(), ...extra },
  });

  switch (request.action) {
    case 'create': {
      const skill = await writeSkill(request.draft);
      return skill ? answer({ skill }) : { status: 500, body: { ok: false, error: 'Could not write that skill.' } };
    }
    case 'update': {
      const refused = await readOnlyRefusal(request.id, 'edit');
      if (refused) return refused;
      const skill = await writeSkill(request.draft, request.id);
      return skill ? answer({ skill }) : { status: 404, body: { ok: false, error: 'No such skill.' } };
    }
    case 'delete': {
      const refused = await readOnlyRefusal(request.id, 'delete');
      if (refused) return refused;
      const removed = await deleteSkill(request.id);
      return removed ? answer() : { status: 404, body: { ok: false, error: 'No such skill.' } };
    }
    case 'enable': {
      const skill = await setSkillEnabled(request.id, request.enabled);
      return skill ? answer({ skill }) : { status: 404, body: { ok: false, error: 'No such skill.' } };
    }
    case 'import': {
      const result = await importSkill(request.files, request.name);
      return result.skill
        ? answer({ skill: result.skill })
        : { status: 400, body: { ok: false, error: result.error ?? 'That folder is not a skill.' } };
    }
  }
}

/** Read a JSON body, capped — an import is the biggest thing that arrives. */
async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The http adapter. Everything above it is plain functions. */
export async function routeSkills(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const send = (result: SkillsResult): void => {
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
  try {
    if (req.method === 'GET' && pathname === '/api/skills/source') {
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id');
      return send(await getSkillSource(id));
    }
    if (req.method === 'GET') return send(await getSkills());
    if (req.method === 'POST') return send(await postSkills(await readBody(req)));
    return send({ status: 405, body: { ok: false, error: 'Use GET or POST.' } });
  } catch (err) {
    send({ status: 400, body: { ok: false, error: (err as Error).message } });
  }
}
