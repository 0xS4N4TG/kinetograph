import type { PanelProps } from './types';

/** The storyboard panel (docs/proposals/studio-panels.md). Not built yet. */
export function StoryboardPanel({ panel, onDismiss }: PanelProps<'storyboard'>) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      The storyboard panel is not built yet ({panel.id}). <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
