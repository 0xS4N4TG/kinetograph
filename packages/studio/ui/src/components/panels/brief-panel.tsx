import { TriangleAlertIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';

import { References } from './brief-references';
import { briefOf, filled, formOf, MAX_REFERENCES, MIN_REFERENCES, PLATFORMS, presetOf, problems, warnings, type BriefForm } from './brief-model';
import type { PanelProps, Platform } from './types';

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <span className="text-muted-foreground text-[11px]">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="text-warning-foreground flex items-start gap-1.5 text-xs" role="status" data-testid="warning">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** The brief panel (docs/proposals/studio-panels.md): the agent's draft, for the person to correct and approve. */
export function BriefPanel({ panel, onSubmit, onDismiss }: PanelProps<'brief'>) {
  const [form, setForm] = useState<BriefForm>(() => formOf(panel.data));
  const set = (change: Partial<BriefForm>) => setForm((f) => ({ ...f, ...change }));

  const choosePlatform = (platform: Platform) => {
    if (platform === 'custom') return set({ platform });
    const { width, height, fps } = presetOf(platform).size;
    set({ platform, width: String(width), height: String(height), fps: String(fps) });
  };
  /** A hand-edited width or height is no longer the platform's size. */
  const setDimension = (key: 'width' | 'height', value: string) => set({ [key]: value, platform: 'custom' });

  const blocking = problems(form);
  const notes = warnings(form);
  const warn = (field: 'takeaway' | 'seconds' | 'references') => notes.filter((n) => n.field === field).map((n) => <Warning key={n.text}>{n.text}</Warning>);
  const count = filled(form.refs).length;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="brief-panel">
      <header className="flex flex-col gap-1 border-b px-5 py-3">
        <h2 className="text-base font-semibold">Brief</h2>
        <p className="text-muted-foreground text-xs">
          {panel.message ?? 'The agent filled in what it knows. Correct anything that is off, then approve.'}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <Field label="Purpose" htmlFor="brief-purpose" hint="what it is for">
            <Input id="brief-purpose" value={form.purpose} placeholder="Launch ad for the plugin store" aria-invalid={form.purpose.trim() === ''} onChange={(e) => set({ purpose: e.target.value })} />
          </Field>

          <Field label="Audience" htmlFor="brief-audience" hint="who watches it">
            <Input id="brief-audience" value={form.audience} placeholder="Motion designers who already use Remotion" onChange={(e) => set({ audience: e.target.value })} />
          </Field>

          <Field label="Platform">
            <SegmentedControl aria-label="Platform" className="max-w-full flex-wrap">
              {PLATFORMS.map((p) => (
                <SegmentedControlItem key={p.id} aria-pressed={form.platform === p.id} data-checked={form.platform === p.id ? '' : undefined} onClick={() => choosePlatform(p.id)}>
                  {p.label}
                  {p.ratio ? <span className="text-muted-foreground/72 font-mono text-[11px]">{p.ratio}</span> : null}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Width" htmlFor="brief-width" hint="px">
              <Input id="brief-width" type="number" min={1} className="font-mono" value={form.width} onChange={(e) => setDimension('width', e.target.value)} />
            </Field>
            <Field label="Height" htmlFor="brief-height" hint="px">
              <Input id="brief-height" type="number" min={1} className="font-mono" value={form.height} onChange={(e) => setDimension('height', e.target.value)} />
            </Field>
            <Field label="Frame rate" htmlFor="brief-fps" hint="fps">
              <Input id="brief-fps" type="number" min={1} className="font-mono" value={form.fps} onChange={(e) => set({ fps: e.target.value })} />
            </Field>
            <Field label="Length" htmlFor="brief-seconds" hint="seconds">
              <Input id="brief-seconds" type="number" min={1} className="font-mono" value={form.seconds} onChange={(e) => set({ seconds: e.target.value })} />
            </Field>
          </div>
          {warn('seconds')}

          <Field label="Takeaway" htmlFor="brief-takeaway" hint="the one thing a viewer should leave with">
            <Textarea id="brief-takeaway" value={form.takeaway} placeholder="Plugins make any look one line of code." onChange={(e) => set({ takeaway: e.target.value })} />
          </Field>
          {warn('takeaway')}

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label>References</Label>
              <Badge variant={count >= MIN_REFERENCES && count <= MAX_REFERENCES ? 'success' : 'warning'}>
                {count} of {MIN_REFERENCES} to {MAX_REFERENCES}
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              Videos or pictures whose look you like. A link stays a note; a file is copied into the project, and a video gets a contact sheet the agent can look at.
            </p>
            <References rows={form.refs} onChange={(update) => setForm((f) => ({ ...f, refs: update(f.refs) }))} />
            {warn('references')}
          </div>

          <Field label="Notes" htmlFor="brief-notes" hint="optional">
            <Textarea id="brief-notes" value={form.notes} placeholder="Brand colours, words to avoid, music…" onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t px-5 py-3">
        <p className="text-muted-foreground min-w-0 truncate text-xs" data-testid="blocking">
          {blocking[0] ?? (notes.length > 0 ? `${notes.length} thing${notes.length === 1 ? '' : 's'} to look at, none of them blocking.` : '')}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button disabled={blocking.length > 0} onClick={() => onSubmit(briefOf(form))}>
            Approve brief
          </Button>
        </div>
      </footer>
    </div>
  );
}
