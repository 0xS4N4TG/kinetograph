import type { PanelProps } from './types';

/** The review panel (docs/proposals/studio-panels.md). Not built yet. */
export function ReviewPanel({ panel, onDismiss }: PanelProps<'review'>) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      The review panel is not built yet ({panel.id}). <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
