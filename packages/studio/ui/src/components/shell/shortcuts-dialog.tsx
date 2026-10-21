import { Fragment } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const SHORTCUTS: { group: string; rows: [keys: string, action: string][] }[] = [
  {
    group: 'Playback',
    rows: [
      ['Space', 'Play or pause'],
      ['← / →', 'Previous or next frame (Shift: 10 frames)'],
      ['Home / End', 'First or last frame'],
      ['L', 'Loop on or off'],
    ],
  },
  {
    group: 'Tools',
    rows: [
      ['V', 'Selection: click a layer in the viewer to select it'],
      ['H', 'Hand: drag to pan the viewer'],
      ['Z', 'Zoom: click to zoom in, Alt-click to zoom out'],
    ],
  },
  {
    group: 'View',
    rows: [
      ['0', 'Fit the frame to the viewer'],
      ['1', 'Show the frame at 100%'],
    ],
  },
  {
    group: 'Timeline',
    rows: [
      ['Click or drag', 'Move the playhead in the ruler or any row'],
      ['Ctrl / ⌘ + wheel', 'Zoom the time axis'],
    ],
  },
  { group: 'Help', rows: [['?', 'Show this list']] },
];

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>The keys do nothing while a field or a menu has focus.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-xs">
          {SHORTCUTS.map(({ group, rows }) => (
            <section key={group} className="flex flex-col gap-1.5">
              <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{group}</h3>
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5">
                {rows.map(([keys, action]) => (
                  <Fragment key={keys}>
                    <dt>
                      <kbd className="bg-muted rounded-xs px-1.5 py-0.5 font-mono text-[11px]">{keys}</kbd>
                    </dt>
                    <dd className="text-muted-foreground">{action}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
