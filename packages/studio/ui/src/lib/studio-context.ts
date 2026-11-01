import { createContext, useContext } from 'react';

import type { Studio } from '@/studio';

/** The studio's store, for components that sit outside the layout's props (the panels the agent opens). */
export const StudioContext = createContext<Studio | null>(null);

export function useStudioContext(): Studio | null {
  return useContext(StudioContext);
}
