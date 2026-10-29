import type { ReactElement, ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** A tooltip on one control: `<Hint label="Loop (L)"><Button .../></Hint>`. */
export function Hint({ label, children, side }: { label: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent {...(side ? { side } : {})}>{label}</TooltipContent>
    </Tooltip>
  );
}
