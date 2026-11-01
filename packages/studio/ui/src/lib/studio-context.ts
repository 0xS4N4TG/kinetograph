import { createContext, useContext } from 'react';

import type { Studio } from '@/studio';

/** The studio's store, for components that sit outside the layout's props (the panels the agent opens). */
export const StudioContext = createContext<Studio | null>(null);

export function useStudioContext(): Studio | null {
  return useContext(StudioContext);
}

/** The id of the build the studio shows (0 before the first). A picture's address carries it, so a rebuild loads the picture again. */
export function useBuildId(): number {
  return useContext(StudioContext)?.buildId ?? 0;
}
