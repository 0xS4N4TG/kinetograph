import type { PanelProps } from './types';

/** The styleframes panel (docs/proposals/studio-panels.md). Not built yet. */
export function StyleframesPanel({ panel, onDismiss }: PanelProps<'styleframes'>) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      The styleframes panel is not built yet ({panel.id}). <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
