const GUIDE_VERSION = 1;

type GuideStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function agentGuideStorageKey(projectPath: string): string {
  return `hearth.agentGuide.${GUIDE_VERSION}.${projectPath}`;
}

export function isAgentGuideDismissed(projectPath: string, storage: GuideStorage = localStorage): boolean {
  try {
    return storage.getItem(agentGuideStorageKey(projectPath)) === '1';
  } catch {
    return false;
  }
}

export function dismissAgentGuide(projectPath: string, storage: GuideStorage = localStorage): void {
  try {
    storage.setItem(agentGuideStorageKey(projectPath), '1');
  } catch {
    // Private browsing or disabled storage: dismissal remains session-local.
  }
}
