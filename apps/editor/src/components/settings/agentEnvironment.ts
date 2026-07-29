/**
 * What this pane can honestly know before a folder is open.
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
 * WHAT IS ACTUALLY KNOWABLE WITH NO FOLDER OPEN, which is the whole question:
 *
 *   codex on PATH        YES. `GET /api/agent-clis` is deliberately not
 *                        project-scoped (see server/agentClis.ts: "the picker
 *                        needs an answer on Home too"), and what is installed
 *                        is a fact about the machine. The one thing PATH
 *                        cannot see is a `codexPath` override, and that lives
 *                        in a folder's own app.json, so with no folder open
 *                        PATH is the whole of the available truth.
 *   a ChatGPT sign-in    NO route today. The credential is machine-global
 *                        (~/.codex/auth.json) but the only reader of it is
 *                        `/api/chat/providers`, which takes a project.
 *   ANTHROPIC_API_KEY    NO route today. Machine-global as well, and read only
 *                        by `/api/app/settings`, which also takes a project.
 *
 * So one of the three is a fact and two are unasked questions, and this module
 * is what lets the pane say exactly that instead of averaging them into a no.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiAgentClis } from '../../api';

/** The id `server/agentClis.ts` gives the Codex CLI. */
export const CODEX_CLI_ID = 'codex';

export interface AgentEnvironment {
  /**
   * A folder is open, so a key has somewhere to be written and the terminal
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
}

/** Before anything has been asked. Nothing in it claims a negative. */
export const UNKNOWN_ENVIRONMENT: AgentEnvironment = { hasProject: false, codexInstalled: null };

/**
 * Ask the machine what it has, and hand back a way to ask again.
 *
 * Re-asked on demand rather than polled: an install run from this pane
 * finishes in a terminal Hearth does not watch, and the honest way to notice
 * is a button the user presses when they come back, not a timer that makes the
 * row flicker while they are reading it.
 */
export function useAgentEnvironment(hasProject: boolean): {
  environment: AgentEnvironment;
  recheck: () => void;
} {
  const [codexInstalled, setCodexInstalled] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const clis = await apiAgentClis();
      if (!live) return;
      // A read that did not land leaves the answer null. Writing false here
      // would be the same false negative one layer down, and this module is
      // the one place that must not do that.
      if (clis === null) return;
      setCodexInstalled(clis.find((cli) => cli.id === CODEX_CLI_ID)?.installed === true);
    })();
    return () => {
      live = false;
    };
  }, [nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { environment: { hasProject, codexInstalled }, recheck };
}
