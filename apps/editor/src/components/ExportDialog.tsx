/**
 * Toolbar "Export" dialog: runs the exportWeb command through
 * POST /api/export/web and shows where the build landed.
 */
import React, { useEffect, useState } from 'react';
import { apiExportWeb, type ExportWebData } from '../api';
import { hearthNative } from '../native';
import { useEditor } from '../store';
import { Modal } from './ui';

type Target = 'folder' | 'single';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectPath = useEditor((s) => s.projectPath);
  const log = useEditor((s) => s.log);

  const [target, setTarget] = useState<Target>('folder');
  const [outDir, setOutDir] = useState('export/web');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportWebData | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // Each time the dialog opens it starts from a clean result pane
  // (target/outDir stick around — re-exporting is the common case).
  useEffect(() => {
    if (open) {
      setDone(null);
      setErrors([]);
      setBusy(false);
    }
  }, [open]);

  const native = hearthNative();
  const absoluteOutDir = projectPath && done ? `${projectPath}/${done.outDir}` : null;

  async function runExport() {
    if (!projectPath || busy) return;
    setBusy(true);
    setDone(null);
    setErrors([]);
    try {
      const dir = outDir.trim() || 'export/web';
      const result = await apiExportWeb(projectPath, dir, target === 'single');
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
    <Modal open={open} title="Export for the web" onClose={onClose}>
      <div className="modal-body">
        <div className="form-field">
          <span className="field-label">Target</span>
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
            {native && (
              <button className="btn btn-sm" onClick={() => void native.revealInFolder(absoluteOutDir)}>
                Reveal in folder
              </button>
            )}
            <p className="export-hint">
              For itch.io, <code>hearth export web --zip</code> produces an upload-ready zip.
            </p>
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          {done ? 'Close' : 'Cancel'}
        </button>
        <button className="btn btn-primary" onClick={() => void runExport()} disabled={busy || !projectPath}>
          {busy ? 'Exporting…' : 'Export'}
        </button>
      </div>
    </Modal>
  );
}
