import { useState } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';

import type { CompositionInfo, RenderJob, RenderRequest, RenderStatus } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogPopup,
  DialogPanel,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { formatDuration, jobEta, jobPercent } from '@/lib/format';

interface RenderQueueProps {
  comp: CompositionInfo | null;
  jobs: RenderJob[];
  /** Whether the props sent with a render differ from the defaults. */
  propsEdited: boolean;
  onStart(request: Omit<RenderRequest, 'comp' | 'props'>): Promise<unknown>;
  onCancel(id: string): Promise<void>;
}

const STATUS_VARIANT: Record<RenderStatus, 'default' | 'secondary' | 'error' | 'outline'> = {
  queued: 'outline',
  running: 'default',
  done: 'secondary',
  failed: 'error',
  cancelled: 'outline',
};

export function RenderQueue({ comp, jobs, propsEdited, onStart, onCancel }: RenderQueueProps) {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState('');
  const [range, setRange] = useState('');
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const request: Omit<RenderRequest, 'comp' | 'props'> = {};
      if (output.trim() !== '') request.output = output.trim();
      if (range.trim() !== '') request.range = range.trim();
      if (draft) request.draft = true;
      await onStart(request);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const newestFirst = [...jobs].reverse();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="render-queue">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold">Render queue</span>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) setError(null);
          }}
        >
          <DialogTrigger
            render={
              <Button size="sm" disabled={comp === null} className="rounded-full px-3.5">
                <PlusIcon />
                New render
              </Button>
            }
          />
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Render {comp?.id}</DialogTitle>
              <DialogDescription>
                Queues a render of this composition
                {propsEdited ? ' with the props edited in the Props tab.' : ' with its default props.'}
              </DialogDescription>
            </DialogHeader>
            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <DialogPanel className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="render-output">Output</Label>
                <Input
                  id="render-output"
                  placeholder={`out/${comp?.id ?? 'composition'}.mp4`}
                  value={output}
                  onChange={(event) => setOutput(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="render-range">Range</Label>
                <Input
                  id="render-range"
                  placeholder={comp ? `0..${comp.durationInFrames - 1}` : '0..99'}
                  value={range}
                  onChange={(event) => setRange(event.target.value)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="render-draft">Draft (half size)</Label>
                <Switch id="render-draft" checked={draft} onCheckedChange={setDraft} />
              </div>
              {error && <p className="text-destructive-foreground text-sm">{error}</p>}
              </DialogPanel>
              <DialogFooter>
                <Button type="submit" disabled={busy}>
                  Start render
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {newestFirst.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-sm">No renders yet. Press Export to queue one.</p>
        ) : (
          <ul className="flex flex-col gap-3 px-3 pb-4">
            {newestFirst.map((job) => (
              <JobItem key={job.id} job={job} onCancel={onCancel} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function JobItem({ job, onCancel }: { job: RenderJob; onCancel(id: string): Promise<void> }) {
  const active = job.status === 'queued' || job.status === 'running';
  const eta = jobEta(job);
  return (
    <li data-testid={`render-job-${job.id}`} className="bg-muted/60 flex flex-col gap-2.5 rounded-xl p-3.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">
          #{job.id} {job.comp}
        </span>
        <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
        <span className="text-muted-foreground ml-auto font-mono text-xs">
          {job.range[0]}..{job.range[1]}
        </span>
        {active && (
          <Button variant="ghost" size="icon-sm" aria-label={`Cancel render ${job.id}`} onClick={() => void onCancel(job.id)}>
            <XIcon />
          </Button>
        )}
      </div>
      {(active || job.status === 'done') && (
        <>
          <Progress value={jobPercent(job)} aria-label={`Render ${job.id} progress`} />
          <div className="text-muted-foreground flex justify-between font-mono text-xs">
            <span>
              {job.framesDone} / {job.framesTotal} frames
            </span>
            {active && eta !== null && <span>ETA {formatDuration(eta)}</span>}
            {job.status === 'done' && job.msPerFrame !== null && <span>{job.msPerFrame.toFixed(1)} ms/frame</span>}
          </div>
        </>
      )}
      <p className="text-muted-foreground font-mono text-xs break-all select-all" title="Output file">
        {job.output}
      </p>
      {job.error && (
        <p className="text-destructive-foreground text-xs">
          {job.error.code}: {job.error.message}
        </p>
      )}
    </li>
  );
}
