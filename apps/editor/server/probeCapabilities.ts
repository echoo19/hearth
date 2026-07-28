/**
 * What the last sweep proved this game can be sensed through.
 *
 * The record is a file in the evidence folder, written by whoever ran the
 * sweep. That used to be the app itself; playtesting is the agent's business
 * now and runs out of process, so this side only ever reads. A folder with no
 * record reads as "nothing proven yet", which is the honest answer for a game
 * nothing has played.
 *
 * Split out from the sweep runner it used to live beside, because
 * GET /api/probe/status outlived the runner: the senses read-out is about the
 * game, not about a sweep the app is holding.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ProbeCapabilities } from '@hearth/probe-core';

export const CAPABILITIES_FILE = path.join('.hearth', 'evidence', 'capabilities.json');

export interface CapabilityRecord {
  ts: string;
  target: string;
  shimDetected: boolean;
  capabilities: ProbeCapabilities;
}

export async function readCapabilities(root: string): Promise<CapabilityRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(root, CAPABILITIES_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<CapabilityRecord>;
    return record.capabilities && typeof record.capabilities === 'object'
      ? {
          ts: typeof record.ts === 'string' ? record.ts : new Date(0).toISOString(),
          target: typeof record.target === 'string' ? record.target : '',
          shimDetected: record.shimDetected === true,
          capabilities: record.capabilities as ProbeCapabilities,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * What the app can honestly claim to see, given a recorded capability set.
 * Preview, errors and shots come free with any web game the adapter can open;
 * the rest are only claimed when the game declared them (i.e. the shim was
 * detected). Pure, so the honesty rule is unit-tested without a browser.
 */
export function sensesFromCapabilities(record: CapabilityRecord | null, gamePresent: boolean): string[] {
  if (!gamePresent) return [];
  const senses = ['preview', 'errors', 'screenshots'];
  const declared = record?.capabilities.senses;
  if (declared?.entities) senses.push('entities');
  if (declared?.events) senses.push('events');
  if (declared?.scenes) senses.push('scenes');
  return senses;
}
