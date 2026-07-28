/**
 * Skills, from Settings: a signpost, not a second copy of the screen.
 *
 * Skills already have a place — a full screen, because reading the list and
 * writing one are both longer work than a dialog is good for. Rebuilding any
 * part of that here would mean two surfaces that have to agree about the same
 * folders, and the one inside a dialog would always be the worse of the two.
 *
 * It still earns a rail row. People look for what they have taught their agent
 * under Settings, and searching "skills" here has to find something; a rail
 * that quietly omits it reads as a missing feature rather than a moved one. So
 * this pane is one row that says where skills live and a button that goes
 * there, and the dialog closes behind you.
 */
import React from 'react';
import { useApp } from '../../store';
import { Button } from '../ui/Button';
import { SettingsGroup, SettingsRow } from './SettingsRow';

export function SkillsPane() {
  const openScreen = useApp((s) => s.openScreen);

  return (
    <>
      <h2 className="set-pane-title">Skills</h2>
      <p className="set-pane-lead">
        Instructions that extend what your agent knows how to do. They belong to you rather than to one game, so a skill
        you write once is there in the next thing you make.
      </p>

      <SettingsGroup>
        <SettingsRow
          label="Your skills"
          hint="Each one is a folder with a SKILL.md in it. That is the same format Claude Code and codex read, so Hearth also lists the ones you already wrote for them."
          control={
            <Button
              icon="script"
              onClick={() => {
                // Closing is the screen's job, not this pane's: opening a full
                // screen behind a dialog would leave the dialog on top of the
                // thing it just sent you to.
                window.dispatchEvent(new CustomEvent('hearth:close-settings'));
                openScreen('skills');
              }}
            >
              Open skills
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}
