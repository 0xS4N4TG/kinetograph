import { useStudioContext } from '@/lib/studio-context';

import { ReviewView } from './review-view';
import type { PanelProps } from './types';

/**
 * The review panel (docs/proposals/studio-panels.md): timestamped notes on a composition, tied to an area of the frame
 * when wanted. A narrow column that leaves the preview in view; it needs the studio's store through `StudioContext`.
 */
export function ReviewPanel(props: PanelProps<'review'>) {
  const studio = useStudioContext();
  if (!studio) {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        The review needs the studio. <button onClick={props.onDismiss}>Dismiss</button>
      </div>
    );
  }
  return <ReviewView {...props} store={studio} />;
}
