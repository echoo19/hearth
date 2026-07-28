/**
 * Skills — the screen where you see what your agent knows how to do, and
 * change it.
 *
 * A place rather than a sheet: it takes the whole working area, it is left
 * rather than dismissed, and the way out says where back is. That matters here
 * more than it does for most panels, because the two things you do with a
 * skill — read the list, then write one — are both long enough that a dialog
 * would be a window you keep having to re-open.
 *
 * The list is a reading column: a title, one line saying what these are, a
 * search field and a +, then rows. Each row is a whole skill — what it is
 * called and when to use it — and clicking one opens it in the editor.
 *
 * Three ways in, because they are genuinely three different situations:
 *
 *   with chat      you know what you want the agent to be good at but not how
 *                  to write it down — hand the job to the agent, which is
 *                  sitting right there and can write the file itself.
 *   with editor    you know exactly what to say.
 *   from a folder  you already have one.
 *
 * The rows carry two things the layout they follow does not, both because
 * Hearth's skills are real folders that real agents load:
 *
 *   off      a skill can be switched off, so off has to be settable and
 *            visible. It lives in the row's menu, and an off skill says so.
 *   whose    some of these folders are Claude Code's and Codex's, found where
 *            those tools keep them and read strictly. "Installed" would be a
 *            mystery without a word saying who installed it, so the row says.
 *
 * A skill Hearth did not write is a skill Hearth does not change: its row
 * offers no Edit and no Delete, and opening it opens a page you can read.
 */
import React, { useMemo, useRef, useState } from 'react';
import { ConfirmDialog, Icon } from '../ui';
import { ScreenHeader } from '../ui/ScreenHeader';
import { MenuButton, type MenuItem } from '../ui/Menu';
import {
  groupSkills,
  matchesQuery,
  skillEditable,
  skillMeta,
  skillSource,
  skillSourceLabel,
  useSkills,
  type SkillDraft,
  type SkillRecord,
} from '../../skills/useSkills';
import { useApp } from '../../store';
import { createWithChatPrompt, folderNameOf, improveDescriptionPrompt, readFolder } from './skillPrompt';
import { BLANK_SKILL, SkillEditor } from './SkillEditor';

/**
 * Where the way out goes. Skills belong to the person, not to a project, so
 * this screen can be reached from either side of the app — the label has to
 * name whatever is actually waiting underneath.
 */
export function skillsBackLabel(projectName: string | null, projectPath: string | null): string {
  return projectPath !== null && projectName !== null && projectName !== '' ? projectName : 'Chats';
}

/**
 * The letter on a skill's tile. Real data rather than decoration: the list
 * has no icon to show and inventing one per skill would be a picture of
 * nothing, while the first letter is at least the skill's own.
 */
export function skillInitial(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? '?' : first.toUpperCase();
}

/**
 * What a read-only skill's page says about itself. Names the tool it belongs
 * to and the folder it is in, because "you can't edit this" without a reason
 * reads as the app being difficult.
 */
export function borrowedSkillNote(skill: SkillRecord): string {
  return `${skillSourceLabel(skillSource(skill))} keeps this skill in ${skill.path}. Hearth reads it and leaves it alone. Edit it where it lives.`;
}

type View =
  | { kind: 'list' }
  /**
   * `note` is carried rather than looked up again on render: two tools can
   * legitimately keep a folder of the same name, and the row that was clicked
   * is the only thing that knows which of them was opened.
   */
  | { kind: 'editor'; id: string | null; draft: SkillDraft; readOnly: boolean; note?: string };

/** One skill in the list. */
function SkillRow({
  skill,
  onOpen,
  onToggle,
  onDelete,
}: {
  skill: SkillRecord;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  // A skill in another tool's folder can be read and switched off, and that
  // is the whole of what Hearth can do to it. Offering Edit or Delete anyway
  // would be a menu describing a different app.
  const editable = skillEditable(skill);
  const source = skillSource(skill);
  const items: MenuItem[] = [
    { label: editable ? 'Edit' : 'Open', icon: editable ? 'pencil' : 'text', onSelect: onOpen },
    {
      label: skill.enabled ? 'Turn off' : 'Turn on',
      icon: skill.enabled ? 'cross' : 'check',
      onSelect: () => onToggle(!skill.enabled),
    },
  ];
  if (editable) {
    items.push({ separator: true }, { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete });
  }
  // With no description written, the row's second line says what is true
  // instead of standing empty: how many files, and when it last changed.
  const second = skill.description !== '' ? skill.description : skillMeta(skill);
  return (
    <li className={skill.enabled ? 'skills-item' : 'skills-item is-off'}>
      <button type="button" className="skills-item-open" onClick={onOpen}>
        <span className="skills-item-tile" aria-hidden="true">
          {skillInitial(skill.name)}
        </span>
        <span className="skills-item-text">
          <span className="skills-item-name">
            <span className="skills-item-title">{skill.name}</span>
            {/* Whose folder it is. Only worth saying when the answer is not
                Hearth: everything under "Created by me" is Hearth's, and a
                column of identical badges is a column of noise. */}
            {source !== 'hearth' && <span className="skills-item-source">{skillSourceLabel(source)}</span>}
            {!skill.enabled && <span className="skills-item-off">Off</span>}
          </span>
          {/* A native title on a non-interactive span is the right tool for
              "show the whole line when it is clipped". */}
          <span className="skills-item-desc" title={second !== '' ? second : undefined}>
            {second}
          </span>
        </span>
      </button>
      <MenuButton
        label={`${skill.name} options`}
        align="right"
        triggerClassName="skills-item-more"
        trigger={<Icon name="more" />}
        items={items}
      />
    </li>
  );
}

export function SkillsScreen() {
  const api = useSkills(true);
  const closeScreen = useApp((s) => s.closeScreen);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [confirming, setConfirming] = useState<SkillRecord | null>(null);
  // Trouble this screen ran into itself, as opposed to what the store reports.
  const [trouble, setTrouble] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(
    () => groupSkills(api.skills.filter((skill) => matchesQuery(skill, query))),
    [api.skills, query],
  );
  const shown = groups.reduce((count, group) => count + group.skills.length, 0);

  function startWithChat(): void {
    // The agent has filesystem tools and is already in the folder, so this is
    // a real hand-off, not a stub: it writes the skill itself.
    useApp.setState({ pendingPrompt: createWithChatPrompt(api.root) });
    closeScreen();
  }

  async function importPicked(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const payload = await readFolder(files);
    await api.importFolder(folderNameOf(files), payload);
  }

  /**
   * Open a skill for editing. The list row carries the name and description
   * but not the instructions, so the file is read first — and if it cannot be
   * read, the editor stays shut. Opening a blank editor over a file we failed
   * to read would let a save quietly empty it.
   */
  function openSkill(skill: SkillRecord): void {
    setTrouble(null);
    void api.source(skill.id).then((draft) => {
      if (!draft) {
        setTrouble(`Hearth could not read the SKILL.md inside ${skill.name}, so there is nothing to open.`);
        return;
      }
      const readOnly = !skillEditable(skill);
      setView({ kind: 'editor', id: skill.id, draft, readOnly, note: readOnly ? borrowedSkillNote(skill) : undefined });
    });
  }

  function save(id: string | null, draft: SkillDraft): void {
    const written = id === null ? api.create(draft) : api.update(id, draft);
    void written.then((ok) => {
      if (ok) setView({ kind: 'list' });
    });
  }

  /**
   * Hand the description to the agent. What is on screen is written to disk
   * first — the agent is about to read that file, and this screen is about to
   * go away — and then the job is put in the composer the same way "Create
   * with chat" does.
   */
  function improve(id: string, draft: SkillDraft): void {
    const folder = api.skills.find((skill) => skill.id === id)?.path ?? `${api.root}/${id}`;
    void api.update(id, draft).then((ok) => {
      if (!ok) return;
      useApp.setState({ pendingPrompt: improveDescriptionPrompt(draft.name, folder) });
      closeScreen();
    });
  }

  const confirm = (
    <ConfirmDialog
      open={confirming !== null}
      title={`Delete ${confirming?.name ?? 'this skill'}?`}
      body="The skill and everything in it is deleted from your computer. This can't be undone."
      confirmLabel="Delete"
      danger
      onConfirm={() => {
        const target = confirming;
        setConfirming(null);
        if (!target) return;
        void api.remove(target.id).then((ok) => {
          if (ok) setView({ kind: 'list' });
        });
      }}
      onCancel={() => setConfirming(null)}
    />
  );

  if (view.kind === 'editor') {
    const { id, draft, readOnly, note } = view;
    const record = id === null ? null : (api.skills.find((skill) => skill.id === id) ?? null);
    // Read-only means read-only all the way down: no Save, no Delete, and no
    // "Improve description" — that one rewrites the file, which is the exact
    // thing Hearth promised not to do to another tool's folder.
    return (
      <div className="screen skills-screen">
        <SkillEditor
          key={id ?? 'new'}
          id={id}
          draft={draft}
          readOnly={readOnly}
          note={note}
          onBack={() => setView({ kind: 'list' })}
          onSave={(next) => save(id, next)}
          onDelete={readOnly || record === null ? undefined : () => setConfirming(record)}
          onImprove={readOnly || id === null ? undefined : (next) => improve(id, next)}
        />
        {confirm}
      </div>
    );
  }

  const notice = trouble ?? api.error;

  return (
    <div className="screen skills-screen">
      <ScreenHeader back={{ label: skillsBackLabel(projectName, projectPath), onBack: closeScreen }} />

      <div className="screen-body">
        <div className="skills-page">
          <header className="skills-masthead">
            <div className="skills-masthead-text">
              <h1 className="skills-heading">Skills</h1>
              <p className="skills-lede">Things you teach your agent once, so it still knows them in the next game.</p>
            </div>
            <div className="skills-tools">
              <div className="skills-find">
                <Icon name="search" size={13} />
                <input
                  className="skills-find-input"
                  value={query}
                  placeholder="Search skills"
                  aria-label="Search skills"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <MenuButton
                label="Add a skill"
                align="right"
                triggerClassName="skills-new"
                trigger={<Icon name="plus" size={14} />}
                items={[
                  { label: 'Create with chat', icon: 'flame', onSelect: startWithChat },
                  {
                    label: 'Create with editor',
                    icon: 'pencil',
                    onSelect: () => setView({ kind: 'editor', id: null, draft: BLANK_SKILL, readOnly: false }),
                  },
                  {
                    label: 'Upload from your computer',
                    icon: 'upload',
                    onSelect: () => folderRef.current?.click(),
                  },
                ]}
              />
            </div>
          </header>

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

          {notice !== null && <p className="skills-notice">{notice}</p>}

          {shown === 0 ? (
            <div className="skills-blank">
              <p className="skills-blank-lead">
                {api.skills.length === 0 ? 'No skills yet.' : 'Nothing here matches that.'}
              </p>
              {api.skills.length === 0 && (
                <p className="skills-blank-hint">
                  A skill is a folder with a SKILL.md in it. That is the same format Claude Code and Codex read, so
                  one skill works with whichever agent answers.
                </p>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <section className="skills-group" key={group.title ?? 'all'}>
                {group.title !== null && <h2 className="skills-group-title">{group.title}</h2>}
                <ul className="skills-rows">
                  {group.skills.map((skill) => (
                    <SkillRow
                      key={`${skillSource(skill)}/${skill.id}`}
                      skill={skill}
                      onOpen={() => openSkill(skill)}
                      onToggle={(enabled) => void api.setEnabled(skill.id, enabled)}
                      onDelete={() => setConfirming(skill)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}

          {/* Where the ones Hearth owns are. Deliberately not "they all live
              here": the installed ones live in their own tools' folders, and
              this line has to stay true with those in the list. */}
          {api.root !== '' && <p className="skills-where">The skills you make here live in {api.root}</p>}
        </div>
      </div>

      {confirm}
    </div>
  );
}
