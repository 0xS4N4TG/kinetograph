import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ClipboardCopyIcon, DownloadIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';

import type { MattingJob, MattingModelInfo, MattingQuality, MattingStatus, StudioApi } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { copyText } from '@/lib/clipboard';
import type { InspectLayer } from '@/lib/inspect';
import {
  DEFAULT_MODEL,
  DEFAULT_QUALITY,
  QUALITIES,
  defaultOutputName,
  downloadOf,
  fileNameOf,
  formatSize,
  isLocalFile,
  jobLine,
  modelLabel,
  outputProblem,
  percent,
  sourceChange,
} from '@/lib/matting';

export interface RemoveBackgroundDialogProps {
  /** The video layer to work on; the dialog is open while there is one. */
  layer: InspectLayer | null;
  onClose(): void;
  api: StudioApi;
  /** The jobs the server reports, newest state of each. */
  jobs: MattingJob[];
  /**
   * The file is written: asks the agent to point the layer at `public/<staticName>`. Returns whether the message went,
   * and the text of the request (to copy when it did not).
   */
  onSwapSource(layer: InspectLayer, staticName: string): { sent: boolean; text: string };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One model of the Models tab: what it is, whether it is on this computer, and how to get it or drop it. */
function ModelRow({ model, job, busy, onDownload, onRemove, onCancel }: { model: MattingModelInfo; job: MattingJob | undefined; busy: boolean; onDownload(): void; onRemove(): void; onCancel(): void }) {
  const pct = job ? percent(job.progress) : null;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`model-${model.name}`}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            {model.name}
            {model.cached ? <Badge variant="success">Downloaded</Badge> : <Badge variant="outline">Not downloaded</Badge>}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {formatSize(model.size)} · {model.purpose}
          </span>
        </div>
        {job ? (
          <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onCancel}>
            Cancel
          </Button>
        ) : model.cached ? (
          <Button type="button" variant="ghost" size="sm" className="rounded-full" disabled={busy} onClick={onRemove} aria-label={`Remove ${model.name}`}>
            <Trash2Icon />
            Remove
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={onDownload} aria-label={`Download ${model.name}`}>
            <DownloadIcon />
            Download
          </Button>
        )}
      </div>
      {job && (
        <Progress value={pct} aria-label={`Downloading ${model.name}`}>
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
          <span className="text-muted-foreground text-xs">{jobLine(job)}</span>
        </Progress>
      )}
    </li>
  );
}

/**
 * "Remove background from <file>": options as Remotion's Studio has them (the file in public/, the model, the audio and
 * the video quality), a Models tab to download or remove the models, then progress, and at the end the swap of the
 * video's source. Studio does not edit project code, so the swap is a ready-made request sent to the agent.
 */
export function RemoveBackgroundDialog({ layer, onClose, api, jobs, onSwapSource }: RemoveBackgroundDialogProps) {
  const open = layer !== null;
  const src = layer?.src ?? '';
  const [status, setStatus] = useState<MattingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [keepAudio, setKeepAudio] = useState(true);
  const [quality, setQuality] = useState<MattingQuality>(DEFAULT_QUALITY);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [swap, setSwap] = useState<{ sent: boolean; text: string; staticName: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const swapped = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.matting();
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (cause) {
      setLoadError(messageOf(cause));
      return null;
    }
  }, [api]);

  // Each time it opens: a clean form for this file, and what the server says about the models.
  useEffect(() => {
    if (!layer) return;
    setOutput(defaultOutputName(layer.src ?? ''));
    setModel(DEFAULT_MODEL);
    setKeepAudio(true);
    setQuality(DEFAULT_QUALITY);
    setError(null);
    setModelError(null);
    setRunId(null);
    setSwap(null);
    setCopied(false);
    swapped.current = null;
    setStatus(null);
    void refresh();
    // A new layer or a reopened dialog; `refresh` is stable per api.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.id, open]);

  // A finished download changes what is cached.
  const finished = jobs.filter((j) => j.kind === 'download' && j.status !== 'running').map((j) => `${j.id}:${j.status}`).join(',');
  useEffect(() => {
    if (open && finished !== '') void refresh();
  }, [finished, open, refresh]);

  // A removal that is already running (the window was reloaded meanwhile) is picked up again.
  const run = useMemo(() => jobs.find((j) => j.id === runId) ?? (runId === null && open ? jobs.find((j) => j.kind === 'matte' && j.status === 'running') : undefined), [jobs, runId, open]);
  const running = run?.status === 'running';

  // The file is written: ask the agent to point the video at it, once.
  useEffect(() => {
    if (!layer || !run || run.kind !== 'matte' || run.status !== 'done' || !run.staticName || swapped.current === run.id) return;
    swapped.current = run.id;
    setSwap({ ...onSwapSource(layer, run.staticName), staticName: run.staticName });
  }, [layer, run, onSwapSource]);

  const available = status?.available === true;
  const local = isLocalFile(src);
  const problem = outputProblem(output);
  const chosen = status?.models.find((m) => m.name === model);
  const modelItems = (status?.models ?? []).map((m) => ({ value: m.name, label: modelLabel(m) }));
  const downloading = (name: string) => downloadOf(jobs, name);

  const start = async () => {
    if (!layer || problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api.startMatting({ input: src, output: output.trim(), model, audio: keepAudio ? 'keep' : 'drop', quality });
      setRunId(job.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const act = async (task: () => Promise<unknown>) => {
    setModelError(null);
    try {
      await task();
      await refresh();
    } catch (cause) {
      setModelError(messageOf(cause));
    }
  };
  const cancel = (id: string) => void act(() => api.cancelMatting(id));
  const failed = run?.status === 'failed' ? run.error?.message ?? 'The background could not be removed.' : null;
  const change = swap ? sourceChange(swap.staticName) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove background from {fileNameOf(src)}</DialogTitle>
          <DialogDescription>Makes a copy of the video with a transparent background, in public/, and points the layer at it. The original is kept.</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogPanel className="flex flex-col gap-4">
            {loadError && (
              <Alert variant="error">
                <TriangleAlertIcon />
                <AlertTitle>The studio did not answer</AlertTitle>
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            )}
            {status && !status.available && (
              <Alert variant="warning" data-testid="matting-unavailable">
                <TriangleAlertIcon />
                <AlertTitle>Background removal is not available</AlertTitle>
                <AlertDescription>{status.message}</AlertDescription>
              </Alert>
            )}
            {!local && (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>This video is not a file on this computer</AlertTitle>
                <AlertDescription>{src}. Download it into public/ and use that file.</AlertDescription>
              </Alert>
            )}
            <Tabs defaultValue="general">
              <TabsList className="self-start">
                <TabsTab value="general">General</TabsTab>
                <TabsTab value="models">Models</TabsTab>
              </TabsList>
              <TabsPanel value="general" className="flex flex-col gap-4 pt-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="matting-output">Output in public/</Label>
                  <Input id="matting-output" value={output} disabled={running} aria-invalid={problem !== null} onChange={(event) => setOutput(event.target.value)} />
                  {problem && output !== '' && <p className="text-destructive-foreground text-xs">{problem}</p>}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="matting-model">Model</Label>
                  <Select items={modelItems} value={model} disabled={running || modelItems.length === 0} onValueChange={(next) => next && setModel(next)}>
                    <SelectTrigger id="matting-model" aria-label="Model">
                      <SelectValue placeholder={DEFAULT_MODEL} />
                    </SelectTrigger>
                    <SelectPopup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {chosen && !chosen.cached && <p className="text-muted-foreground text-xs">Not downloaded yet: it downloads first ({formatSize(chosen.size)}).</p>}
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="matting-audio">Audio: keep original audio</Label>
                  <Switch id="matting-audio" checked={keepAudio} disabled={running} onCheckedChange={setKeepAudio} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="matting-quality">Video quality</Label>
                  <Select items={QUALITIES} value={quality} disabled={running} onValueChange={(next) => next && setQuality(next as MattingQuality)}>
                    <SelectTrigger id="matting-quality" aria-label="Video quality">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {QUALITIES.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-muted-foreground text-xs">Higher keeps the edges sharper and makes a larger file.</p>
                </div>
              </TabsPanel>
              <TabsPanel value="models" className="pt-1">
                {status && status.models.length === 0 ? (
                  <p className="text-muted-foreground py-3 text-sm">No models to show.</p>
                ) : (
                  <ul className="divide-border flex flex-col divide-y" aria-label="Models">
                    {(status?.models ?? []).map((m) => {
                      const job = downloading(m.name);
                      return (
                        <ModelRow
                          key={m.name}
                          model={m}
                          job={job}
                          busy={running}
                          onDownload={() => void act(() => api.downloadMattingModel(m.name))}
                          onRemove={() => void act(() => api.removeMattingModel(m.name))}
                          onCancel={() => job && cancel(job.id)}
                        />
                      );
                    })}
                  </ul>
                )}
                {modelError && <p className="text-destructive-foreground pt-2 text-sm">{modelError}</p>}
                <p className="text-muted-foreground pt-3 text-xs">Models are downloaded once from Hugging Face and kept on this computer. modnet is Apache-2.0, ben2-base is MIT.</p>
              </TabsPanel>
            </Tabs>

            {run && run.kind === 'matte' && run.status !== 'done' && (
              <div className="flex flex-col gap-2" data-testid="matting-progress">
                <Progress value={run.status === 'running' ? percent(run.progress) : 0} aria-label="Removing the background">
                  <ProgressTrack>
                    <ProgressIndicator />
                  </ProgressTrack>
                </Progress>
                <p className={run.status === 'running' ? 'text-muted-foreground text-xs' : 'text-xs'}>{jobLine(run)}</p>
              </div>
            )}
            {failed && <p className="text-destructive-foreground text-sm" role="alert">{failed}</p>}
            {error && <p className="text-destructive-foreground text-sm" role="alert">{error}</p>}

            {swap && change && (
              <Alert variant="success" data-testid="matting-done">
                <CheckIcon />
                <AlertTitle>public/{swap.staticName} is ready</AlertTitle>
                <AlertDescription>
                  <p>{swap.sent ? 'Asked the agent to change the video to:' : 'The agent is not connected. Ask it to change the video to:'}</p>
                  <code className="bg-muted mt-1 block rounded-md px-2 py-1 font-mono text-xs">{change}</code>
                  {!swap.sent && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2 rounded-full"
                      onClick={async () => {
                        setCopied(await copyText(swap.text));
                      }}
                    >
                      {copied ? <CheckIcon /> : <ClipboardCopyIcon />}
                      {copied ? 'Copied' : 'Copy the request'}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            {running ? (
              <Button type="button" variant="ghost" className="rounded-full" onClick={() => run && cancel(run.id)}>
                Cancel removal
              </Button>
            ) : (
              <Button type="button" variant="ghost" className="rounded-full" onClick={onClose}>
                {swap ? 'Close' : 'Cancel'}
              </Button>
            )}
            {!swap && (
              <Button type="submit" className="rounded-full px-5" disabled={busy || running || !available || !local || problem !== null}>
                Remove background
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
