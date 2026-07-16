import { useEffect } from 'react';
import { hearthNative } from './native';

function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

export function useUnsavedScriptsCloseGuard(hasUnsavedScripts: boolean): void {
  useEffect(() => {
    const native = hearthNative();
    native?.setUnsavedScripts?.(hasUnsavedScripts);
    return () => {
      native?.setUnsavedScripts?.(false);
    };
  }, [hasUnsavedScripts]);

  useEffect(() => {
    if (!hasUnsavedScripts) return;
    // Electron handles close/quit natively via setUnsavedScripts; a renderer
    // beforeunload preventDefault would silently cancel the window close
    // AFTER the user already confirmed "Discard and close" in the native
    // dialog. Browser-only.
    if (hearthNative()) return;
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasUnsavedScripts]);
}
