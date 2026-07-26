/**
 * Connectors and Skills, in the rail.
 *
 * Two folds under Projects that answer "what can this Hearth reach, and what
 * does it know how to do?". They are real slots, not decoration: a folder can
 * register a connector or a skill today and the app can grow into consuming it
 * later. That is exactly why the copy never oversells — a row you add says it
 * was saved and that nothing runs it yet, because the alternative (a row that
 * looks live and isn't) is the one thing a registry must never do.
 *
 * Quiet by construction, like the rest of the rail: no badges, no counts, no
 * icons per row. State is one small mark at the end of the row — an ember dot
 * for the things that are genuinely wired up, a neutral ring for the things
 * merely registered, the word "soon" for the things that don't exist yet.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/ui';
import { MenuButton } from '../components/ui/Menu';
import { Tooltip } from '../components/ui/Tooltip';
import {
  readSectionOpen,
  statusLabel,
  writeSectionOpen,
  type ConnectorEntry,
  type ConnectorStatus,
  type HarnessCollection,
  type SkillStatus,
} from './registry';
import { useHarnessRegistry, type HarnessRegistryApi } from './useRegistry';

/** What a save says. Honest about the gap between recorded and running. */
const SAVED_NOTE = 'Saved — activates in a future update.';
/** Long enough to read once, short enough not to become furniture. */
const NOTE_MS = 6000;

/** The end-of-row state mark. Three states, none of them shouting. */
function StatusMark({ status }: { status: ConnectorStatus | SkillStatus }) {
  if (status === 'coming-soon') {
    return <span className="harness-soon">soon</span>;
  }
  return (
    <span
      className={`harness-dot${status === 'active' ? ' is-active' : ''}`}
      role="img"
      aria-label={statusLabel(status)}
    />
  );
}

interface RowProps {
  name: string;
  /** One short line about the row, shown on hover — never truncated into the row. */
  detail?: string;
  status: ConnectorStatus | SkillStatus;
  /** Server-owned rows have no menu: there is nothing here the user may change. */
  builtin: boolean;
  menuLabel: string;
  onRename: (name: string) => void;
  onRemove: () => void;
}

/**
 * One registered thing. Not a button: nothing opens yet, and inventing a
 * click target for a row that does nothing is the lie this whole surface is
 * built to avoid. Renaming happens in place, the way the chat rows do it.
 */
function HarnessRow({ name, detail, status, builtin, menuLabel, onRename, onRemove }: RowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function commit(): void {
    setRenaming(false);
    const next = draft.trim();
    if (next !== '' && next !== name) onRename(next);
    else setDraft(name);
  }

  if (renaming) {
    return (
      <div className="harness-row is-renaming">
        <input
          ref={inputRef}
          className="input harness-rename"
          value={draft}
          aria-label={`${name} name`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(name);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  const row = (
    <div className={`harness-row${builtin ? '' : ' has-actions'}`}>
      <span className="harness-name">{name}</span>
      <StatusMark status={status} />
      {!builtin && (
        <span className="harness-actions">
          <MenuButton
            label={menuLabel}
            align="right"
            triggerClassName="harness-more"
            trigger={<Icon name="overflow" />}
            items={[
              {
                label: 'Rename',
                icon: 'pencil',
                onSelect: () => {
                  setDraft(name);
                  setRenaming(true);
                },
              },
              { label: 'Remove', icon: 'trash', danger: true, onSelect: onRemove },
            ]}
          />
        </span>
      )}
    </div>
  );

  return detail ? <Tooltip content={detail}>{row}</Tooltip> : row;
}

interface AddFormProps {
  collection: HarnessCollection;
  onCancel: () => void;
  onSave: (draft: { name: string; kind: 'mcp' | 'engine'; extra: string }) => void;
  busy: boolean;
}

/**
 * The add form, inline where the row will be. Three fields at most, and the
 * optional one is labelled by what it will hold — an MCP server is started by
 * a command, an engine is reached at an address, and asking for "config" would
 * be asking the user to guess.
 */
function AddForm({ collection, onCancel, onSave, busy }: AddFormProps) {
  const isConnector = collection === 'connectors';
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'mcp' | 'engine'>('mcp');
  const [extra, setExtra] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const extraLabel = !isConnector ? 'Description' : kind === 'mcp' ? 'Command' : 'URL';
  const extraHint = !isConnector
    ? 'What it does (optional)'
    : kind === 'mcp'
      ? 'Command (optional)'
      : 'URL (optional)';

  return (
    <form
      className="harness-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === '' || busy) return;
        onSave({ name, kind, extra });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={nameRef}
        className="input harness-input"
        value={name}
        placeholder="Name"
        aria-label={isConnector ? 'Connector name' : 'Skill name'}
        onChange={(e) => setName(e.target.value)}
      />
      {isConnector && (
        <select
          className="select select-sm harness-select"
          value={kind}
          aria-label="Connector kind"
          onChange={(e) => setKind(e.target.value === 'engine' ? 'engine' : 'mcp')}
        >
          <option value="mcp">MCP server</option>
          <option value="engine">Engine</option>
        </select>
      )}
      <input
        className="input harness-input"
        value={extra}
        placeholder={extraHint}
        aria-label={extraLabel}
        onChange={(e) => setExtra(e.target.value)}
      />
      <div className="harness-form-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || name.trim() === ''}>
          Save
        </button>
      </div>
    </form>
  );
}

interface SectionProps {
  collection: HarnessCollection;
  title: string;
  addLabel: string;
  api: HarnessRegistryApi;
  children: React.ReactNode;
}

/**
 * A fold. Collapsed state is remembered the same way the rail's own is — a
 * localStorage flag read once at mount — because a section you folded away
 * yesterday should still be folded today.
 */
function Section({ collection, title, addLabel, api, children }: SectionProps) {
  const [open, setOpen] = useState(() => readSectionOpen(collection));
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The note is a receipt, not a status line: it fades on its own rather than
  // becoming another permanent row in a rail that is meant to stay quiet.
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    writeSectionOpen(collection, next);
    if (!next) setAdding(false);
  }

  async function save(draft: { name: string; kind: 'mcp' | 'engine'; extra: string }): Promise<void> {
    setBusy(true);
    setError(null);
    const extra = draft.extra.trim();
    const result =
      collection === 'connectors'
        ? await api.addConnector({
            name: draft.name,
            kind: draft.kind,
            ...(draft.kind === 'mcp' ? { command: extra } : { url: extra }),
          })
        : await api.addSkill({ name: draft.name, description: extra });
    setBusy(false);
    if (result.ok) {
      setAdding(false);
      setNote(SAVED_NOTE);
    } else {
      setError(result.error);
    }
  }

  return (
    <section className="sidebar-section harness-section" aria-label={title}>
      <h2 className="sidebar-section-title harness-section-title">
        <button type="button" className="harness-disclosure" aria-expanded={open} onClick={toggle}>
          <span className={`harness-caret${open ? ' is-open' : ''}`} aria-hidden="true">
            <Icon name="chevron" size={11} />
          </span>
          {title}
        </button>
      </h2>
      {open && (
        <div className="harness-list">
          {children}
          {adding ? (
            <AddForm collection={collection} busy={busy} onCancel={() => setAdding(false)} onSave={(d) => void save(d)} />
          ) : (
            <button
              type="button"
              className="folder-row is-action"
              onClick={() => {
                setError(null);
                setAdding(true);
              }}
            >
              <span className="folder-name">{addLabel}</span>
            </button>
          )}
          {error !== null && (
            <p className="harness-note is-error" role="status">
              {error}
            </p>
          )}
          {error === null && note !== null && (
            <p className="harness-note" role="status">
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Both folds. Renders nothing without an open folder: a registry belongs to a
 * project, and there is no honest thing to show for "no project".
 */
export function HarnessSections({ projectPath }: { projectPath: string | null }) {
  const api = useHarnessRegistry(projectPath);
  if (!projectPath) return null;

  const connectors: ConnectorEntry[] = api.registry.connectors;

  return (
    <>
      <Section collection="connectors" title="Connectors" addLabel="Add connector…" api={api}>
        {connectors.map((connector) => (
          <HarnessRow
            key={connector.id}
            name={connector.name}
            detail={connector.detail}
            status={connector.status}
            builtin={api.isBuiltin('connectors', connector.id)}
            menuLabel={`Connector options — ${connector.name}`}
            onRename={(name) => void api.rename('connectors', connector.id, name)}
            onRemove={() => void api.remove('connectors', connector.id)}
          />
        ))}
      </Section>

    </>
  );
}
