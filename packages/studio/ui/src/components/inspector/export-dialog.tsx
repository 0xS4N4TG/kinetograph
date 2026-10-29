import { useEffect, useState } from 'react';

import type { CompositionInfo, RenderRequest } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrimBar } from '@/components/inspector/trim-bar';
import { Switch } from '@/components/ui/switch';
import type { Player } from '@/lib/player';

/** `mm:ss.ff` (ff in frames) for a frame number. */
function clock(frame: number, fps: number): string {
  const whole = Math.floor(frame / fps);
  const ff = Math.round(frame - whole * fps);
  const mm = Math.floor(whole / 60);
  return `${String(mm).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
}

/** What a person types for a time: seconds (`2.4`), `mm:ss` or `mm:ss.ff` (ff in frames). Null when it is none of those. */
function parseClock(text: string, fps: number): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * fps);
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) * fps + (m[3] ? Number(m[3]) : 0);
}

const seconds = (frames: number, fps: number) => `${(Math.round((frames / fps) * 10) / 10).toString()} s`;

/** One end of the range: a time field with the frame as a muted hint, and a button that takes the playhead. */
function TimeField({ label, frame, fps, max, onChange, onPlayhead }: { label: string; frame: number; fps: number; max: number; onChange(frame: number): void; onPlayhead(): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseClock(draft, fps) === null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={`export-${label}`}>{label}</Label>
      <Input
        id={`export-${label}`}
        value={draft ?? clock(frame, fps)}
        aria-invalid={invalid}
        className="font-mono"
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseClock(event.target.value, fps);
          if (parsed !== null) onChange(Math.min(max, Math.max(0, parsed)));
        }}
        onBlur={() => setDraft(null)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-[11px]">frame {frame}</span>
        <button type="button" onClick={onPlayhead} className="text-muted-foreground hover:text-foreground rounded-full text-[11px] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Set to playhead
        </button>
      </div>
    </div>
  );
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  comp: CompositionInfo | null;
  /** Whether the props sent with the render differ from the defaults. */
  propsEdited: boolean;
  /** The playhead, for the range shortcuts. */
  player: Player;
  /** The address of a small picture of a frame, for the trim bar. */
  thumbnailUrl?: (frame: number, height: number) => string | null;
  onStart(request: Omit<RenderRequest, 'comp' | 'props'>): Promise<unknown>;
}

/**
 * Export in one place: what is rendered (size, length), the range with shortcuts for the whole film or from or up to the
 * playhead, where the file goes, and draft quality. It opens from the Export button, Cmd+K and the render queue.
 */
export function ExportDialog({ open, onOpenChange, comp, propsEdited, player, thumbnailUrl, onStart }: ExportDialogProps) {
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState<'whole' | 'custom'>('whole');
  const [begin, setBegin] = useState(0);
  const [end, setEnd] = useState(0);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const last = Math.max(0, (comp?.durationInFrames ?? 1) - 1);
  const fps = comp?.fps ?? 30;
  useEffect(() => {
    if (!open) return;
    setError(null);
    setMode('whole');
    setBegin(0);
    setEnd(last);
  }, [open, comp?.id, last]);

  const custom = mode === 'custom';
  const frames = custom ? Math.max(0, end - begin + 1) : (comp?.durationInFrames ?? 0);
  const playhead = () => Math.min(last, Math.max(0, Math.round(player.getState().frame)));
  const setStartTo = (frame: number) => {
    setBegin(frame);
    if (frame > end) setEnd(frame);
  };
  const setEndTo = (frame: number) => {
    setEnd(frame);
    if (frame < begin) setBegin(frame);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const request: Omit<RenderRequest, 'comp' | 'props'> = {};
      if (output.trim() !== '') request.output = output.trim();
      if (custom) request.range = `${begin}..${end}`;
      if (draft) request.draft = true;
      await onStart(request);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const chip = 'bg-muted hover:bg-accent text-muted-foreground hover:text-foreground rounded-full px-3 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export {comp?.id}</DialogTitle>
          <DialogDescription>
            Renders with the props {propsEdited ? 'edited in the Props tab.' : 'the composition ships with.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogPanel className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <div role="radiogroup" aria-label="Range" className="bg-muted flex rounded-full p-1">
                {(['whole', 'custom'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => setMode(value)}
                    className={`focus-visible:ring-ring flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 ${mode === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {value === 'whole' ? 'Whole video' : 'Custom'}
                  </button>
                ))}
              </div>
              {custom && comp && (
                <>
                  <div className="flex gap-3">
                    <TimeField label="Start" frame={begin} fps={fps} max={last} onChange={setStartTo} onPlayhead={() => setStartTo(playhead())} />
                    <TimeField label="End" frame={end} fps={fps} max={last} onChange={setEndTo} onPlayhead={() => setEndTo(playhead())} />
                  </div>
                  <TrimBar
                    comp={comp}
                    start={begin}
                    end={end}
                    onChange={(a, b) => {
                      setBegin(a);
                      setEnd(b);
                    }}
                    {...(thumbnailUrl ? { thumbnailUrl } : {})}
                  />
                </>
              )}
              {comp && (
                <p className="text-muted-foreground font-mono text-xs" data-testid="export-summary">
                  {comp.width}×{comp.height} · {comp.fps} fps · {seconds(frames, fps)}, {frames} frames
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="render-output">Output</Label>
              <Input id="render-output" placeholder={`out/${comp?.id ?? 'composition'}.mp4`} value={output} onChange={(event) => setOutput(event.target.value)} />
              <p className="text-muted-foreground text-xs">Relative to the project folder. Leave empty for the default.</p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="render-draft">Draft (half size)</Label>
                <p className="text-muted-foreground text-xs">Faster to render, for checking timing.</p>
              </div>
              <Switch id="render-draft" checked={draft} onCheckedChange={setDraft} />
            </div>
            {error && <p className="text-destructive-foreground text-sm">{error}</p>}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="rounded-full">
              Cancel
            </Button>
            <Button type="submit" disabled={busy || frames === 0} className="rounded-full px-5">
              Start export
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
