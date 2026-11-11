/**
 * The Remotion / HyperFrames choice, remembered across tab groups and pages. Every `<IconTabs>` that has a Remotion or
 * HyperFrames tab shares one key, so picking HyperFrames once opens HyperFrames everywhere. Reads and writes go through
 * localStorage when it works and a variable when it does not (private windows).
 */
export const ENGINE_KEY = 'kg-docs-engine';
export const ENGINE_ICONS: readonly string[] = ['remotion', 'hyperframes'];

const EVENT = 'kg-docs-engine';
let memory: string | null = null;

/** True when `icon` is one of the two project types. */
export function isEngineIcon(icon?: string): boolean {
  return !!icon && ENGINE_ICONS.includes(icon);
}

/** The remembered project type (`remotion` or `hyperframes`), or null. */
export function readEngine(): string | null {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    if (isEngineIcon(v ?? undefined)) return v;
  } catch {
    // storage blocked: fall through to the variable
  }
  return memory;
}

/** Remember a project type and tell every tab group on the page. */
export function writeEngine(icon: string): void {
  memory = icon;
  try {
    localStorage.setItem(ENGINE_KEY, icon);
  } catch {
    // storage blocked: the variable keeps it for this page view
  }
  window.dispatchEvent(new Event(EVENT));
}

/** For `useSyncExternalStore`: runs `onChange` when this page or another tab changes the choice. */
export function subscribeEngine(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The index of the tab to open: the one whose icon is the remembered type, else the first. */
export function pickTab(icons: readonly (string | undefined)[], remembered: string | null): number {
  const i = remembered ? icons.indexOf(remembered) : -1;
  return i < 0 ? 0 : i;
}
