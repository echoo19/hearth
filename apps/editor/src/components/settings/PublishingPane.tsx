/**
 * Settings → Publishing: the one machine-wide credential Hearth holds for
 * itself.
 *
 * WHAT THIS PANE IS FOR, and the reason it is this small: publishing a game
 * needs an account on the Hearth Catalog, and an account is proved by a token
 * the person creates over there and pastes in here once. That is the whole
 * job. The publish dialog owns everything about a publish — what is sent, what
 * it is called, where it went — and it sends people here when there is no
 * token to send it with. So this pane holds a credential and nothing else; a
 * second publish form on a settings screen would be two places to start the
 * same act and one of them would be the wrong one.
 *
 * THE TOKEN ONLY EVER TRAVELS ONE WAY. It goes from the field to the server
 * and is written into `~/.hearth/`; nothing reads it back. `apiCatalogAccount`
 * answers with the username it resolves to, which is the only part a screen
 * has any use for, so the field is empty every time this pane mounts and that
 * emptiness is the truth rather than a placeholder for something hidden. It is
 * never logged, never put in a toast, and never handed to anything but
 * `apiCatalogConnect`.
 *
 * FOUR STATES, and the pane is a single block that says which one it is in:
 *
 *   reading       the read is in flight and this pane claims nothing
 *   unreadable    the read did not come back, said as that and not as "no"
 *   disconnected  no token here: one line on what a token is for, a link to
 *                 the page that makes one, a field, a button
 *   connected     who it is connected as, which instance, and Disconnect
 *   stale         a token IS stored and the catalog is refusing it
 *
 * The last one is the one that matters and the reason `catalogState` is a
 * function rather than a chain of ternaries in the render. `account.error` set
 * means the credential on this machine has stopped working, and the person has
 * to be told that in those words — because every other surface will fail at
 * publish time and point back at a pane that was sitting here showing a calm
 * green Connected. An expired token that reads as connected is the same class
 * of mistake as a truncated key wearing a Connected badge (see apiKeyShape.ts):
 * confidently wrong in the direction that costs the user a debugging session.
 * So `error` wins over `connected`, unconditionally, whatever else the server
 * says in the same body.
 *
 * `unreadable` exists for the mirror-image rule, the one the whole app is
 * built on: never render "there is nothing" when the truth is "we have not
 * looked yet". `apiCatalogAccount` answers `null` for a transport failure, a
 * refusal and a malformed body alike, so a null is not permission to say
 * "no account". It says the read failed and offers the read again.
 *
 * THE SHAPE CHECK IS A WARNING, NOT A GATE, which is the house pattern from
 * apiKeyShape.ts and is deliberate here too. A catalog token is Hearth's own
 * format, so the check can be exact — but this build outlives the format, and
 * the server verifies every token against the catalog before it stores one, so
 * letting an unrecognised string through costs a single clean sentence while
 * refusing outright would lock someone out of their own account with a stale
 * client. First press says what looks wrong and sends nothing; second press
 * sends it anyway.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiCatalogAccount,
  apiCatalogConnect,
  apiCatalogDisconnect,
  type CatalogAccount,
} from '../../api';
import { ConfirmDialog } from '../ui';
import { Button } from '../ui/Button';

/**
 * Where a person makes one of these. The only route to a token from in here.
 *
 * The catalog moved this page from `/dashboard/tokens` to `/settings/tokens`
 * and still answers the old address with a 308, so the stale link worked. It
 * is written out in full anyway: a link the app sends someone to should be the
 * address they end up at, or the day the redirect is retired this is the thing
 * that breaks, quietly, in an installed build nobody can patch.
 */
export const CATALOG_TOKENS_URL = 'https://catalog.hearthengine.com/settings/tokens';

/** What every catalog token starts with. */
export const TOKEN_PREFIX = 'hpub_';

/** How many hex characters follow the prefix. */
export const TOKEN_BODY_LENGTH = 40;

/**
 * What looks wrong with this token, or null when nothing does.
 *
 * Same contract and the same voice as `keyShapeProblem`: ordered by how likely
 * each one is to be what actually happened, and each sentence names the
 * mistake rather than the rule, because "must match /^hpub_[0-9a-f]{40}$/"
 * tells you what the checker wants and not what you did.
 *
 * SHAPE, NOT VALIDITY. Nothing here can tell a real token from a well-formed
 * fake; that takes a request to the catalog, which is what pressing Connect
 * does. This catches the paste that went wrong on the way in.
 */
export function catalogTokenProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return 'Paste a token first.';
  if (/\s/.test(value)) {
    return 'There is a space or a line break inside that, so something else came along with the paste.';
  }
  if (!value.startsWith(TOKEN_PREFIX)) {
    return `Catalog tokens begin with ${TOKEN_PREFIX} and this one does not, so it may not be the string you meant to copy.`;
  }
  const body = value.slice(TOKEN_PREFIX.length);
  if (body.length < TOKEN_BODY_LENGTH) {
    return 'That is shorter than a catalog token, so the paste probably lost its end.';
  }
  if (body.length > TOKEN_BODY_LENGTH) {
    return 'That is longer than a catalog token, so something came along with the paste.';
  }
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    return `A catalog token is ${TOKEN_BODY_LENGTH} hexadecimal characters after ${TOKEN_PREFIX}, and there is a character in this one that is not.`;
  }
  return null;
}

/** How the one read this pane makes went. */
export type AccountRead = 'reading' | 'ok' | 'failed';

/** The five looks this pane can have, in the order they are legible. */
export type CatalogState = 'reading' | 'unreadable' | 'stale' | 'connected' | 'disconnected';

/**
 * Which of the five, from what is actually known.
 *
 * The order of these branches is the whole behaviour of the pane, so it is one
 * function and it is tested directly. Two of them are load-bearing:
 *
 *   `unreadable` before anything else a null could be read as, because a null
 *   is a failed read and never an answer.
 *
 *   `stale` before `connected`, because a body may well carry both — a server
 *   that knows whose token it is and has just been told the catalog will not
 *   take it can honestly answer `connected: true` with an `error` beside it.
 *   Reading that as connected is how a pane ends up showing a green state to
 *   someone whose next publish is going to fail.
 */
export function catalogState(account: CatalogAccount | null, read: AccountRead): CatalogState {
  if (read === 'reading') return 'reading';
  if (account === null) return 'unreadable';
  if (typeof account.error === 'string' && account.error.trim() !== '') return 'stale';
  return account.connected ? 'connected' : 'disconnected';
}

/**
 * How this pane names the account, and it never invents one.
 *
 * `username` is nullable on the wire, so a server that stored a token without
 * resolving a name gets an honest "your catalog account" rather than "@null"
 * or a blank `@`.
 */
export function accountLabel(username: string | null | undefined): string {
  const name = typeof username === 'string' ? username.trim() : '';
  return name === '' ? 'your catalog account' : `@${name}`;
}

/**
 * A link out to the real web.
 *
 * A deliberate copy of AgentsPane's, down to the classes: that one is not
 * exported and this pane is not allowed to reach into it, and the two have to
 * look identical because they are the same affordance on adjacent screens. The
 * call is the app's one way of doing this — `setWindowOpenHandler` in
 * electron/main.ts denies anything that is not localhost and hands the rest to
 * `shell.openExternal`, so it lands in the user's own browser rather than in a
 * chrome-less window with no way back. An anchor rather than a button because
 * it is a link, and because hovering one should say where it goes.
 */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="set-agent-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
      <svg
        className="set-agent-link-mark"
        width="10"
        height="10"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.6 2.5h4.9v4.9" />
        <path d="M9.5 2.5 5.2 6.8" />
        <path d="M8.2 7.9v1.6H2.5V3.8h1.6" />
      </svg>
    </a>
  );
}

const FIELD_ID = 'set-catalog-token';
const PROBLEM_ID = 'set-catalog-token-problem';
const STATUS_ID = 'set-catalog-token-status';

// ---------------------------------------------------------------------------

export function PublishingPane() {
  const [account, setAccount] = useState<CatalogAccount | null>(null);
  const [read, setRead] = useState<AccountRead>('reading');
  const [draft, setDraft] = useState('');
  // What looks wrong with the token in the box, and whether the user has been
  // told once already. The second press is what sends it anyway.
  const [problem, setProblem] = useState<string | null>(null);
  // The catalog's own words for a refusal. Kept apart from `problem` because
  // they are different claims: one is "this does not look like a token", the
  // other is "the catalog would not take this one", and only the second is a
  // failure. They render in different colours for that reason.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);

  // A read that lands after the pane is gone must not set state, and a slow
  // read overtaken by a newer one must not be the answer of record.
  const alive = useRef(true);
  const reads = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const ticket = ++reads.current;
    setRead('reading');
    const next = await apiCatalogAccount();
    if (!alive.current || ticket !== reads.current) return;
    setAccount(next);
    // A null is a failed read, never an answer. See the header.
    setRead(next === null ? 'failed' : 'ok');
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const state = catalogState(account, read);

  /**
   * Send the pasted token, once it has been looked at.
   *
   * The shape check runs first and costs no request, so an obvious typo is
   * answered here rather than after a round trip. It does not block: editing
   * the field withdraws the warning, and a second press on the same string
   * sends it, because Hearth does not get to tell its user that a string it
   * did not recognise is not their token.
   */
  const connect = useCallback(async (): Promise<void> => {
    const value = draft.trim();
    if (value === '') return;
    const shape = catalogTokenProblem(value);
    if (shape !== null && problem === null) {
      setProblem(shape);
      setRefusal(null);
      return;
    }
    setProblem(null);
    setRefusal(null);
    setBusy('connect');
    try {
      const result = await apiCatalogConnect(value);
      if (!alive.current) return;
      if (!result.ok) {
        // The catalog's own sentence, shown as it was written. It is the only
        // thing on screen that knows why this token was refused, and replacing
        // it with a house sentence would throw that away.
        setRefusal(result.error ?? 'The catalog would not accept that token.');
        return;
      }
      // Nothing is kept in this component's head. The token is gone from the
      // field the moment it is accepted, and the pane re-reads the truth
      // rather than drawing what it hoped just happened.
      setDraft('');
      await load();
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [draft, load, problem]);

  const disconnect = useCallback(async (): Promise<void> => {
    setBusy('disconnect');
    setRefusal(null);
    try {
      const result = await apiCatalogDisconnect();
      if (!alive.current) return;
      if (!result.ok) {
        setRefusal(result.error ?? 'Could not remove the token from this machine.');
        return;
      }
      setDraft('');
      setProblem(null);
      await load();
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [load]);

  const connecting = busy === 'connect';
  const removing = busy === 'disconnect';
  // The field is the whole of the action in both of these, so it is open on
  // arrival rather than behind a disclosure: there is one thing to do here and
  // making someone press a button to reveal it is a step that buys nothing.
  const wantsToken = state === 'disconnected' || state === 'stale';
  const instance = typeof account?.api === 'string' ? account.api.trim() : '';

  const field = (
    <form
      className="set-agent-connect"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <label className="set-agent-field-label" htmlFor={FIELD_ID}>
        Catalog token
      </label>
      <div className="set-agent-field-row">
        <input
          id={FIELD_ID}
          className="input mono set-agent-input"
          // A secret, and treated as one: masked, offered to no password
          // manager, never spell-checked into a suggestion list, and never
          // written anywhere but the request that stores it.
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          placeholder={`${TOKEN_PREFIX}…`}
          disabled={connecting}
          aria-invalid={problem !== null || refusal !== null}
          aria-describedby={
            problem !== null ? PROBLEM_ID : refusal !== null ? STATUS_ID : undefined
          }
          onChange={(e) => {
            setDraft(e.target.value);
            // Editing withdraws both notes, so the next press gets a fresh
            // look rather than sending a second wrong paste on the strength of
            // having been told about the first.
            setProblem(null);
            setRefusal(null);
          }}
        />
        <Button type="submit" variant="primary" disabled={connecting || draft.trim() === ''}>
          {connecting
            ? 'Connecting…'
            : problem !== null
              ? 'Connect anyway'
              : state === 'stale'
                ? 'Reconnect'
                : 'Connect'}
        </Button>
      </div>
      {problem !== null && (
        <p className="set-agent-problem" id={PROBLEM_ID} role="alert">
          {problem}
        </p>
      )}
    </form>
  );

  return (
    <>
      <h2 className="set-pane-title">Publishing</h2>
      <p className="set-pane-lead">
        Publishing puts the open game on the Hearth Catalog, at a web address you can send to anyone. It needs an
        account, and this is where you connect one.
      </p>

      <section className="set-agent-start">
        {state === 'reading' && (
          <>
            <h3 className="set-agent-start-title">Checking this machine</h3>
            <p className="set-agent-start-body">
              Hearth is looking for a catalog token. Whatever it finds lands here.
            </p>
          </>
        )}

        {/* The read did not come back. Said as exactly that, because the
            alternative — rendering a failed read as "no account" — is the one
            mistake that sends someone off to create a token they already have. */}
        {state === 'unreadable' && (
          <>
            <h3 className="set-agent-start-title">Hearth could not check for a token</h3>
            <p className="set-agent-start-body">
              That check did not come back, so Hearth cannot say whether an account is connected here. Nothing has been
              disconnected and nothing on this machine has changed. Asking again is safe.
            </p>
            <div className="set-agent-start-actions">
              <Button variant="primary" onClick={() => void load()}>
                Check again
              </Button>
            </div>
          </>
        )}

        {state === 'disconnected' && (
          <>
            <h3 className="set-agent-start-title">Connect your catalog account</h3>
            <p className="set-agent-start-body">
              A catalog token is what proves a publish is yours, so the game lands on your account rather than
              anywhere else.
            </p>
            {field}
          </>
        )}

        {/* THE STATE THIS PANE EXISTS TO GET RIGHT. A token is stored and the
            catalog is refusing it, which every other surface will discover at
            the end of an upload. It says so in those words, in the catalog's
            own sentence, and puts the field that fixes it directly underneath
            — rather than sitting here claiming to be connected. */}
        {state === 'stale' && (
          <>
            <h3 className="set-agent-start-title">This connection is no longer working</h3>
            <p className="set-agent-start-body">
              A token is stored on this machine{account?.username ? ` for ${accountLabel(account.username)}` : ''}, and
              the catalog is no longer accepting it. Publishing will fail until you connect a new one. Nothing has been
              deleted and nothing you have already published is affected.
            </p>
            <p className="set-status" role="alert">
              {account?.error}
            </p>
            {field}
            <div className="set-agent-manage">
              <Button size="sm" variant="danger" disabled={removing} onClick={() => setConfirming(true)}>
                {removing ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </>
        )}

        {state === 'connected' && (
          <>
            <h3 className="set-agent-start-title">Connected as {accountLabel(account?.username)}</h3>
            <p className="set-agent-start-body">
              Publishing sends the open game to this account
              {instance !== '' ? (
                <>
                  {' '}
                  on <span className="mono">{instance}</span>
                </>
              ) : null}
              . The token is stored on this machine and Hearth cannot show it again.
            </p>
            <div className="set-agent-manage">
              <Button size="sm" variant="danger" disabled={removing} onClick={() => setConfirming(true)}>
                {removing ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </>
        )}

        {/* The catalog's own words for a refusal, on the pane's last action
            rather than on any one field. Err-coloured, unlike the shape
            warning above it: this one is something that actually failed. */}
        {refusal !== null && (
          <p className="set-status" id={STATUS_ID} role="alert">
            {refusal}
          </p>
        )}

        {wantsToken && (
          <p className="set-agent-start-note">
            No token yet? <ExternalLink href={CATALOG_TOKENS_URL}>Create one on the catalog</ExternalLink>. It opens in
            your browser, and the token is shown once.
          </p>
        )}
      </section>

      <p className="set-agent-foot">
        The token is stored in <span className="mono">~/.hearth/</span>, for you rather than for one project, and is
        never read back into this pane. Choosing what to publish, and where it goes, happens in the publish dialog.
      </p>

      <ConfirmDialog
        open={confirming}
        title="Disconnect the catalog account?"
        body="The token is deleted from this machine. Hearth cannot show it again and cannot get it back, so connecting again means creating a new token on the catalog. Games you have already published stay where they are."
        confirmLabel="Disconnect"
        danger
        onConfirm={() => {
          setConfirming(false);
          void disconnect();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
