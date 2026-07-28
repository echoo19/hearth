/**
 * The visible half of the toast slot.
 *
 * Sits above the composer rather than in a screen corner, because everything
 * it has to say is about the message someone just tried to send, and that is
 * where they are looking. Announced politely so a screen reader hears it
 * without having the current sentence interrupted.
 *
 * There is no queue and no stack, so this renders one card or nothing.
 */
import { useSyncExternalStore } from 'react';
import { Icon } from '../ui';
import { IconButton } from './Button';
import { currentToast, dismissToast, subscribeToast } from '../../toast';

export function ToastHost() {
  const toast = useSyncExternalStore(subscribeToast, currentToast, () => null);
  if (!toast) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      <div className={`toast is-${toast.tone}`} key={toast.id}>
        {toast.tone === 'error' && (
          <span className="toast-mark" aria-hidden="true">
            <Icon name="warning" size={12} />
          </span>
        )}
        <p className="toast-text">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              const run = toast.action?.run;
              dismissToast();
              run?.();
            }}
          >
            {toast.action.label}
          </button>
        )}
        <IconButton icon="cross" label="Dismiss" iconSize={11} className="toast-close" onClick={dismissToast} />
      </div>
    </div>
  );
}
