/**
 * Skills — the panel where you see what your agent knows how to do, and change
 * it.
 *
 * The shape is the one people already know from the two apps this one sits
 * next to: a title, a search field, a + that offers the three ways to make a
 * skill, and a list of rows with a switch on each. What is different is that
 * these are folders on the user's own disk, and the panel says where.
 *
 * Three ways in, because they are genuinely three different situations:
 *
 *   with chat      you know what you want the agent to be good at but not how
 *                  to write it down — hand the job to the agent, which is
 *                  sitting right there and can write the file itself.
 *   with editor    you know exactly what to say.
 *   from a folder  you already have one.
 */
import React, { useMemo, useRef, useState } from 'react';
import { ConfirmDialog, Icon, Modal } from '../ui';
import { Button } from '../ui/Button';
import { MenuButton } from '../ui/Menu';
import { matchesQuery, skillMeta, useSkills, type SkillDraft, type SkillRecord, type SkillsApi } from '../../skills/useSkills';
import { base64FromDataUrl } from '../../chat/attachments';
import { useApp } from '../../store';

/** What the agent is asked, when a skill is made "with chat". */
export function createWithChatPrompt(root: string): string {
  return [
    'Write me a new skill.',
    '',
    `Create a folder in ${root} named after the skill (lowercase, dashes), containing a SKILL.md`,
    'whose frontmatter has a `name` and a one-sentence `description` of when to use it,',
    'followed by the instructions themselves.',
    '',
    'First ask me what the skill should do, unless I have already told you.',
  ].join('\n');
}

/** Read a picked folder into what the import route wants. */
async function readFolder(files: readonly File[]): Promise<{ relPath: string; data: string }[]> {
  const out: { relPath: string; data: string }[] = [];
  for (const file of files) {
    // webkitRelativePath is `<chosen-folder>/<rest>`; the folder itself is
    // named by the slug we derive, so only the rest matters.
    const full = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
    const relPath = full.split('/').slice(1).join('/') || file.name;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`could not read ${file.name}`));
      reader.onload = () => resolve(base64FromDataUrl(String(reader.result ?? '')));
      reader.readAsDataURL(file);
    });
    out.push({ relPath, data });
  }
  return out;
}

/** The name a picked folder suggests, used when its SKILL.md names nothing. */
export function folderNameOf(files: readonly File[]): string {
  const first = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
  return first?.split('/')[0] ?? 'skill';
}

interface EditorState {
  id: string | null;
  draft: SkillDraft;
}

const BLANK: SkillDraft = { name: '', description: '', body: '' };

/** Write or rewrite one skill. Three fields, because a skill has three parts. */
function SkillEditor({
  state,
  onCancel,
  onSave,
}: {
  state: EditorState;
  onCancel: () => void;
  onSave: (draft: SkillDraft) => void;
}) {
  const [draft, setDraft] = useState(state.draft);
  const canSave = draft.name.trim() !== '' && draft.body.trim() !== '';
  return (
    <div className="skill-editor">
      <label className="field-label" htmlFor="skill-name">
        Name
      </label>
      <input
        id="skill-name"
        className="input"
        value={draft.name}
        placeholder="Pixel art"
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <label className="field-label" htmlFor="skill-desc">
        When to use it
      </label>
      <input
        id="skill-desc"
        className="input"
        value={draft.description}
        placeholder="Drawing sprites and tilesets for a 2D game."
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <p className="field-note">
        This one sentence is how the agent decides whether to reach for the skill, so say when — not what.
      </p>
      <label className="field-label" htmlFor="skill-body">
        Instructions
      </label>
      <textarea
        id="skill-body"
        className="input skill-body"
        rows={12}
        value={draft.body}
        placeholder={'Keep to a 16-colour palette.\nDraw at 32×32 and scale up with nearest-neighbour.'}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      <div className="modal-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSave} onClick={() => onSave(draft)}>
          {state.id ? 'Save' : 'Create skill'}
        </Button>
      </div>
    </div>
  );
}

/** One skill in the list. */
function SkillRow({
  skill,
  onToggle,
  onEdit,
  onDelete,
}: {
  skill: SkillRecord;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={skill.enabled ? 'skill-row' : 'skill-row is-off'}>
      <div className="skill-row-main">
        <button type="button" className="skill-row-name" onClick={onEdit}>
          {skill.name}
        </button>
        {skill.description !== '' && <p className="skill-row-desc">{skill.description}</p>}
        <p className="skill-row-meta">{skillMeta(skill)}</p>
      </div>
      <label className="skill-switch">
        <input
          type="checkbox"
          checked={skill.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`${skill.name} ${skill.enabled ? 'on' : 'off'}`}
        />
        <span className="skill-switch-track" aria-hidden="true" />
      </label>
      <MenuButton
        label={`${skill.name} options`}
        align="right"
        triggerClassName="skill-row-more"
        trigger={<Icon name="more" />}
        items={[
          { label: 'Edit…', icon: 'pencil', onSelect: onEdit },
          { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
        ]}
      />
    </li>
  );
}

/**
 * The panel. One dialog, two faces: the list, and the editor that replaces it.
 *
 * Two stacked dialogs was the obvious first shape and the wrong one — closing
 * the list to show the editor fires the list's own `close` event, which reads
 * as the user dismissing the whole panel and shuts everything. One dialog
 * whose body swaps has no such seam.
 *
 * `api` is passed in by the rail so the list it shows and the list in here are
 * the same one: a skill created here has to appear out there without anyone
 * re-opening anything.
 */
export function SkillsDialog({
  open,
  onClose,
  api: sharedApi,
}: {
  open: boolean;
  onClose: () => void;
  api?: SkillsApi;
}) {
  const ownApi = useSkills(open && !sharedApi);
  const api = sharedApi ?? ownApi;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [confirming, setConfirming] = useState<SkillRecord | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => api.skills.filter((skill) => matchesQuery(skill, query)), [api.skills, query]);

  function startWithChat(): void {
    // The agent has filesystem tools and is already in the folder, so this is
    // a real hand-off, not a stub: it writes the skill itself.
    useApp.setState({ pendingPrompt: createWithChatPrompt(api.root) });
    onClose();
  }

  async function importPicked(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const payload = await readFolder(files);
    await api.importFolder(folderNameOf(files), payload);
  }

  return (
    <>
      <Modal
        open={open}
        title={editing === null ? 'Skills' : editing.id ? 'Edit skill' : 'New skill'}
        className="is-wide"
        onClose={() => {
          setEditing(null);
          onClose();
        }}
      >
        {editing ? (
          <div className="modal-body">
            <SkillEditor
              state={editing}
              onCancel={() => setEditing(null)}
              onSave={(draft) => {
                const save = editing.id ? api.update(editing.id, draft) : api.create(draft);
                void save.then((ok) => {
                  if (ok) setEditing(null);
                });
              }}
            />
          </div>
        ) : (
        <div className="modal-body skills-body">
          <div className="skills-head">
            <p className="skills-lead">Instructions that extend what your agent knows how to do.</p>
            <div className="skills-head-controls">
              <div className="skills-search">
                <Icon name="search" />
                <input
                  className="skills-search-input"
                  value={query}
                  placeholder="Search skills"
                  aria-label="Search skills"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <MenuButton
                label="Add a skill"
                align="right"
                triggerClassName="skills-add"
                trigger={<Icon name="plus" />}
                items={[
                  { label: 'Create with chat', icon: 'flame', onSelect: startWithChat },
                  {
                    label: 'Create with editor',
                    icon: 'pencil',
                    onSelect: () => setEditing({ id: null, draft: BLANK }),
                  },
                  {
                    label: 'Upload from your computer',
                    icon: 'upload',
                    onSelect: () => folderRef.current?.click(),
                  },
                ]}
              />
            </div>
          </div>

          {/* A directory picker: skills are folders, and this is the one input
              that can hand a whole folder to a web layer. */}
          <input
            ref={folderRef}
            type="file"
            className="composer-file-input"
            aria-hidden="true"
            tabIndex={-1}
            // @ts-expect-error — a real attribute in Chromium, which is what
            // this app runs on; React has no typing for it.
            webkitdirectory=""
            directory=""
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void importPicked(files);
            }}
          />

          {api.error && <p className="skills-error">{api.error}</p>}

          {shown.length === 0 ? (
            <div className="skills-empty">
              <p className="skills-empty-lead">
                {api.skills.length === 0 ? 'No skills yet.' : 'Nothing matches that.'}
              </p>
              {api.skills.length === 0 && (
                <p className="skills-empty-hint">
                  A skill is a folder with a SKILL.md in it — the same format Claude Code and Codex read, so
                  one skill works with whichever agent answers.
                </p>
              )}
            </div>
          ) : (
            <ul className="skills-list">
              {shown.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  onToggle={(enabled) => void api.setEnabled(skill.id, enabled)}
                  onEdit={() => {
                    void api.source(skill.id).then((draft) => setEditing({ id: skill.id, draft: draft ?? BLANK }));
                  }}
                  onDelete={() => setConfirming(skill)}
                />
              ))}
            </ul>
          )}

          {api.root !== '' && <p className="skills-root">They live in {api.root}</p>}
        </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirming !== null}
        title={`Delete ${confirming?.name ?? 'this skill'}?`}
        body="The folder and everything in it is removed from your computer."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target) void api.remove(target.id);
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
