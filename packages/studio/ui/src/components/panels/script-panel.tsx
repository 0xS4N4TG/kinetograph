import type { PanelProps } from './types';

/** The script panel (docs/proposals/studio-panels.md). Not built yet. */
export function ScriptPanel({ panel, onDismiss }: PanelProps<'script'>) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      The script panel is not built yet ({panel.id}). <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
