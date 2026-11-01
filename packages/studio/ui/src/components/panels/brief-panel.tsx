import type { PanelProps } from './types';

/** The brief panel (docs/proposals/studio-panels.md). Not built yet. */
export function BriefPanel({ panel, onDismiss }: PanelProps<'brief'>) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      The brief panel is not built yet ({panel.id}). <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
