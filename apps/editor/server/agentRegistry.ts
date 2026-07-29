/**
 * Agents the user registered themselves, and the command that runs each one.
 *
 *   ~/.hearth/agents.json     one entry per agent, and nothing else
 *
 * THIS MUST NOT MOVE INTO THE PROJECT. Not `.hearth/agents.json`, not a corner
 * of `.hearth/app.json`, not anywhere else that travels with a folder. The
 * reasoning is already written at the top of permissionMode.ts and it is
 * sharper here: an entry in this file is a COMMAND LINE Hearth will spawn, so a
 * repo shipping one would hand whoever clones it arbitrary code execution the
 * first time they picked that agent. A decision about what may run on a machine
 * is made by the person sitting at it, so it lives in per-machine storage
 * beside skills, model preferences and permission modes.
 *
 * What an entry IS: a label, a command, and its arguments. What it is
 * deliberately NOT is a claim about models, capabilities, vendors or what kind
 * of work the agent does. Hearth spawns it, writes prompts to its stdin and
 * renders the events it writes back (see chatDrivers/customWire.ts for the
 * protocol). Anything more would be Hearth deciding what somebody else's agent
 * is for.
 *
 * Four decisions worth naming:
 *
 *  1. **Per machine, not per project.** See above. This is the whole reason
 *     the file exists rather than the setting living where the API keys do.
 *  2. **Confirmation is stored as the COMMAND STRING that was confirmed**, not
 *     as a boolean. `confirmedCommand` is compared against the command line an
 *     entry currently spells, so editing `my-agent` into `rm -rf /` does not
 *     inherit the yes the user gave the old one. A boolean would.
 *  3. **An unreadable file reads as no agents.** A missing file, a corrupt
 *     one, a directory where the file should be: all of them mean the chat
 *     falls back to the backends Hearth ships with. There is no failure mode in
 *     which failing to read this file makes Hearth run something it should not.
 *  4. **The cap REFUSES rather than evicting.** permissionMode.ts drops its
 *     oldest entry at the ceiling because a dropped permission entry falls back
 *     to the safe default. A dropped agent is somebody's configuration deleted
 *     without being asked, so a save past the cap fails and says so.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hearthHome } from './skills.js';

/** One agent the user registered, as it is stored and as it is used. */
export interface CustomAgent {
  /** Stable id, used on the wire and in a stored choice. Never shown. */
  id: string;
  /** What the user calls it. Shown beside the command, never instead of it. */
  label: string;
  /** The word spawned. Resolved against the login shell's PATH at spawn time. */
  command: string;
  /** Arguments, already split. Hearth never parses a command line into these. */
  args: string[];
  /**
   * The exact command line that was confirmed for this entry, or '' when none
   * has been. Compared rather than trusted: see note (2) at the top.
   */
  confirmedCommand: string;
}

/** Where the entries live. Beside models.json, skills and permissions.json. */
export function agentRegistryPath(): string {
  return path.join(hearthHome(), 'agents.json');
}

/**
 * A ceiling, so a corrupt or hostile file cannot become unbounded work. Far
 * above any real machine: this counts agents one person wired up by hand.
 */
export const MAX_CUSTOM_AGENTS = 25;

/** Caps on one entry, so nothing here can grow without limit. */
export const MAX_LABEL_LENGTH = 80;
export const MAX_COMMAND_LENGTH = 1024;
export const MAX_ARGS = 32;

/** The command line an entry spells, exactly as the UI must show it. */
export function agentCommandLine(agent: Pick<CustomAgent, 'command' | 'args'>): string {
  return [agent.command, ...agent.args].join(' ');
}

/**
 * Has this exact command line been confirmed by the person at this machine?
 *
 * The comparison is the point. A confirmed entry whose command was edited
 * afterwards reads as unconfirmed again, which is what stops a yes given to one
 * command from covering a different one.
 */
export function isAgentConfirmed(agent: CustomAgent): boolean {
  return agent.confirmedCommand !== '' && agent.confirmedCommand === agentCommandLine(agent);
}

/**
 * Shape only, and per entry. A file with one rotted entry still knows about the
 * others: dropping the whole map because one line went bad would silently
 * unregister every agent the user has.
 */
const Entry = z
  .object({
    label: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    confirmedCommand: z.string().optional(),
  })
  .passthrough();

/** An id is ours to mint, so it is held to a shape a URL and a file can carry. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID.test(value);
}

/**
 * A command has to be one word Hearth can hand to spawn. No newlines, no NUL,
 * and nothing empty. Notably NOT a shell line: arguments are their own field,
 * because splitting a line into arguments means implementing quoting rules, and
 * a wrong split is a different command than the one on screen.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function cleanCommand(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_COMMAND_LENGTH) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

function cleanArgs(values: readonly string[]): string[] | null {
  if (values.length > MAX_ARGS) return null;
  const out: string[] = [];
  for (const value of values) {
    // An argument may contain spaces (a path, a prompt fragment); it may not
    // contain a control character, which nothing legitimate needs and which
    // would make the command shown in Settings a different string from the one
    // that runs.
    if (value.length > MAX_COMMAND_LENGTH || CONTROL_CHARS.test(value)) return null;
    // An argument that is only whitespace is an empty field somebody left
    // behind, and it would render as nothing in the command line the pane shows
    // while still being passed. What is printed and what runs must be the same
    // string, so it goes.
    if (value.trim() !== '') out.push(value);
  }
  return out;
}

type AgentMap = Map<string, CustomAgent>;

/** Anything at all, reduced to entries we can use. */
function cleanFile(raw: unknown): AgentMap {
  const out: AgentMap = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const agents = (raw as Record<string, unknown>).agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return out;
  for (const [id, value] of Object.entries(agents as Record<string, unknown>)) {
    if (!isAgentId(id)) continue;
    const parsed = Entry.safeParse(value);
    if (!parsed.success) continue;
    const command = cleanCommand(parsed.data.command ?? '');
    if (command === null) continue;
    const args = cleanArgs(parsed.data.args ?? []);
    if (args === null) continue;
    const label = (parsed.data.label ?? '').trim().slice(0, MAX_LABEL_LENGTH);
    out.set(id, {
      id,
      // An entry that lost its label is still a usable agent, and the command
      // is the honest fallback name for it.
      label: label === '' ? command : label,
      command,
      args,
      confirmedCommand: (parsed.data.confirmedCommand ?? '').trim(),
    });
    if (out.size >= MAX_CUSTOM_AGENTS) break;
  }
  return out;
}

async function readFileMap(): Promise<AgentMap> {
  try {
    return cleanFile(JSON.parse(await fsp.readFile(agentRegistryPath(), 'utf8')));
  } catch {
    return new Map();
  }
}

/**
 * Write so a reader sees all of the new file or all of the old, never the
 * middle of a save. Same temp-and-rename as modelPrefs and permissionMode, and
 * the temp file sits in the same directory because a rename is only atomic
 * within one filesystem.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, text, 'utf8');
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function saveMap(map: AgentMap): Promise<void> {
  if (map.size === 0) {
    await fsp.rm(agentRegistryPath(), { force: true });
    return;
  }
  const agents: Record<string, unknown> = {};
  for (const [id, agent] of map) {
    agents[id] = {
      label: agent.label,
      command: agent.command,
      args: agent.args,
      confirmedCommand: agent.confirmedCommand,
    };
  }
  await writeAtomic(agentRegistryPath(), `${JSON.stringify({ agents }, null, 2)}\n`);
}

/** Every registered agent, in file order. An unreadable file reads as none. */
export async function readCustomAgents(): Promise<CustomAgent[]> {
  return [...(await readFileMap()).values()];
}

/** One agent by id, or null. What the driver seam asks. */
export async function readCustomAgent(id: string): Promise<CustomAgent | null> {
  if (!isAgentId(id)) return null;
  return (await readFileMap()).get(id) ?? null;
}

/**
 * An id for a new entry, derived from the label so a person reading the file
 * recognises their own agents. Uniqueness is by suffix rather than by a random
 * token: two agents called the same thing is a normal way to end up here.
 */
export function mintAgentId(label: string, taken: ReadonlySet<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stem = base === '' ? 'agent' : base;
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}`;
}

export interface AgentSave {
  /** Absent creates a new entry; present edits that one. */
  id?: string;
  label: string;
  command: string;
  args: string[];
}

/**
 * Create or edit one entry, leaving every other one exactly as it was.
 *
 * The confirmation is carried across only when the command line is unchanged.
 * Renaming an agent keeps its yes; changing what runs asks again, which is note
 * (2) at the top made real.
 */
export async function writeCustomAgent(save: AgentSave): Promise<CustomAgent> {
  const command = cleanCommand(save.command);
  if (command === null) throw new Error('That command cannot be run. Give the name of a program to launch.');
  const args = cleanArgs(save.args);
  if (args === null) throw new Error('Those arguments cannot be passed. Keep them to plain text, and to 32 or fewer.');
  const label = save.label.trim().slice(0, MAX_LABEL_LENGTH);
  if (label === '') throw new Error('Give this agent a name.');

  const map = await readFileMap();
  const existing = save.id !== undefined ? map.get(save.id) : undefined;
  if (save.id !== undefined && !existing) throw new Error('That agent is no longer registered.');
  // The cap refuses instead of evicting: see note (4). Only a NEW entry can
  // cross it, so editing at the ceiling still works.
  if (!existing && map.size >= MAX_CUSTOM_AGENTS) {
    throw new Error(`Hearth keeps up to ${MAX_CUSTOM_AGENTS} of your own agents. Remove one to add another.`);
  }
  const id = existing?.id ?? mintAgentId(label, new Set(map.keys()));
  const next: CustomAgent = {
    id,
    label,
    command,
    args,
    confirmedCommand:
      existing && existing.confirmedCommand === agentCommandLine({ command, args }) ? existing.confirmedCommand : '',
  };
  map.set(id, next);
  await saveMap(map);
  return next;
}

/** Forget one agent. Unknown ids are not an error: the end state is the same. */
export async function deleteCustomAgent(id: string): Promise<void> {
  const map = await readFileMap();
  if (!map.delete(id)) return;
  await saveMap(map);
}

/**
 * Record that the person at this machine has read the command line and accepted
 * that Hearth will run it. Stores the command line itself, so the answer cannot
 * outlive the question.
 */
export async function confirmCustomAgent(id: string): Promise<CustomAgent> {
  const map = await readFileMap();
  const agent = map.get(id);
  if (!agent) throw new Error('That agent is no longer registered.');
  const next: CustomAgent = { ...agent, confirmedCommand: agentCommandLine(agent) };
  map.set(id, next);
  await saveMap(map);
  return next;
}

// ---------------------------------------------------------------------------
// Over HTTP
//
//   GET  /api/agents                                   -> { ok, agents, file }
//   POST /api/agents { action: 'save',    id?, label, command, args }
//   POST /api/agents { action: 'delete',  id }
//   POST /api/agents { action: 'confirm', id }
//
// Every write answers with the whole list, so a client never has to merge: the
// server owns the ids and the confirmation state, and a client rebuilding the
// list from a single row is how an entry it has never seen gets dropped.
// ---------------------------------------------------------------------------

/** What the client renders. The command line is computed here so both halves
 * of the app show the identical string. */
export interface CustomAgentWire {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** `command args...`, exactly as Settings and the picker must print it. */
  commandLine: string;
  /** Has this command line been confirmed on this machine? */
  confirmed: boolean;
}

export function toWire(agent: CustomAgent): CustomAgentWire {
  return {
    id: agent.id,
    label: agent.label,
    command: agent.command,
    args: agent.args,
    commandLine: agentCommandLine(agent),
    confirmed: isAgentConfirmed(agent),
  };
}

export interface AgentsResult {
  status: number;
  body: unknown;
}

async function listing(): Promise<AgentsResult> {
  return {
    status: 200,
    body: { ok: true, agents: (await readCustomAgents()).map(toWire), file: agentRegistryPath() },
  };
}

export async function getAgents(): Promise<AgentsResult> {
  return listing();
}

const Save = z
  .object({
    action: z.literal('save'),
    id: z.string().regex(AGENT_ID).optional(),
    label: z.string().min(1).max(MAX_LABEL_LENGTH),
    command: z.string().min(1).max(MAX_COMMAND_LENGTH),
    args: z.array(z.string().max(MAX_COMMAND_LENGTH)).max(MAX_ARGS).optional(),
  })
  .strict();

const Target = z
  .object({
    action: z.enum(['delete', 'confirm']),
    id: z.string().regex(AGENT_ID),
  })
  .strict();

export async function postAgents(raw: unknown): Promise<AgentsResult> {
  const save = Save.safeParse(raw);
  if (save.success) {
    try {
      await writeCustomAgent({
        id: save.data.id,
        label: save.data.label,
        command: save.data.command,
        args: save.data.args ?? [],
      });
    } catch (err) {
      return { status: 400, body: { ok: false, error: (err as Error).message } };
    }
    return listing();
  }
  const target = Target.safeParse(raw);
  if (target.success) {
    try {
      if (target.data.action === 'delete') await deleteCustomAgent(target.data.id);
      else await confirmCustomAgent(target.data.id);
    } catch (err) {
      return { status: 400, body: { ok: false, error: (err as Error).message } };
    }
    return listing();
  }
  return {
    status: 400,
    body: { ok: false, error: 'Send an action of "save", "delete" or "confirm", with the fields it needs.' },
  };
}

/** A JSON body, capped. The biggest thing that arrives is one command line. */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('That request was too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The http adapter. Everything above it is plain functions. */
export async function routeAgents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (result: AgentsResult): void => {
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
  try {
    if (req.method === 'GET') return send(await getAgents());
    if (req.method === 'POST') return send(await postAgents(await readBody(req)));
    return send({ status: 405, body: { ok: false, error: 'Use GET or POST.' } });
  } catch (err) {
    send({ status: 400, body: { ok: false, error: (err as Error).message } });
  }
}
