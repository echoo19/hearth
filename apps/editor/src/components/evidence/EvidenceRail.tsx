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
import { foldEvidence, railSummary, verdictLabel, type SweepFinding, type SweepRow } from './evidenceRows';

/**
 * One line the probe wrote about the game, with the frame it wrote it on. The
 * thumbnail is the point: a finding with a picture is evidence, a finding
 * without one is a claim.
 */
function FindingCard({ finding, project }: { finding: SweepFinding; project: string }) {
  const text = finding.summary ?? finding.detail ?? finding.kind ?? 'finding';
  return (
    <li className="finding">
      {finding.shot && (
        <img className="finding-shot" src={evidenceUrl(project, finding.shot)} alt="" loading="lazy" />
      )}
      <span className="finding-text">
        <span className="finding-summary">{text}</span>
        {finding.summary && finding.detail && <span className="finding-detail">{finding.detail}</span>}
      </span>
    </li>
  );
}

function SweepCard({ row, project }: { row: SweepRow; project: string }) {
  // Shots already shown beside a finding don't need repeating in the strip.
  const findingShots = new Set(row.findings.map((finding) => finding.shot).filter(Boolean));
  const looseShots = row.shots.filter((shot) => !findingShots.has(shot));
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
            <FindingCard key={index} finding={finding} project={project} />
          ))}
        </ul>
      )}
      {looseShots.length > 0 && (
        <div className="sweep-shots">
          {looseShots.slice(0, 6).map((shot) => (
            <img key={shot} className="sweep-shot" src={evidenceUrl(project, shot)} alt="" loading="lazy" />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * What the rail says before anything has been played. Pure so the copy rule is
 * testable: it must teach the action while nothing exists, then stop claiming
 * nothing exists the moment something does.
 */
export function emptyRailCopy(opts: { gamePresent: boolean; running: boolean }): string {
  if (opts.running) return 'Playing now. Verdicts land here as each run finishes.';
  if (!opts.gamePresent) return 'Nothing has been played yet. Once there is a game to run, what the probe saw shows up here.';
  return 'Nothing has been played yet. Press Playtest and the probe will play this game many ways and write down what happened.';
}

export function EvidenceRail() {
  const evidence = useApp((s) => s.evidence);
  const open = useApp((s) => s.evidenceOpen);
  const setOpen = useApp((s) => s.setEvidenceOpen);
  const project = useApp((s) => s.projectPath);
  const gamePresent = useApp((s) => s.game.present);
  const running = useApp((s) => s.sweep.running);
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
            <p className="evidence-empty">{emptyRailCopy({ gamePresent, running })}</p>
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
