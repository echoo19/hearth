/**
 * What this pane can honestly know, and how it found out.
 *
 * THE BUG THIS EXISTS FOR. Every read the Agents pane used to have began
 * `if (!project) return;`, and the state it read into starts as null. So on
 * Home the pane rendered from nulls and turned "nobody has asked" into three
 * confident negatives: "Not added yet" with an Add Codex button, offered to
 * someone who has codex installed and is signed into ChatGPT; "Not connected
 * yet", offered to someone with ANTHROPIC_API_KEY already in their shell; and
 * a hero announcing that nothing is connected and Hearth cannot answer a
 * message. A provider pane may be uncertain and may be wrong, but the one
 * direction it must never fail in is a confident false negative, because that
 * is the one that sends a user off to fix something that is not broken.
 *
 * WHAT IS ACTUALLY KNOWABLE WITH NO PROJECT OPEN, which is the whole question:
 *
 *   codex on PATH        YES. `GET /api/agent-clis` is deliberately not
 *                        project-scoped (see server/agentClis.ts: "the picker
 *                        needs an answer on Home too"), and what is installed
 *                        is a fact about the machine. The one thing PATH
 *                        cannot see is a `codexPath` override, and that lives
 *                        in a project's own app.json, so with no project open
 *                        PATH is the whole of the available truth.
 *   a ChatGPT sign-in    NO route today. The credential is machine-global
 *                        (~/.codex/auth.json) but the only reader of it is
 *                        `/api/chat/providers`, which takes a project.
 *   ANTHROPIC_API_KEY    NO route today. Machine-global as well, and read only
 *                        by `/api/app/settings`, which also takes a project.
 *
 * So one of the three is a fact and two are unasked questions, and this module
 * is what lets the pane say exactly that instead of averaging them into a no.
 *
 * AND THE SECOND HALF, which the first version of this module did not have:
 * "nobody asked" and "we asked and it did not come back" are also two
 * different things, and collapsing them is the same failure one notch over.
 * Both reads answer null on failure and both stores keep the last good value
 * standing rather than writing the null through, which is right — but it left
 * this pane rendering a permanent "Looking for a key in this project." with no
 * error, no spinner and no way to ask again. So every read here carries a
 * `ReadState` beside its answer, and a `failed` one is never allowed to wear
 * the words of a `checking` one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAgentClis } from '../../api';
import { useApp } from '../../store';

/** The id `server/agentClis.ts` gives the Codex CLI. */
export const CODEX_CLI_ID = 'codex';

/**
 * How a read went. Four states because three of them look identical from the
 * data alone: an answer that has not been asked for, one still in flight and
 * one that came back empty all leave the same null behind.
 */
export type ReadState = 'unread' | 'checking' | 'ok' | 'failed';

export interface AgentEnvironment {
  /**
   * A project is open, so a key has somewhere to be written and the terminal
   * has a directory to run in. Not the same question as whether anything has
   * been read.
   */
  hasProject: boolean;
  /**
   * Is `codex` on this machine? Null while the read is still out, and null is
   * a real answer here: "not asked yet" and "not installed" get different
   * sentences, and only one of them gets an install button.
   */
  codexInstalled: boolean | null;
  /** How the machine read (`/api/agent-clis`) went. */
  machineRead: ReadState;
  /**
   * How the project-scoped read (`/api/chat/providers`, `/api/app/settings`)
   * went. `failed` here is the state that used to be invisible: the providers
   * route answers 403 for a root the server has not marked open yet, which
   * includes the gap in the middle of a project switch.
   */
  projectRead: ReadState;
}

/** Before anything has been asked. Nothing in it claims a negative. */
export const UNKNOWN_ENVIRONMENT: AgentEnvironment = {
  hasProject: false,
  codexInstalled: null,
  machineRead: 'unread',
  projectRead: 'unread',
};

/**
 * Ask the machine and the project what they have, and hand back a way to ask
 * again.
 *
 * Re-asked on demand rather than polled: an install run from this pane
 * finishes in a terminal Hearth does not watch, and the honest way to notice
 * is a button the user presses when they come back, not a timer that makes the
 * row flicker while they are reading it.
 *
 * ONE PROBE AT A TIME, which is the other thing this hook is for.
 * `readCodexStatus` spawns a fresh `codex app-server` for every probe, gives
 * up after fifteen seconds, and reports a signed-out account when it does. So
 * two probes racing is not a harmless duplicate: the slow one is also the one
 * carrying the wrong answer, and if it lands second it overwrites a good read
 * with a timeout. The store's write is not ours to order, so the discipline
 * here is that this pane never has two of its own reads in flight.
 */
export function useAgentEnvironment(project: string | null): {
  environment: AgentEnvironment;
  recheck: () => void;
  checking: boolean;
} {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const [codexInstalled, setCodexInstalled] = useState<boolean | null>(null);
  const [machineRead, setMachineRead] = useState<ReadState>('unread');
  const [projectRead, setProjectRead] = useState<ReadState>('unread');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setMachineRead('checking');
    void (async () => {
      const clis = await apiAgentClis();
      if (!live) return;
      // A read that did not land leaves the answer null. Writing false here
      // would be the same false negative one layer down, and this module is
      // the one place that must not do that. It does change `machineRead`,
      // because a row that says it is still checking half an hour after the
      // request died is its own kind of lie.
      if (clis === null) {
        setMachineRead('failed');
        return;
      }
      setCodexInstalled(clis.find((cli) => cli.id === CODEX_CLI_ID)?.installed === true);
      setMachineRead('ok');
    })();
    return () => {
      live = false;
    };
  }, [nonce]);

  useEffect(() => {
    if (project === null) {
      setProjectRead('unread');
      return;
    }
    let live = true;
    setProjectRead('checking');
    void (async () => {
      // Whether the read landed, told from outside the store, because the
      // store cannot say: `refreshProviders` returns void and deliberately
      // keeps the previous value on a null answer. A successful read always
      // writes a freshly built object (see apiChatProviders), so a reference
      // that did not move is a read that did not land.
      const before = useApp.getState().providers;
      await Promise.all([refreshProviders(), refreshSettings()]);
      if (!live) return;
      const now = useApp.getState();
      const landed = now.providers !== null && now.providers !== before;
      setProjectRead(landed ? 'ok' : 'failed');
    })();
    return () => {
      live = false;
    };
  }, [nonce, project, refreshProviders, refreshSettings]);

  const checking = machineRead === 'checking' || projectRead === 'checking';
  const checkingRef = useRef(checking);
  checkingRef.current = checking;

  const recheck = useCallback(() => {
    // See the header: a second probe fired over the top of a live one is how a
    // fifteen-second timeout ends up being the answer of record.
    if (checkingRef.current) return;
    setNonce((n) => n + 1);
  }, []);

  return { environment: { hasProject: project !== null, codexInstalled, machineRead, projectRead }, recheck, checking };
}
