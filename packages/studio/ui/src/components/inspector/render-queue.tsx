import { PlusIcon, XIcon } from 'lucide-react';

import type { CompositionInfo, RenderJob, RenderStatus } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatDuration, jobEta, jobPercent } from '@/lib/format';

interface RenderQueueProps {
  comp: CompositionInfo | null;
  jobs: RenderJob[];
  /** Opens the export dialog. */
  onNew(): void;
  onCancel(id: string): Promise<void>;
}

const STATUS_VARIANT: Record<RenderStatus, 'default' | 'secondary' | 'error' | 'outline'> = {
  queued: 'outline',
  running: 'default',
  done: 'secondary',
  failed: 'error',
  cancelled: 'outline',
};

export function RenderQueue({ comp, jobs, onNew, onCancel }: RenderQueueProps) {
  const newestFirst = [...jobs].reverse();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="render-queue">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold">Render queue</span>
        <Button size="sm" disabled={comp === null} onClick={onNew} className="rounded-full px-3.5">
          <PlusIcon />
          New render
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {newestFirst.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-sm">No renders yet.</p>
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
