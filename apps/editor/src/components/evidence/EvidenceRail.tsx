/**
 * What happened when the game was played: a collapsible rail between the game
 * and its tabs.
 *
 * Collapsed it is one line — the newest sweep's verdict mix — which is all the
 * answer most of the time. Expanded it is one card per sweep with the counts,
 * the findings, and any frames the probe captured.
 */
import React from 'react';
import { useApp } from '../../store';
import { evidenceUrl } from '../../api';
import { Icon } from '../ui';
import { foldEvidence, railSummary, verdictLabel, type SweepRow } from './evidenceRows';

function SweepCard({ row, project }: { row: SweepRow; project: string }) {
  return (
    <article className="sweep-card">
      <header className="sweep-head">
        <span className="sweep-id">{row.target ?? `Sweep ${row.sweepId}`}</span>
        {row.running && <span className="sweep-live">playing</span>}
      </header>
      <div className="sweep-verdicts">
        {row.counts.length === 0 ? (
          <span className="sweep-quiet">{row.runs > 0 ? `${row.runs} runs` : 'no runs yet'}</span>
        ) : (
          row.counts.map((count) => (
            <span key={count.verdict} className={`verdict-chip tone-${count.tone}`}>
              <span className="verdict-count">{count.count}</span>
              {verdictLabel(count.verdict)}
            </span>
          ))
        )}
      </div>
      {row.findings.length > 0 && (
        <ul className="sweep-findings">
          {row.findings.slice(0, 4).map((finding, index) => (
            <li key={index}>{finding.detail ?? finding.kind ?? 'finding'}</li>
          ))}
        </ul>
      )}
      {row.shots.length > 0 && (
        <div className="sweep-shots">
          {row.shots.slice(0, 6).map((shot) => (
            <img key={shot} className="sweep-shot" src={evidenceUrl(project, shot)} alt="" loading="lazy" />
          ))}
        </div>
      )}
    </article>
  );
}

export function EvidenceRail() {
  const evidence = useApp((s) => s.evidence);
  const open = useApp((s) => s.evidenceOpen);
  const setOpen = useApp((s) => s.setEvidenceOpen);
  const project = useApp((s) => s.projectPath);
  const rows = foldEvidence(evidence);

  return (
    <div className={`evidence-rail${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="evidence-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`evidence-chevron${open ? ' is-open' : ''}`} aria-hidden="true">
          <Icon name="chevron" />
        </span>
        <span className="evidence-title">Playtests</span>
        <span className="evidence-summary">{railSummary(rows)}</span>
      </button>
      {open && (
        <div className="evidence-body">
          {rows.length === 0 ? (
            <p className="evidence-empty">
              No playtests yet. Once the game can be played, what the probe saw shows up here.
            </p>
          ) : (
            rows.map((row) =>
              row.kind === 'sweep' ? (
                <SweepCard key={row.id} row={row} project={project ?? ''} />
              ) : (
                <p key={row.id} className="evidence-note">
                  {row.text}
                </p>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
