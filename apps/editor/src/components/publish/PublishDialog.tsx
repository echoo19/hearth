/**
 * Putting the open game on the catalog — and, the second time, putting it
 * there AGAIN rather than beside itself.
 *
 * The whole shape of this dialog comes from three refusals.
 *
 * **It refuses to guess what is in the folder.** Everything above the form is
 * read from the server (`apiCatalogProject`) and shown as read: the entry
 * page, the file count, the total size. Publishing is one of the few actions
 * in this app that a person cannot undo by pressing something else, so what
 * would be sent is stated before it is sent, not summarised afterwards.
 *
 * **It refuses to pretend it knows more than it does.** There are four
 * different answers to "can this folder be published", and they are four
 * different screens, because collapsing them is how a tool starts lying:
 *   - we have not read the folder yet          → say that, show nothing else
 *   - we could not read it                     → say that, offer another go
 *   - we read it and there is no game in it    → say that, offer nothing
 *   - there is a game                          → the form
 * The one that matters most is the second against the third. While the server
 * is unfinished every request comes back 501, and `getJson` turns that into
 * `null` — the same `null` a missing folder would produce. Rendering that as
 * "there is nothing to publish" would be the app inventing a fact about
 * someone's game out of its own broken plumbing.
 *
 * **It refuses to lose what was typed.** The draft lives outside this
 * component (publishDraft.ts) because `Modal` unmounts its children on close,
 * and a failed publish leaves every field exactly as it was — the error is
 * new information about the attempt, not a reason to throw away the listing.
 *
 * ---
 *
 * On the layout, which is load-bearing rather than cosmetic: the body
 * scrolls and the action row does not. This app has shipped the bug before
 * where an error line appears under a field, the layout below it shifts, and
 * the click already travelling toward the submit button lands on a div
 * instead. Two defences, and both are needed. Structurally, nothing that
 * appears inside `.publish-body` can move `.modal-actions`, because the body
 * is a separate scroll container. Locally, the title's error line occupies its
 * space whether or not it has anything to say, so even inside the body nothing
 * reflows — and the error clears as soon as typing fixes it, rather than on
 * blur, so the text never disappears out from under a pointer.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  apiCatalogAccount,
  apiCatalogProject,
  apiCatalogPublish,
  type CatalogAccount,
  type CatalogProjectInfo,
  type PublishResult,
} from '../../api';
import { useApp } from '../../store';
import { showToast } from '../../toast';
import { Modal } from '../ui';
import { Button } from '../ui/Button';
import { OPEN_SETTINGS_EVENT } from '../shell/SettingsDialog';
import { CopyableUrl } from './CopyableUrl';
import { CoverField } from './CoverField';
import { TagField } from './TagField';
import {
  addTag,
  draftForProject,
  draftToRequest,
  emptyDraft,
  formatBytes,
  formatFileCount,
  isUpdate as draftIsUpdate,
  rememberDraft,
  titleProblem,
  type PublishDraft,
} from './publishDraft';

/**
 * Which settings pane owns the token. Another surface entirely — this dialog
 * deliberately has no token field, because a credential typed into a publish
 * form is a credential typed once per game.
 */
const PUBLISHING_PANE = 'publishing';

/** What is known about the folder. Three answers, never conflated. */
type InfoState =
  | { kind: 'loading' }
  | { kind: 'ready'; info: CatalogProjectInfo }
  | { kind: 'unreadable' };

/**
 * What is known about the token. `unknown` is not `absent`: one is "there is
 * no token", the other is "we could not ask", and only the first is something
 * to send someone to Settings about.
 */
type AccountState =
  | { kind: 'loading' }
  | { kind: 'connected'; username: string | null }
  | { kind: 'absent'; reason: string | null }
  | { kind: 'unknown' };

function readAccount(account: CatalogAccount | null): AccountState {
  if (account === null) return { kind: 'unknown' };
  // A stored token the catalog no longer accepts is not a connection. The
  // server's own sentence carries, because it knows why and this does not.
  if (account.error != null && account.error !== '') {
    return { kind: 'absent', reason: account.error };
  }
  if (!account.connected) return { kind: 'absent', reason: null };
  return { kind: 'connected', username: account.username };
}

export function PublishDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useApp((s) => s.projectPath);

  const [infoState, setInfoState] = useState<InfoState>({ kind: 'loading' });
  const [accountState, setAccountState] = useState<AccountState>({ kind: 'loading' });
  const [draft, setDraft] = useState<PublishDraft>(emptyDraft);
  const [phase, setPhase] = useState<'idle' | 'publishing' | 'done'>('idle');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether Publish has been pressed. The title's complaint waits for this:
  // a form that goes red before it has been answered is scolding someone for
  // not having finished typing yet.
  const [attempted, setAttempted] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  // The draft is only written back once it has been seeded from the server's
  // suggested title. Without this the blank first render would be stored as a
  // draft, and the suggestion would then lose to it forever.
  const seeded = useRef(false);
  // Which folder the in-flight publish belongs to, so a reply that lands after
  // the person switched projects cannot report itself against the new one.
  const inFlight = useRef<string | null>(null);
  // Whether the dialog is still up when a publish lands. If it isn't, the
  // address has to reach the person some other way.
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const info = infoState.kind === 'ready' ? infoState.info : null;
  const isUpdate = draftIsUpdate(info);

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!open || project === null) return;
    let live = true;
    seeded.current = false;
    setInfoState({ kind: 'loading' });
    setAccountState({ kind: 'loading' });
    setPhase('idle');
    setResult(null);
    setError(null);
    setAttempted(false);
    // The stored draft, if there is one. Seeding from the folder's suggested
    // title happens below, once the server has said what it is.
    setDraft(draftForProject(project, null));

    void apiCatalogProject(project).then((next) => {
      if (!live) return;
      if (next === null) {
        setInfoState({ kind: 'unreadable' });
        return;
      }
      setInfoState({ kind: 'ready', info: next });
      // Safe in either order: a stored draft wins over the suggestion, so a
      // title typed while this request was still out is not overwritten by it.
      setDraft(draftForProject(project, next));
      seeded.current = true;
    });

    void apiCatalogAccount().then((account) => {
      if (!live) return;
      setAccountState(readAccount(account));
    });

    return () => {
      live = false;
    };
  }, [open, project]);

  // Keep every keystroke, for as long as the app is running.
  useEffect(() => {
    if (!seeded.current || project === null) return;
    rememberDraft(project, draft);
  }, [draft, project]);

  // The form's first field gets the caret. Effects run child-first, so Modal
  // has already called showModal() (which focuses the first focusable itself)
  // by the time this lands — this wins by going last, exactly as
  // NewProjectDialog does.
  useEffect(() => {
    if (!open || phase !== 'idle') return;
    if (infoState.kind !== 'ready' || infoState.info.entry === null) return;
    if (accountState.kind === 'absent' || accountState.kind === 'loading') return;
    titleRef.current?.focus();
  }, [open, phase, infoState, accountState]);

  // A result is the answer to the thing that was pressed, so the reader is
  // moved to it rather than left on a button that is no longer there.
  useEffect(() => {
    if (phase === 'done') doneRef.current?.focus();
  }, [phase]);

  /**
   * Put the body back to the top so a banner that was just added is actually
   * on screen. `scrollTop` rather than `scrollTo`, which is not implemented
   * everywhere this renders — and a missing scroll must never be what takes
   * a publish down.
   */
  function scrollBodyToTop(): void {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0;
  }

  function edit(patch: Partial<PublishDraft>): void {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  async function submit(): Promise<void> {
    if (project === null || info === null || phase === 'publishing') return;
    setAttempted(true);
    if (titleProblem(draft.title) !== null) {
      // Send the caret to the thing that is wrong. A complaint about a field
      // three scrolls up is a complaint nobody can act on.
      titleRef.current?.focus();
      scrollBodyToTop();
      return;
    }

    const request = draftToRequest(project, draft);
    // `draftToRequest` commits the half-typed tag; the form is brought level
    // with it so that a failure returns to a form showing what was actually
    // sent, rather than to one still holding an uncommitted word.
    const committed = addTag(draft.tags, draft.tagText);
    if (committed.length !== draft.tags.length || draft.tagText !== '') {
      edit({ tags: committed, tagText: '' });
    }

    inFlight.current = project;
    setPhase('publishing');
    setError(null);

    // Cannot reject: apiCatalogPublish answers an unreachable server as
    // `ok: false` with the reason in words, like every other POST here.
    const answer = await apiCatalogPublish(request);
    if (inFlight.current !== project) return; // the folder changed underneath
    inFlight.current = null;

    if (!answer.ok || !answer.result) {
      setPhase('idle');
      // The server's own sentence wins. Today that is "Publishing is not
      // wired up yet." — which is exactly what a real refusal will look like,
      // and it belongs on screen either way.
      setError(answer.error ?? 'The catalog did not accept the game, and did not say why.');
      // The banner is at the top of the body, which may be scrolled away from.
      scrollBodyToTop();
      return;
    }

    setResult(answer.result);
    setPhase('done');
    // The draft is deliberately KEPT. The next publish from this folder is an
    // update to this listing, and starting it from the folder name again would
    // quietly rename a game that already has a name.
    if (!openRef.current) {
      // Nobody is looking at the dialog. The address is the entire product of
      // this action, so it goes where it will be seen.
      showToast(
        isUpdate ? 'Your listing was updated.' : 'Your game is on the catalog.',
        'info',
        {
          label: 'Copy link',
          run: () => {
            void navigator.clipboard?.writeText(answer.result!.url);
          },
        },
      );
    }
  }

  function openPublishingSettings(): void {
    // The pane belongs to Settings, not here. This dialog gets out of the way
    // first so the two are not stacked on each other.
    onClose();
    window.dispatchEvent(
      new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { pane: PUBLISHING_PANE } }),
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const busy = phase === 'publishing';
  const titleError = attempted ? titleProblem(draft.title) : null;

  function modalTitle(): string {
    if (phase === 'done') return isUpdate ? 'Listing updated' : 'Published to the catalog';
    return isUpdate ? 'Update your listing' : 'Publish to the catalog';
  }

  return (
    <Modal open={open} title={modalTitle()} className="is-publish" onClose={onClose}>
      <form
        className="publish-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="publish-body" ref={bodyRef}>
          {renderBody()}
        </div>
        <div className="modal-actions">{renderActions()}</div>
      </form>
    </Modal>
  );

  function renderBody(): React.ReactNode {
    if (project === null) {
      return <p>Open a folder first. Publishing sends a game, and there isn't one open.</p>;
    }

    if (phase === 'done' && result !== null) {
      return (
        <div className="publish-done" ref={doneRef} tabIndex={-1}>
          <p className="publish-done-lead">
            {isUpdate
              ? 'The listing now has this build. The address has not changed.'
              : 'Your game is live. Anyone with this address can play it.'}
          </p>
          <CopyableUrl url={result.url} />
          <dl className="publish-manifest">
            <div>
              <dt>Sent</dt>
              <dd>{formatFileCount(result.fileCount)}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(result.totalBytes)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{result.status === 'draft' ? 'Draft, not listed publicly' : 'Published'}</dd>
            </div>
          </dl>
        </div>
      );
    }

    if (infoState.kind === 'loading') {
      return (
        <div className="publish-skeleton" role="status" aria-label="Reading the folder">
          <span className="publish-skeleton-line" />
          <span className="publish-skeleton-line is-short" />
        </div>
      );
    }

    if (infoState.kind === 'unreadable') {
      // NOT "there is nothing to publish". We do not know that.
      return (
        <div className="publish-state">
          <p role="alert">Hearth could not read what this folder would publish.</p>
          <p className="publish-note">
            The app server answered with an error rather than a list of files, so nothing has been sent and nothing has
            changed. Trying again is safe.
          </p>
        </div>
      );
    }

    const ready = infoState.info;

    if (ready.entry === null) {
      // There is genuinely no game. Say so, and offer nothing — a form here
      // would be asking someone to describe a listing that cannot exist.
      return (
        <div className="publish-state">
          <p>There is no game in this folder to publish yet.</p>
          <p className="publish-note">
            The catalog needs an HTML page to open the game with, and this folder does not have one. Ask the agent for a
            playable page, and this will show what would go out.
          </p>
        </div>
      );
    }

    return (
      <>
        {error !== null && (
          <p className="publish-error" role="alert">
            {error}
          </p>
        )}

        {renderManifest(ready)}

        {accountState.kind === 'absent' ? renderNoToken() : renderForm(ready)}
      </>
    );
  }

  /** What would be sent. Stated before it is sent, never after. */
  function renderManifest(ready: CatalogProjectInfo): React.ReactNode {
    return (
      <section className="publish-manifest-block">
        <dl className="publish-manifest">
          <div>
            <dt>Opens</dt>
            <dd className="is-path">{ready.entry}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{formatFileCount(ready.fileCount)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(ready.totalBytes)}</dd>
          </div>
        </dl>
        {ready.published !== null && (
          <div className="publish-existing">
            {/* The single most important sentence in the dialog. Publishing a
                second time without saying this is how someone ends up with
                their game listed twice, the second one at `my-game-2`. */}
            <p className="publish-existing-lead">
              This folder is already on the catalog. Publishing again replaces that listing. It does not make a second
              one.
            </p>
            <CopyableUrl url={ready.published.url} label="Currently at" />
          </div>
        )}
      </section>
    );
  }

  /** No token stored. This dialog does not collect one; Settings does. */
  function renderNoToken(): React.ReactNode {
    const reason = accountState.kind === 'absent' ? accountState.reason : null;
    return (
      <div className="publish-state">
        <p>
          {reason === null
            ? 'Publishing needs a catalog token, and this machine does not have one.'
            : `The catalog token stored on this machine is not working: ${reason}`}
        </p>
        <p className="publish-note">
          The token belongs to you rather than to this game, so it lives in Settings and you only add it once. Nothing
          here has been sent, and this listing is kept while you go.
        </p>
      </div>
    );
  }

  function renderForm(ready: CatalogProjectInfo): React.ReactNode {
    if (busy) {
      return (
        <div className="publish-progress" role="status">
          <div className="publish-bar" aria-hidden="true">
            <span />
          </div>
          <p className="publish-progress-lead">
            {isUpdate ? 'Updating the listing' : 'Publishing'}: sending {formatFileCount(ready.fileCount)} (
            {formatBytes(ready.totalBytes)}).
          </p>
          {/* No percentage. The upload reports nothing back until it is done,
              and a bar that invented a number would be the app claiming to
              know something it does not. */}
          <p className="publish-note">
            A large folder can take a moment. Nothing is listed until this finishes, and the address appears here when
            it does.
          </p>
        </div>
      );
    }

    return (
      <div className="publish-fields">
        {accountState.kind === 'connected' && accountState.username !== null && (
          <p className="publish-note publish-as">Publishing as {accountState.username}.</p>
        )}
        {accountState.kind === 'unknown' && (
          // Not "you are not connected" — we could not ask. If there really is
          // no token the publish will refuse, and it will say so in the
          // catalog's own words rather than in a guess made here.
          <p className="publish-note publish-as">
            Hearth could not check whether a catalog token is stored. If there isn't one, publishing will say so.
          </p>
        )}

        <div className="form-field">
          <label className="field-label" htmlFor="publish-title">
            Title
          </label>
          <input
            ref={titleRef}
            id="publish-title"
            className={titleError !== null ? 'input invalid' : 'input'}
            value={draft.title}
            placeholder="Lighthouse Keeper"
            autoComplete="off"
            aria-invalid={titleError !== null}
            aria-describedby="publish-title-error"
            // The error is derived from the value, so it clears on the
            // keystroke that fixes it. Nothing waits for blur, and nothing
            // waits for a second press of the button.
            onChange={(e) => edit({ title: e.target.value })}
          />
          {/* Always in the DOM, always the same height. This is the line that
              used to appear and disappear under the pointer and take the
              submit button with it. */}
          <p className="publish-field-error" id="publish-title-error" role="alert">
            {titleError ?? ''}
          </p>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="publish-tagline">
            Tagline
          </label>
          <input
            id="publish-tagline"
            className="input"
            value={draft.tagline}
            placeholder="Keep the light burning through the storm."
            autoComplete="off"
            onChange={(e) => edit({ tagline: e.target.value })}
          />
          <p className="publish-note">One line, shown under the title on the catalog.</p>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="publish-description">
            Description
          </label>
          <textarea
            id="publish-description"
            className="textarea publish-textarea"
            value={draft.description}
            rows={4}
            placeholder="What the game is, and what makes it worth a few minutes."
            onChange={(e) => edit({ description: e.target.value })}
          />
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="publish-instructions">
            How to play
          </label>
          <textarea
            id="publish-instructions"
            className="textarea publish-textarea is-short"
            value={draft.instructions}
            rows={3}
            placeholder="Arrow keys to move, space to light the lamp."
            onChange={(e) => edit({ instructions: e.target.value })}
          />
          <p className="publish-note">Controls, and anything that is not obvious in the first ten seconds.</p>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="publish-tags">
            Tags
          </label>
          <TagField
            id="publish-tags"
            tags={draft.tags}
            text={draft.tagText}
            onTags={(tags) => edit({ tags })}
            onText={(tagText) => edit({ tagText })}
          />
          <p className="publish-note">Enter or comma adds one. Backspace on an empty field takes the last one back.</p>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="publish-cover">
            Cover image
          </label>
          <CoverField
            id="publish-cover"
            project={project ?? ''}
            value={draft.coverPath}
            onChange={(coverPath) => edit({ coverPath })}
          />
        </div>
      </div>
    );
  }

  function renderActions(): React.ReactNode {
    if (phase === 'done') {
      return (
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      );
    }

    if (project === null || infoState.kind === 'loading') {
      return <Button onClick={onClose}>Cancel</Button>;
    }

    if (infoState.kind === 'unreadable') {
      return (
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            onClick={() => {
              // Re-running the load effect: the cheapest honest retry is to
              // put the state back to where the effect starts from.
              setInfoState({ kind: 'loading' });
              void apiCatalogProject(project).then((next) => {
                setInfoState(next === null ? { kind: 'unreadable' } : { kind: 'ready', info: next });
                if (next !== null) {
                  setDraft(draftForProject(project, next));
                  seeded.current = true;
                }
              });
            }}
          >
            Try again
          </Button>
        </>
      );
    }

    if (infoState.info.entry === null) {
      // Nothing to press but the way out. Offering a disabled Publish here
      // would be a dead end with a button on it.
      return <Button onClick={onClose}>Close</Button>;
    }

    if (accountState.kind === 'absent') {
      return (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={openPublishingSettings}>
            Open Settings → Publishing
          </Button>
        </>
      );
    }

    return (
      <>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {/* Never disabled for an empty title. A button that goes dead without
            saying why is a worse answer than one that tells you what is
            missing and puts the caret there. Disabled only while the upload
            is genuinely in flight. */}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy
            ? isUpdate
              ? 'Updating…'
              : 'Publishing…'
            : isUpdate
              ? 'Update listing'
              : 'Publish'}
        </Button>
      </>
    );
  }
}
