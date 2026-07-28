/**
 * The one input the app really has.
 *
 * A single card: what you type on top, everything that qualifies it along the
 * bottom — the + menu on the left, who answers and the send button on the
 * right. The same card appears on Home (where sending creates the folder) and
 * docked under the transcript (where sending continues the conversation);
 * mounting it twice with a different submit is cheaper, and reads better, than
 * two boxes that drift apart.
 *
 * Enter sends and Shift+Enter breaks the line, which is what every other chat
 * app in the world does. ⌘↵ keeps working for the people who learned it here.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import { Tooltip } from '../ui/Tooltip';
import { Icon } from '../ui';
import { MenuButton } from '../ui/Menu';
import { ModelSelector } from './ModelSelector';
import { PermissionSelector } from './PermissionSelector';
import { AttachmentTray } from './AttachmentTray';
import { ProjectSelector } from '../../projects/ProjectSelector';
import { ToastHost } from '../ui/Toast';
import {
  attachmentRejection,
  filesFromTransfer,
  readAttachment,
  releaseAttachments,
  type PendingAttachment,
} from '../../chat/attachments';

/** Ceiling for the autosizing textarea, in px — past this it scrolls. */
export const COMPOSER_MAX_PX = 200;

/** Where the composer is mounted, which is the only thing that differs. */
export type ComposerVariant = 'chat' | 'home' | 'project';

/**
 * Why the composer can't send right now, or null when it can. Pure, so the
 * disabled contract is unit-testable without a DOM: the composer must never
 * be disabled without a visible reason.
 *
 * A running turn is deliberately NOT a reason. It shows as a live line in the
 * transcript (see WorkingRow) where the reader is already looking, and the
 * Stop button next to this note is its own explanation — a caption reading
 * "press Stop to interrupt" beside a Stop button was the app narrating itself.
 */
export function composerBlockReason(opts: { connected: boolean }): string | null {
  return opts.connected ? null : 'Reconnecting…';
}

/**
 * What a keypress in the textarea means. `null` is "not ours" — let the
 * browser do whatever it was going to do, including finishing an IME
 * composition, where an Enter that submits eats the candidate the user was
 * choosing.
 */
export function composerKeyAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): 'send' | 'newline' | null {
  if (event.key !== 'Enter') return null;
  if (event.isComposing) return null;
  if (event.metaKey || event.ctrlKey) return 'send';
  if (event.shiftKey || event.altKey) return 'newline';
  return 'send';
}

/**
 * The send glyph: an arrow going up, the way the message goes. Local to the
 * composer rather than in the shared 12px icon set — this is one 14px mark on
 * one button, and the set is a vocabulary for toolbars.
 */
function ArrowUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 11.5V3M3.2 6.8L7 3l3.8 3.8" />
    </svg>
  );
}

const PLACEHOLDER: Record<ComposerVariant, string> = {
  chat: 'Describe the game you want',
  home: 'What are we making?',
  project: 'Write a message…',
};

/**
 * A paste only means "attach this" when it carries real files. Pasting text
 * that a page happened to expose as an item must go into the textarea, which
 * is what everyone expects and what makes this safe to bind unconditionally.
 */
export function pasteCarriesFiles(data: DataTransfer | null): boolean {
  return filesFromTransfer(data).length > 0;
}

export function Composer({ variant = 'chat' }: { variant?: ComposerVariant } = {}) {
  const sendChat = useApp((s) => s.sendChat);
  // Stop interrupts the TURN and keeps the conversation's agent alive, so the
  // next message continues with everything it already knows — pressing Stop
  // must not cost the user the session they were in the middle of.
  const interruptChat = useApp((s) => s.interruptChat);
  const chatBusy = useApp((s) => s.chatBusy);
  const connected = useApp((s) => s.wsStatus === 'connected');
  const consumePendingPrompt = useApp((s) => s.consumePendingPrompt);
  const [text, setText] = useState('');
  // Home's submit is a round trip (create the folder, open it, then send), and
  // it must not be startable twice from one impatient double-press.
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  // The tray, readable synchronously — see addFiles.
  const trayRef = useRef<readonly PendingAttachment[]>(attachments);
  trayRef.current = attachments;
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Both blank surfaces start a conversation rather than continuing one, so
  // they share the submit path. They differ only in whether the project is
  // still a question: on a project's own screen it is already answered.
  const isHome = variant === 'home' || variant === 'project';
  const picksProject = variant === 'home';

  // Six files dropped at once are six decisions, and they all have to be made
  // against the same running count. Reading it through a functional setState
  // looked like it did that and did not: React only runs the updater eagerly
  // while no update is pending, so from the SECOND file on the check silently
  // passed — both the count cap and the size cap. The tray is mirrored in a
  // ref, which is true synchronously, and the whole batch is judged before any
  // of it is read.
  const addFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      const accepted: File[] = [];
      let count = trayRef.current.length;
      let bytes = trayRef.current.reduce((sum, attachment) => sum + attachment.bytes, 0);
      for (const file of files) {
        const rejection = attachmentRejection(file, count, bytes);
        if (rejection) {
          useApp.getState().log('warn', 'app', rejection);
          continue;
        }
        accepted.push(file);
        count += 1;
        bytes += file.size;
      }
      for (const file of accepted) {
        try {
          const attachment = await readAttachment(file);
          setAttachments((current) => [...current, attachment]);
        } catch {
          useApp.getState().log('error', 'app', `Could not read ${file.name}.`);
        }
      }
    },
    [],
  );

  const removeAttachment = useCallback((id: string): void => {
    setAttachments((current) => {
      releaseAttachments(current.filter((attachment) => attachment.id === id));
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  // The tray holds object URLs, and only the tray does — what goes into a sent
  // message is a data URL (see sendChat), so these can be released the moment
  // the tray lets go of them without ever breaking a picture on screen.
  useEffect(() => () => releaseAttachments(trayRef.current), []);

  // A prompt handed over by another surface lands here, focused and ready to
  // edit — never sent behind the user's back.
  useEffect(() => {
    const pending = consumePendingPrompt();
    if (pending) setText(pending);
    ref.current?.focus();
  }, [consumePendingPrompt]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure from scratch, then adopt the content height up to the ceiling.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [text]);

  // Home talks to the workspace endpoint over HTTP, not the chat socket, so a
  // disconnected socket is not a reason to stop someone starting a project.
  const busy = isHome ? starting : chatBusy;
  // An attachment is content: a picture with no words is a message, so the
  // empty box stops being a reason not to send once something is in the tray.
  const empty = text.trim() === '' && attachments.length === 0;
  const blocked = isHome ? null : composerBlockReason({ connected });
  // A running turn no longer blocks the box. What you type goes into the queue
  // and leaves the moment the turn is over (see store.drainQueue), which is
  // what every chat app people already use does — the alternative loses the
  // thought at exactly the moment someone has it.
  const canSend = (isHome || connected) && !empty && (isHome ? !busy : true);
  /** A turn is running, so the next Enter queues rather than sends. */
  const queueing = busy && !isHome;

  function send(): void {
    if (!canSend) return;
    const value = text;
    const files = attachments;
    if (!isHome) {
      setText('');
      setAttachments([]);
      sendChat(value, files);
      releaseAttachments(files);
      return;
    }
    setStarting(true);
    // The prompt stays in the box until it is known to have gone somewhere: if
    // creating the folder fails, losing what was typed is the worst outcome.
    void Promise.resolve(useApp.getState().startFromHome(value, files))
      .then((result) => {
        if (result?.ok) {
          setText('');
          setAttachments([]);
          releaseAttachments(files);
        }
      })
      .finally(() => setStarting(false));
  }

  return (
    <div className={`composer composer-${variant}`}>
      {/* Anything the app has to tell you about a send appears here, directly
          over the box you sent from. */}
      <ToastHost />
      <div
        className={dropping ? 'composer-card is-dropping' : 'composer-card'}
        onDragOver={(e) => {
          if (!pasteCarriesFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          // Only the card leaving counts; crossing into the textarea inside it
          // fires dragleave too, and would make the highlight flicker.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropping(false);
        }}
        onDrop={(e) => {
          const files = filesFromTransfer(e.dataTransfer);
          setDropping(false);
          if (files.length === 0) return;
          e.preventDefault();
          void addFiles(files);
        }}
      >
        {/* Off-screen rather than display:none — a hidden input can still be
            opened by .click(), and this one is the + menu's file picker. */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="composer-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void addFiles(files);
          }}
        />
        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[variant]}
          aria-label="Message the agent"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = filesFromTransfer(e.clipboardData);
            if (files.length === 0) return; // plain text: let it type itself
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            const action = composerKeyAction({
              key: e.key,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              isComposing: e.nativeEvent.isComposing,
            });
            if (action === 'send') {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-row">
          <MenuButton
            label="Add context"
            align="left"
            triggerClassName="composer-plus"
            popoverClassName="composer-menu"
            trigger={<Icon name="plus" />}
            items={[
              {
                label: 'Add photos & files…',
                icon: 'image',
                onSelect: () => fileRef.current?.click(),
              },
              {
                label: 'Open a project…',
                icon: 'folder',
                // The sidebar owns the native picker; this is the one surface
                // that needs it without owning it.
                onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-folder')),
              },
              {
                label: 'Settings…',
                icon: 'gear',
                onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-settings')),
              },
            ]}
          />
          {/* A quiet status line, not a control: shown only when there is
              actually something in the way. */}
          {/* Where this message lands, chosen the same way the model is: on
              the turn, before it goes. Only on the blank surface — inside a
              conversation the answer is already settled. */}
          {picksProject && <ProjectSelector />}
          {blocked ? <span className="composer-note">{blocked}</span> : <span className="composer-row-gap" />}
          {/* What the agent may do without asking, and who answers. In that
              order, left to right: the model pill keeps the place beside Send
              it has always had, and the new one arrives beside it rather than
              under the reader's pointer. */}
          <PermissionSelector />
          <ModelSelector />
          {/* Stop belongs to the running turn and stays reachable while one is
              running. Send appears beside it the moment there is something to
              send — two circles only when both actually mean something. */}
          {queueing && (
            <Tooltip content="Stop">
              <button type="button" className="composer-send is-stop" aria-label="Stop" onClick={interruptChat}>
                <Icon name="stop" size={9} />
              </button>
            </Tooltip>
          )}
          {(!queueing || !empty) && (
            <Tooltip content={queueing ? 'Send when this turn finishes' : 'Send'} shortcut="↵">
              <button
                type="button"
                className="composer-send"
                aria-label={queueing ? 'Send when this turn finishes' : 'Send'}
                disabled={!canSend}
                onClick={send}
              >
                <ArrowUp />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
