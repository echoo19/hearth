/**
 * Toolbar "Export" dialog. A Web/Desktop segmented control switches between:
 *  - Web: the static playable build (POST /api/export/web), with an optional
 *    itch.io-ready zip.
 *  - Desktop: native Electron builds per platform (POST /api/export/desktop),
 *    a background job whose progress streams over the ws (see exportJob.ts).
 */
import React, { useEffect, useState } from 'react';
import { apiExportCapability, apiExportDesktop, apiExportWeb, type ExportWebData } from '../api';
import { hearthNative } from '../native';
import { useEditor } from '../store';
import type { DesktopPlatform, ExportCapability } from '../types';
import {
  ALL_DESKTOP_PLATFORMS,
  defaultPlatformSelection,
  desktopExportPlatforms,
  getExportJobSnapshot,
  platformLabel,
  reopenMode,
  resolveOutDir,
  signingStatusLabel,
  stageLabel,
  startExportJob,
  startResultMessage,
  useExportJob,
  webExportArgs,
  type PlatformRow,
  type PlatformSelection,
} from './exportJob';
import { Modal } from './ui';
import { Button } from './ui/Button';

type Mode = 'web' | 'desktop';
type WebTarget = 'folder' | 'single';

/**
 * Whether the dialog's native `cancel` event (Escape) should be blocked —
 * mirrors the disabled Cancel button, so keyboard and mouse users get the
 * same "can't dismiss mid-export" contract instead of Escape silently
 * closing the one place a live desktop build's progress is shown
 * (EXPORTDIALOG-1 / L-099). Pulled to module scope, pure, so the decision is
 * unit-tested without a DOM (this repo has no jsdom/RTL).
 */
export function blocksDialogCancel(jobRunning: boolean): boolean {
  return jobRunning;
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectPath = useEditor((s) => s.projectPath);
  const jobRunning = useExportJob().running;

  const [mode, setMode] = useState<Mode>('web');

  // Each open lands on the Web tab unless a desktop job is live OR finished
  // while the dialog was closed — either way the Desktop pane resurfaces so
  // in-flight progress / completed results (zip paths) are what the user sees.
  useEffect(() => {
    if (!open) return;
    setMode(reopenMode(getExportJobSnapshot()));
  }, [open]);

  // The segmented control and the panes' own Cancel/Close button are already
  // disabled while a desktop export runs (see DesktopPane below), but Escape
  // fires the native `<dialog>` `cancel` event, which Modal wires straight to
  // onClose — unguarded, that dismisses the dialog out from under a live
  // build with no confirmation, inconsistent with mouse users being blocked
  // (EXPORTDIALOG-1 / L-099). Just as important: since this handler runs as
  // the dialog's `cancel` listener, declining to call the real `onClose`
  // ISN'T enough on its own — the native default action still closes the
  // `<dialog>` element regardless, so `preventDefault()` on the event is
  // what actually stops it.
  function guardedClose(e?: React.SyntheticEvent) {
    if (blocksDialogCancel(jobRunning)) {
      e?.preventDefault();
      return;
    }
    onClose();
  }

  return (
    <Modal open={open} title="Export" onClose={guardedClose}>
      {/* A running desktop job locks the tab so its progress can't be navigated away from. */}
      <ModeSwitch mode={mode} onChange={setMode} disabled={jobRunning} />
      <div role="tabpanel" id={`export-pane-${mode}`} aria-labelledby={`export-tab-${mode}`}>
        {mode === 'web' ? (
          <WebPane projectPath={projectPath} open={open} onClose={onClose} />
        ) : (
          <DesktopPane projectPath={projectPath} open={open} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Segmented Web / Desktop control
// ---------------------------------------------------------------------------

function ModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  const order: Mode[] = ['web', 'desktop'];
  const labels: Record<Mode, string> = { web: 'Web', desktop: 'Desktop' };
  return (
    <div
      className="segmented"
      role="tablist"
      aria-label="Export target"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = order.indexOf(mode);
        const next = e.key === 'ArrowRight' ? (i + 1) % order.length : (i + order.length - 1) % order.length;
        if (!disabled) onChange(order[next]);
      }}
    >
      {order.map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          id={`export-tab-${m}`}
          aria-controls={`export-pane-${m}`}
          aria-selected={mode === m}
          tabIndex={mode === m ? 0 : -1}
          className={`seg-btn${mode === m ? ' active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(m)}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Web pane
// ---------------------------------------------------------------------------

function WebPane({
  projectPath,
  open,
  onClose,
}: {
  projectPath: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const log = useEditor((s) => s.log);
  const [target, setTarget] = useState<WebTarget>('folder');
  const [outDir, setOutDir] = useState('export/web');
  const [zip, setZip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportWebData | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setErrors([]);
    setBusy(false);
  }, [open]);

  const native = hearthNative();
  const absoluteOutDir = projectPath && done ? `${projectPath}/${done.outDir}` : null;
  const absoluteZip = projectPath && done?.zip ? `${projectPath}/${done.zip}` : null;

  async function runExport() {
    if (!projectPath || busy) return;
    setBusy(true);
    setDone(null);
    setErrors([]);
    try {
      const args = webExportArgs(target, outDir, zip);
      const result = await apiExportWeb(projectPath, args.outDir, args.singleFile, args.zip);
      if (result.success && result.data) {
        setDone(result.data);
        log('info', 'command', `exportWeb: wrote ${result.data.files.length} file(s) to ${result.data.outDir}`);
      } else {
        const messages = result.errors.map((e) => e.message);
        setErrors(messages.length > 0 ? messages : ['Export failed.']);
        for (const message of messages) log('error', 'command', `exportWeb: ${message}`);
      }
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-body">
        <div className="form-field">
          <span className="field-label">Format</span>
          <label className="radio-row">
            <input
              type="radio"
              name="export-target"
              checked={target === 'folder'}
              disabled={busy}
              onChange={() => setTarget('folder')}
            />
            <span>
              Web build folder
              <span className="radio-detail">index.html + player + assets, ready for any static host</span>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="export-target"
              checked={target === 'single'}
              disabled={busy}
              onChange={() => setTarget('single')}
            />
            <span>
              Single HTML file
              <span className="radio-detail">one index.html with everything inlined</span>
            </span>
          </label>
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="export-outdir">
            Output directory (project-relative)
          </label>
          <input
            id="export-outdir"
            className="input mono"
            value={outDir}
            disabled={busy}
            onChange={(e) => setOutDir(e.target.value)}
            placeholder="export/web"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runExport();
            }}
          />
        </div>

        <label className="check-row">
          <input type="checkbox" checked={zip} disabled={busy} onChange={(e) => setZip(e.target.checked)} />
          <span>
            Zip for itch.io
            <span className="radio-detail">also write an upload-ready <code>{'<title>'}-web.zip</code></span>
          </span>
        </label>

        {errors.length > 0 && (
          <div className="export-errors" role="alert">
            {errors.map((message, i) => (
              <p key={i}>{message}</p>
            ))}
          </div>
        )}

        {done && absoluteOutDir && (
          <div className="export-result">
            <p>
              Exported {done.files.length} file{done.files.length === 1 ? '' : 's'}:
            </p>
            <span className="mono export-path" title={absoluteOutDir}>
              {absoluteOutDir}
            </span>
            {absoluteZip && (
              <div className="export-zip-line">
                <span className="mono export-path" title={absoluteZip}>
                  {absoluteZip}
                </span>
                <CopyButton text={absoluteZip} />
              </div>
            )}
            {native && (
              <Button size="sm" onClick={() => void native.revealInFolder(absoluteOutDir)}>
                Reveal in folder
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="modal-actions">
        <Button onClick={onClose} disabled={busy}>
          {done ? 'Close' : 'Cancel'}
        </Button>
        <Button variant="primary" onClick={() => void runExport()} disabled={busy || !projectPath}>
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop pane
// ---------------------------------------------------------------------------

function DesktopPane({
  projectPath,
  open,
  onClose,
}: {
  projectPath: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const log = useEditor((s) => s.log);
  const job = useExportJob();

  // undefined = capability not fetched yet; null = fetch failed.
  const [capability, setCapability] = useState<ExportCapability | null | undefined>(undefined);
  const [platforms, setPlatforms] = useState<DesktopPlatform[]>(ALL_DESKTOP_PLATFORMS);
  const [selection, setSelection] = useState<PlatformSelection>(() =>
    defaultPlatformSelection(ALL_DESKTOP_PLATFORMS),
  );
  const [outDir, setOutDir] = useState('export/desktop');
  const [alreadyRunning, setAlreadyRunning] = useState<string | null>(null);

  // Fetch signing capability + the offered platform ids when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setAlreadyRunning(null);
    // Deliberately NO job reset here: a finished job's rows (zip paths, per-
    // platform errors, the banner) persist across close/reopen until the user
    // starts a new export — the reducer's 'start' action reseeds them. A
    // reset-on-open would wipe results a user never saw when the job finished
    // while the dialog was closed.
    let cancelled = false;
    void apiExportCapability().then((cap) => {
      if (cancelled) return;
      setCapability(cap);
      if (cap) {
        setPlatforms(cap.platforms);
        setSelection(defaultPlatformSelection(cap.platforms));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const running = job.running;
  const selected = desktopExportPlatforms(selection, platforms);
  const canExport = !!projectPath && !running && selected.length > 0;

  async function runExport() {
    if (!canExport) return;
    setAlreadyRunning(null);
    const dir = resolveOutDir(outDir, 'export/desktop');
    const result = await apiExportDesktop(projectPath!, dir, selected);
    const message = startResultMessage(result);
    if (message) {
      setAlreadyRunning(message);
      return;
    }
    startExportJob(result.jobId!, selected);
    log('info', 'command', `exportDesktop: building ${selected.length} platform${selected.length === 1 ? '' : 's'}`);
  }

  const rows = job.order.map((p) => job.rows[p]).filter(Boolean);
  const finished = job.finished && !running;

  return (
    <>
      <div className="modal-body">
        <div className="form-field">
          <span className="field-label">Platforms</span>
          <div className="platform-grid">
            {platforms.map((platform) => (
              <label key={platform} className="check-row check-row-compact">
                <input
                  type="checkbox"
                  checked={!!selection[platform]}
                  disabled={running}
                  onChange={(e) => setSelection((s) => ({ ...s, [platform]: e.target.checked }))}
                />
                <span>{platformLabel(platform)}</span>
              </label>
            ))}
          </div>
          {selected.length === 0 && <p className="field-note">Pick at least one platform.</p>}
        </div>

        <div className="form-field">
          <label className="field-label" htmlFor="desktop-outdir">
            Output directory (project-relative)
          </label>
          <input
            id="desktop-outdir"
            className="input mono"
            value={outDir}
            disabled={running}
            onChange={(e) => setOutDir(e.target.value)}
            placeholder="export/desktop"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runExport();
            }}
          />
        </div>

        <p className="signing-status">
          <SigningIcon />
          {capability === undefined
            ? 'Checking signing…'
            : capability === null
              ? 'Signing status unavailable — builds will be ad-hoc signed.'
              : signingStatusLabel(capability.capability)}
        </p>

        {alreadyRunning && (
          <div className="export-errors" role="alert">
            <p>{alreadyRunning}</p>
          </div>
        )}

        {job.bannerError && (
          <div className="export-errors" role="alert">
            <p>{job.bannerError}</p>
          </div>
        )}

        {job.globalMessage && running && <p className="export-global-msg">{job.globalMessage}</p>}

        {rows.length > 0 && (
          <ul className="export-progress-list">
            {rows.map((row) => (
              <ProgressRow key={row.platform} row={row} active={running && job.activePlatform === row.platform} projectPath={projectPath} />
            ))}
          </ul>
        )}
      </div>
      <div className="modal-actions">
        <Button onClick={onClose} disabled={running}>
          {finished ? 'Close' : 'Cancel'}
        </Button>
        <Button variant="primary" onClick={() => void runExport()} disabled={!canExport}>
          {running ? 'Building…' : finished ? 'Export again' : 'Export'}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-platform progress / result row
// ---------------------------------------------------------------------------

function ProgressRow({
  row,
  active,
  projectPath,
}: {
  row: PlatformRow;
  active: boolean;
  projectPath: string | null;
}) {
  const zipAbs = projectPath && row.zip ? `${projectPath}/${row.zip}` : row.zip;
  return (
    <li className={`export-row status-${row.status}${active ? ' active' : ''}`}>
      <div className="export-row-head">
        <span className="export-row-name">{platformLabel(row.platform)}</span>
        <RowBadge row={row} />
      </div>
      {row.status === 'error' ? (
        <p className="export-row-error">{row.error}</p>
      ) : row.status === 'success' ? (
        zipAbs && (
          <div className="export-row-success">
            <span className="mono export-path" title={zipAbs}>
              {zipAbs}
            </span>
            <CopyButton text={zipAbs} />
          </div>
        )
      ) : (
        <p className="export-row-progress">
          {row.stage ? <span className="export-row-stage">{stageLabel(row.stage)}</span> : null}
          {row.message && <span className="export-row-msg">{row.message}</span>}
        </p>
      )}
    </li>
  );
}

function RowBadge({ row }: { row: PlatformRow }) {
  if (row.status === 'error') return <span className="export-badge badge-error">Failed</span>;
  if (row.status === 'success') {
    const signLabel = row.notarized ? 'notarized' : row.signed === 'identity' ? 'signed' : row.signed === 'adhoc' ? 'ad-hoc' : 'unsigned';
    return (
      <span className="export-badge badge-success">
        Done<span className="badge-sub"> · {signLabel}</span>
      </span>
    );
  }
  if (row.status === 'running') return <span className="export-badge badge-running">Building</span>;
  return <span className="export-badge badge-pending">Queued</span>;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : 'Copy path'}
    </Button>
  );
}

function SigningIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 1.5 2 3v3c0 2.2 1.6 3.7 4 4.5 2.4-.8 4-2.3 4-4.5V3L6 1.5Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
