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
 * Written against a host object rather than the http types so the behaviour is
 * testable without booting a server — the same shape harnessRegistry.ts uses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  deleteSkill,
  importSkill,
  listSkills,
  readSkillSource,
  setSkillEnabled,
  skillsRoot,
  writeSkill,
  type SkillRecord,
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
      const skill = await writeSkill(request.draft, request.id);
      return skill ? answer({ skill }) : { status: 404, body: { ok: false, error: 'No such skill.' } };
    }
    case 'delete': {
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
