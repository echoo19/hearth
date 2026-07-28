/**
 * The skill editor — a screen, because writing a skill is work rather than a
 * decision. A dialog is the right shape for "are you sure"; it is the wrong
 * shape for a page of instructions you will come back to and rewrite.
 *
 * Three fields, because a skill has three parts and no more: the name an agent
 * matches on, the one sentence that decides whether it reaches for the skill,
 * and the instructions themselves. The first two sit in a card at the top,
 * where they are read; the third takes the rest of the screen, because that is
 * where the time goes. It is set in the mono face — what you are writing is a
 * markdown file, and it will be read back as one.
 *
 * There is no file rail here, and that is deliberate. Hearth's editor writes
 * exactly one file, SKILL.md; a rail listing that single row, next to an
 * Upload button that could only ever make a DIFFERENT skill, would be
 * navigation with nowhere to go. Folders with more in them are imported whole
 * from the list screen, which is the one place that can honestly offer it.
 *
 * The same screen also reads. A skill Hearth found in Claude Code's or Codex's
 * own folder is shown here whole and left alone: no Save, no Delete, nothing
 * typeable, and one line saying whose it is. Offering a Save that the server
 * would refuse would be the worst version of this — the work gets done, the
 * button gets pressed, and nothing happens.
 */
import React, { useState } from 'react';
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { ScreenHeader } from '../ui/ScreenHeader';
import { MenuButton } from '../ui/Menu';
import type { SkillDraft } from '../../skills/useSkills';

/** A skill with nothing in it yet. */
export const BLANK_SKILL: SkillDraft = { name: '', description: '', body: '' };

/**
 * A skill is only worth writing to disk once it has a name to be matched on
 * and something to say. The description is left out on purpose: it can be
 * filled in later, and refusing to save without it would strand the
 * instructions someone just typed.
 */
export function canSaveSkill(draft: SkillDraft): boolean {
  return draft.name.trim() !== '' && draft.body.trim() !== '';
}

export function SkillEditor({
  id,
  draft: initial,
  readOnly = false,
  note,
  onBack,
  onSave,
  onDelete,
  onImprove,
}: {
  /** The skill being rewritten, or null when this one does not exist yet. */
  id: string | null;
  draft: SkillDraft;
  /** True for a skill Hearth found in another tool's folder: show, don't touch. */
  readOnly?: boolean;
  /** One line saying whose skill this is, shown above the fields. */
  note?: string;
  onBack: () => void;
  onSave: (draft: SkillDraft) => void;
  /** Absent while creating, and for anything read-only: nothing to delete. */
  onDelete?: () => void;
  /**
   * Absent while creating, for the same reason: improving a description means
   * handing the agent a file to rewrite, and this skill has no file yet.
   */
  onImprove?: (draft: SkillDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <>
      <ScreenHeader
        back={{ label: 'Skills', onBack }}
        // Nothing here can be edited when it is read-only, so the screen does
        // not claim to be an editor.
        title={readOnly ? 'Skill' : 'Skill editor'}
        actions={
          <>
            {!readOnly && (
              <Button variant="primary" size="sm" disabled={!canSaveSkill(draft)} onClick={() => onSave(draft)}>
                {id === null ? 'Create' : 'Save'}
              </Button>
            )}
            {/* Only rendered when it has something to offer — a menu whose one
                item does not apply is a control that lies about what is here. */}
            {onDelete && (
              <MenuButton
                label="Skill options"
                align="right"
                triggerClassName="btn btn-sm btn-ghost btn-icon"
                trigger={<Icon name="more" />}
                items={[{ label: 'Delete skill', icon: 'trash', danger: true, onSelect: onDelete }]}
              />
            )}
          </>
        }
      />

      <div className="screen-body skill-edit-scroll">
        <div className="skill-edit">
          {note !== undefined && <p className="skill-edit-note">{note}</p>}
          <div className="skill-edit-card">
            <div className="skill-edit-field">
              <label className="skill-edit-label" htmlFor="skill-name">
                Name
              </label>
              <input
                id="skill-name"
                className="skill-edit-value"
                value={draft.name}
                readOnly={readOnly}
                placeholder={readOnly ? undefined : 'Pixel art'}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="skill-edit-field">
              <label className="skill-edit-label" htmlFor="skill-desc">
                Description
              </label>
              {/* The placeholder carries the guidance that used to sit under
                  the field as a note: this sentence is how the agent decides
                  whether to reach for the skill at all. It is dropped when the
                  page is read-only — a prompt to write something, on a field
                  nobody can type in, describes a field that isn't there. */}
              {/* A textarea rather than an input, because a description is a
                  whole sentence and several of the ones on this machine run to
                  three lines. In a single-line input the rest of it sits
                  outside the box, unreachable without a caret — which on a
                  page that exists to be READ is the field failing at its one
                  job. It grows with its content and never scrolls. */}
              <textarea
                id="skill-desc"
                className="skill-edit-value is-wrapping"
                rows={1}
                value={draft.description}
                readOnly={readOnly}
                placeholder={readOnly ? undefined : 'One sentence on when to reach for it'}
                ref={(el) => {
                  if (!el) return;
                  el.style.height = 'auto';
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            {onImprove && (
              <div className="skill-edit-card-foot">
                <Button size="sm" onClick={() => onImprove(draft)}>
                  Improve description
                </Button>
              </div>
            )}
          </div>

          <textarea
            className="skill-edit-body"
            aria-label="Skill instructions"
            value={draft.body}
            readOnly={readOnly}
            placeholder={readOnly ? undefined : 'Write skill instructions…'}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}
