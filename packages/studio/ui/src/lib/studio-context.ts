import { createContext } from 'react';

import type { Studio } from '@/studio';

/** The studio's state for a component that cannot be handed it as props (a panel the agent opened); null outside `App`. */
export const StudioContext = createContext<Studio | null>(null);
