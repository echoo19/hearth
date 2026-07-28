/**
 * The settings panes, in the order the rail shows them.
 *
 * One list rather than a switch statement in the shell, because a pane is a
 * whole self-contained thing: it knows its own heading, its own rows and its
 * own data. Adding one is adding an entry here, and nothing in the shell has
 * to learn about it.
 *
 * `keywords` exists because a rail label is the name of a place, and people
 * search for the setting instead — "api key" should find Agents, "update"
 * should find General. The words are what someone would type, not synonyms of
 * the label.
 *
 * Two headings, and they mean different things. `settings` is Hearth itself:
 * how it works, who answers, what it costs. `customize` is what you have
 * taught it. Skills sits under the second one and is a signpost rather than a
 * pane — see SkillsPane.tsx for why that is the honest shape.
 */
import type { ComponentType } from 'react';
import { AgentsPane } from './AgentsPane';
import { GeneralPane } from './GeneralPane';
import { PersonalizationPane } from './PersonalizationPane';
import { SkillsPane } from './SkillsPane';
import { UsagePane } from './UsagePane';

export interface SettingsPane {
  id: string;
  /** Rail label. */
  label: string;
  /** Name from the app's Icon set. */
  icon: string;
  /** Which rail heading it sits under. */
  group: 'settings' | 'customize';
  /** Words the rail search matches besides the label. */
  keywords?: readonly string[];
  Component: ComponentType;
}

export const SETTINGS_PANES: readonly SettingsPane[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'gear',
    group: 'settings',
    keywords: ['version', 'update', 'updates', 'about', 'folder', 'folders', 'projects', 'home', 'files'],
    Component: GeneralPane,
  },
  {
    id: 'personalization',
    label: 'Personalization',
    icon: 'star',
    group: 'settings',
    keywords: ['name', 'instructions', 'agents.md', 'standing', 'profile', 'about you', 'preferences'],
    Component: PersonalizationPane,
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'sparkle',
    group: 'settings',
    keywords: ['claude', 'chatgpt', 'openai', 'anthropic', 'codex', 'api key', 'model', 'provider', 'sign in'],
    Component: AgentsPane,
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'grid',
    group: 'settings',
    keywords: ['tokens', 'cost', 'spend', 'limits', 'credits', 'billing'],
    Component: UsagePane,
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: 'script',
    group: 'customize',
    keywords: ['skill', 'skill.md', 'teach', 'abilities', 'instructions'],
    Component: SkillsPane,
  },
];

/** The rail's headings, in order. Empty ones are not drawn. */
export const SETTINGS_GROUPS: readonly { id: SettingsPane['group']; title: string }[] = [
  { id: 'settings', title: 'Settings' },
  { id: 'customize', title: 'Customize' },
];

/**
 * Which panes a search leaves standing.
 *
 * Every word has to hit something, so "api key" narrows rather than widens —
 * with an OR, the second word would drag half the rail back in and the field
 * would feel broken. Order is the registry's, never the match's: the rail is a
 * fixed set of places, and having them reshuffle under the cursor while typing
 * is what makes a filtered list hard to aim at.
 */
export function filterPanes(panes: readonly SettingsPane[], query: string): SettingsPane[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...panes];
  return panes.filter((pane) => {
    const haystack = `${pane.label} ${pane.id} ${(pane.keywords ?? []).join(' ')}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
