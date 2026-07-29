/**
 * Settings → Usage: what this machine has actually made with Hearth.
 *
 * The shape of this pane is a refusal. Every app with a settings dialog puts a
 * billing dashboard here — a giant number, a tiny label, a spend chart — and
 * Hearth has no account, no quota and no meter to put in one. So there is no
 * hero metric and no card grid: this is a reading list, in the same aligned
 * rows as every other pane, because that is what the data honestly is. Counts
 * of files, read off the disk when the dialog opened.
 *
 * What that leaves out is deliberate and worth naming, since a missing number
 * is normally read as a bug:
 *
 *   tokens, requests, spend   do not exist. Nothing meters them, and there is
 *                             no account they could be metered against.
 *   messages per conversation would mean reading every transcript of every
 *                             folder to open a dialog. The conversation count
 *                             comes free from an index; the message count does
 *                             not, so it is not offered.
 *   who answered which turn   is not written down. A transcript records what
 *                             was said, not which provider said it (see
 *                             `ChatRecord` in server/chatStore.ts), so "turns
 *                             by agent" would be a guess.
 *
 * The per-folder list is the interesting half — usage is really "which of my
 * games did I actually work on" — so it is a compact list rather than a chart,
 * and it keeps folders that are no longer on disk, labelled as such, because
 * deleting a game does not mean it never happened.
 */
import React, { useEffect, useState } from 'react';
import { apiUsage, type UsageProject, type UsageReport } from '../../api';
import { relativeTime } from '../shell/Sidebar';
import { Button } from '../ui/Button';
import { SettingsGroup, SettingsRow } from './SettingsRow';

/** What the pane is doing while it has no numbers to show. */
type Phase = 'reading' | 'ready' | 'failed';

/**
 * How long the pane waits before it stops saying "counting" and offers a way
 * out.
 *
 * This walks every remembered folder, reading an index, a directory and the
 * tail of a journal in each, so a cold disk or a folder on a sleeping network
 * mount is slow rather than broken and the ceiling is set to suit the slow
 * case. Before it there was no ceiling at all: a read that never came back
 * left "Counting what is on disk…" on screen for the life of the dialog, with
 * nothing to press.
 *
 * A deadline on the WAIT, not on the request. `apiUsage` takes no abort
 * signal, so the fetch underneath carries on; if it lands later it is still
 * used, and the pane recovers on its own without the user pressing anything.
 */
export const USAGE_TIMEOUT_MS = 12_000;

/** A count, with its digits aligned to the counts above and below it. */
function Figure({ value }: { value: number }) {
  return <span className="set-usage-figure">{value.toLocaleString()}</span>;
}

/** "1 conversation" / "4 conversations" — the unit is half the meaning. */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** A date a person would write: the day something first happened. */
function dayOf(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The second line of a folder's row: what it holds, in the fewest parts that
 * stay true. A folder with nothing in it says so rather than showing two
 * zeroes, which read as an error.
 */
export function folderFacts(project: UsageProject): string {
  const parts: string[] = [];
  if (project.chats > 0) parts.push(plural(project.chats, 'conversation', 'conversations'));
  if (project.playtests > 0) parts.push(plural(project.playtests, 'playtest', 'playtests'));
  if (project.changes > 0) parts.push(plural(project.changes, 'change', 'changes'));
  if (parts.length > 0) return parts.join(' · ');
  return project.exists ? 'Nothing recorded in it yet' : 'Nothing left to count';
}

function FolderRow({ project }: { project: UsageProject }) {
  const when = project.lastActivityAt === null ? '' : relativeTime(project.lastActivityAt);
  return (
    <li className={project.exists ? 'set-usage-item' : 'set-usage-item is-gone'}>
      <span className="set-usage-item-name">{project.name}</span>
      <span className="set-usage-item-when">{when}</span>
      <span className="set-usage-item-path" title={project.path}>
        {project.display}
        {!project.exists && <span className="set-usage-gone"> · not on disk any more</span>}
      </span>
      <span className="set-usage-item-facts">{folderFacts(project)}</span>
    </li>
  );
}

/**
 * The whole pane. It reads once, when it mounts — these numbers change on the
 * scale of a working session, not a second, and a settings dialog that keeps
 * re-reading the disk behind you is a worse thing than a slightly old count.
 */
export function UsagePane() {
  const [phase, setPhase] = useState<Phase>('reading');
  const [report, setReport] = useState<UsageReport | null>(null);
  // Bumped by Try again. The read is not retried on its own: a settings dialog
  // that keeps re-reading the disk behind you is worse than a slightly old
  // count, and a read that failed once for a reason of its own would just fail
  // again on a timer nobody asked for.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setPhase('reading');
    const timer = setTimeout(() => {
      if (live) setPhase('failed');
    }, USAGE_TIMEOUT_MS);
    void (async () => {
      const next = await apiUsage();
      if (!live) return;
      clearTimeout(timer);
      // Written even when the deadline has already passed, so a slow read that
      // eventually arrives replaces the failure it caused.
      setReport(next);
      setPhase(next === null ? 'failed' : 'ready');
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [attempt]);

  const totals = report?.totals;
  const skills = report?.skills;

  return (
    <>
      <h2 className="set-pane-title">Usage</h2>
      <p className="set-pane-lead">
        What this copy of Hearth has made, counted from the files on your disk.
      </p>

      {phase === 'reading' && <p className="set-usage-note">Counting what is on disk…</p>}
      {phase === 'failed' && (
        <div className="set-usage-note">
          <p className="set-usage-note-line">
            {report === null
              ? 'Hearth could not read the counts on this machine.'
              : 'The counts below are the last ones Hearth managed to read.'}
          </p>
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}

      {report !== null && totals !== undefined && skills !== undefined && (
        <div className="set-usage-body">
          {/* A fresh install has no folders AND no skills. Skills are counted
              separately from folders — someone who already has Claude Code's
              skills on disk has something to show before they open anything —
              so "nothing yet" has to mean nothing at all, not no folders. */}
          {totals.projects === 0 && skills.total === 0 ? (
            <p className="set-usage-empty">
              Nothing yet. Open a folder, start a conversation, and what you make will be counted here.
            </p>
          ) : (
            <>
              <SettingsGroup title="Across this machine">
                <SettingsRow
                  label="Folders opened"
                  hint={
                    totals.missing > 0
                      ? `Hearth remembers a short list of recent folders, so anything older has dropped off it. ${
                          totals.missing === 1
                            ? 'One of them is'
                            : `${totals.missing.toLocaleString()} of them are`
                        } no longer on disk.`
                      : 'Hearth remembers a short list of recent folders, so anything older has dropped off it.'
                  }
                  control={<Figure value={totals.projects} />}
                />
                <SettingsRow
                  label="Conversations"
                  // NOT "every chat started in those folders", which is what
                  // this said and what it no longer counts. `readChatCounts`
                  // reads the index through `parseChatIndex`, which drops rows
                  // still marked pending, and a chat is pending until someone
                  // speaks into it. New Chat opened and abandoned is therefore
                  // invisible here. That is the better number to show, so the
                  // label is what changed rather than the count.
                  hint="Conversations you actually said something in. One opened and left empty is not counted. They live with the folder, not with the app."
                  control={<Figure value={totals.chats} />}
                />
                <SettingsRow
                  label="Playtests run"
                  hint="Sweeps the probe started, counted by the folder of evidence each one leaves behind."
                  control={<Figure value={totals.playtests} />}
                />
                <SettingsRow
                  label="Changes recorded"
                  hint="Entries in the folders' own journals: edits made through Hearth's commands, by you or by an agent."
                  control={<Figure value={totals.changes} />}
                />
                <SettingsRow
                  label="Skills"
                  hint="Everything on the Skills screen, including the ones found in Claude Code's and codex's folders."
                  control={
                    <span className="set-usage-value">
                      {skills.total === 0
                        ? 'None yet'
                        : `${skills.enabled.toLocaleString()} of ${skills.total.toLocaleString()} switched on`}
                    </span>
                  }
                />
                {report.firstChatAt !== null && (
                  <SettingsRow
                    label="First conversation"
                    hint="The oldest one still on disk in a folder Hearth remembers."
                    control={<span className="set-usage-value">{dayOf(report.firstChatAt)}</span>}
                  />
                )}
              </SettingsGroup>

              {report.projects.length > 0 && (
                <SettingsGroup title="Folder by folder">
                  <ul className="set-usage-list">
                    {report.projects.map((project) => (
                      <FolderRow key={project.path} project={project} />
                    ))}
                  </ul>
                </SettingsGroup>
              )}
            </>
          )}

          <p className="set-usage-foot">
            There is no account behind Hearth and nothing here is metered: no tokens, no requests, no spend.
            These are counts of files in your own folders and in <span className="mono">~/.hearth</span>, read when
            you opened this dialog. None of it is sent anywhere.
          </p>
        </div>
      )}
    </>
  );
}
