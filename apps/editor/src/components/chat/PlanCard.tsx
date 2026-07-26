/**
 * The agent's plan, an image it produced, and the quiet lines that explain
 * what happened to the conversation.
 *
 * These three exist for one reason: the terminal shows them and the app used
 * to not. A plan the agent is working through, a sprite it just generated, the
 * moment the context was compacted — leaving any of them out makes the app a
 * lossy view of the agent, which is the one thing it cannot be.
 */
import React from 'react';
import { useApp } from '../../store';
import { projectFileUrl } from '../../api';
import type { ChatImagePart, ChatNoticePart, ChatPlanPart } from '../../types';

/** `[x] done`, `[~] doing`, `[ ] to do` — the three states a plan line has. */
export function planLineState(line: string): { state: 'done' | 'active' | 'todo'; text: string } {
  const match = /^\s*(?:[-*]\s*)?\[([ x~])\]\s*(.*)$/i.exec(line);
  if (!match) return { state: 'todo', text: line.replace(/^\s*[-*]\s*/, '').trim() };
  const mark = match[1].toLowerCase();
  return { state: mark === 'x' ? 'done' : mark === '~' ? 'active' : 'todo', text: match[2].trim() };
}

export function PlanCard({ part }: { part: ChatPlanPart }) {
  const lines = part.text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return (
    <div className="plan-card">
      <p className="plan-title">Plan</p>
      <ul className="plan-list">
        {lines.map((line, index) => {
          const item = planLineState(line);
          return (
            <li key={index} className={`plan-item is-${item.state}`}>
              <span className="plan-mark" aria-hidden="true" />
              <span className="plan-text">{item.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Resolve a path the agent gave us into something the browser can load. An
 * absolute path inside the open folder becomes a project read; anything else
 * cannot be shown, and says so rather than rendering a broken frame.
 */
export function imageSrcFor(path: string, project: string | null): string | null {
  if (project === null || project === '') return null;
  if (path.startsWith(`${project}/`)) return projectFileUrl(project, path.slice(project.length + 1));
  if (!path.startsWith('/')) return projectFileUrl(project, path);
  return null;
}

export function ImageCard({ part }: { part: ChatImagePart }) {
  const project = useApp((s) => s.projectPath);
  const src = imageSrcFor(part.path, project);
  if (!src) {
    return (
      <p className="chat-notice">
        An image at <span className="chat-notice-path">{part.path}</span>
      </p>
    );
  }
  return (
    <figure className="image-card">
      <img src={src} alt={part.caption ?? 'Image from the agent'} loading="lazy" />
      {part.caption && <figcaption>{part.caption}</figcaption>}
    </figure>
  );
}

export function NoticeRow({ part }: { part: ChatNoticePart }) {
  return <p className="chat-notice">{part.text}</p>;
}
