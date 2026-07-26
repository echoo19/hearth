/**
 * Skills, in the rail.
 *
 * A fold under Connectors that lists what the agent actually knows how to do —
 * real folders, not registered names. It stays deliberately thin: the rail's
 * job is to remind you a skill exists and let you switch it off; everything
 * else happens in the panel behind "Manage skills…".
 *
 * Unlike the connectors fold next to it, this one is NOT scoped to the open
 * project, because skills aren't: they belong to the person. It therefore
 * renders whether or not a folder is open.
 */
import React, { useState } from 'react';
import { Icon } from '../components/ui';
import { readSectionOpen, writeSectionOpen } from '../harness/registry';
import { SkillsDialog } from '../components/skills/SkillsDialog';
import { useSkills } from './useSkills';

export function SkillsSection() {
  const [open, setOpen] = useState(() => readSectionOpen('skills'));
  const [managing, setManaging] = useState(false);
  // The list is read when the fold is open, and again whenever the panel is —
  // an agent that writes a skill for itself should show up without a restart.
  const api = useSkills(open || managing);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    writeSectionOpen('skills', next);
  }

  return (
    <section className="sidebar-section harness-section" aria-label="Skills">
      <h2 className="sidebar-section-title harness-section-title">
        <button type="button" className="harness-disclosure" aria-expanded={open} onClick={toggle}>
          <span className={`harness-caret${open ? ' is-open' : ''}`} aria-hidden="true">
            <Icon name="chevron" size={11} />
          </span>
          Skills
        </button>
      </h2>
      {open && (
        <div className="harness-list">
          {api.skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className={skill.enabled ? 'folder-row skill-rail-row' : 'folder-row skill-rail-row is-off'}
              title={skill.description}
              onClick={() => setManaging(true)}
            >
              <span className="folder-name">{skill.name}</span>
              <span
                className={`harness-dot${skill.enabled ? ' is-active' : ''}`}
                role="img"
                aria-label={skill.enabled ? 'on' : 'off'}
              />
            </button>
          ))}
          <button type="button" className="folder-row is-action" onClick={() => setManaging(true)}>
            <span className="folder-name">{api.skills.length === 0 ? 'Add a skill…' : 'Manage skills…'}</span>
          </button>
        </div>
      )}
      {/* One store for the fold and the panel: a skill made in there has to
          appear out here without anyone re-opening anything. */}
      <SkillsDialog open={managing} api={api} onClose={() => setManaging(false)} />
    </section>
  );
}
