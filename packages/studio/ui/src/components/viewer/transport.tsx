import { MaximizeIcon, PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon, SkipForwardIcon } from 'lucide-react';
import { memo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';

import type { CompositionInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Toggle } from '@/components/ui/toggle';
import { formatTimecode, parseTimecode } from '@/lib/format';
import type { Player } from '@/lib/player';
import { cn } from '@/lib/utils';

/** The timecode; a click turns it into a field for a frame number or HH:MM:SS:FF. Enter seeks, Escape cancels. */
function Timecode({ comp, frame, player }: { comp: CompositionInfo | null; frame: number; player: Player }) {
  const fps = comp?.fps ?? 30;
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  if (draft === null) {
    return (
      <button
        type="button"
        data-testid="timecode"
        title="Go to a frame or timecode"
        disabled={comp === null}
        onClick={() => setDraft(formatTimecode(frame, fps))}
        className="hover:bg-accent focus-visible:ring-ring rounded-full px-2 py-1 font-mono text-[13px] font-medium tabular-nums outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        {formatTimecode(frame, fps)}
      </button>
    );
  }

  return (
    <input
      autoFocus
      aria-label="Go to frame or timecode"
      aria-invalid={invalid}
      value={draft}
      onFocus={(event) => event.target.select()}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setDraft(null);
        } else if (event.key === 'Enter') {
          const target = parseTimecode(draft, fps);
          if (target === null) setInvalid(true);
          else {
            player.seek(target);
            setDraft(null);
          }
        }
      }}
      className="bg-input/60 ring-ring aria-[invalid=true]:ring-destructive w-28 rounded-full px-3 py-1 font-mono text-[13px] font-medium outline-none ring-2"
    />
  );
}

/** The progress bar: one segment per Sequence boundary, filled up to the playhead; press or drag to seek. */
function Progress({ comp, frame, edges, player }: { comp: CompositionInfo | null; frame: number; edges: number[]; player: Player }) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const duration = Math.max(1, comp?.durationInFrames ?? 1);
  const bounds = [0, ...edges.filter((e) => e > 0 && e < duration), duration];
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || !comp) return;
    player.seek(Math.round(((event.clientX - rect.left) / rect.width) * (duration - 1)));
  };
  const stop = () => {
    if (!dragging.current) return;
    dragging.current = false;
    player.endScrub();
  };
  return (
    <div
      ref={bar}
      role="progressbar"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, duration - 1)}
      aria-valuenow={frame}
      className="flex h-5 min-w-0 flex-1 cursor-pointer touch-none items-center gap-[3px]"
      onPointerDown={(event) => {
        if (!comp) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        player.beginScrub();
        seek(event);
      }}
      onPointerMove={(event) => dragging.current && seek(event)}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      {bounds.slice(0, -1).map((from, index) => {
        const to = bounds[index + 1]!;
        const fill = Math.min(1, Math.max(0, (frame - from) / (to - from)));
        return (
          <span key={from} className="bg-foreground/20 relative h-1.5 overflow-hidden rounded-full" style={{ flexGrow: to - from, flexBasis: 0 }}>
            <span className="bg-primary absolute inset-y-0 left-0 rounded-full" style={{ width: `${fill * 100}%` }} />
          </span>
        );
      })}
    </div>
  );
}

interface TransportProps {
  comp: CompositionInfo | null;
  player: Player;
  /** Frames where the Sequences start or end, to split the progress bar. */
  edges?: number[];
  className?: string;
}

/**
 * One translucent bar at the bottom of the preview: play and pause, frame step, the timecode and frame counter, a
 * progress bar split at the Sequence boundaries, loop and fullscreen. It follows the player itself, so a frame ticking
 * by renders this and nothing else.
 */
export const Transport = memo(function Transport({ comp, player, edges = [], className }: TransportProps) {
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const disabled = comp === null;
  const quiet = 'size-8 rounded-full';

  return (
    <div
      className={cn(
        'bg-card/70 border-border/60 flex items-center gap-1.5 rounded-2xl border px-2.5 py-2 shadow-lg shadow-black/20 backdrop-blur-xl backdrop-saturate-150 select-none',
        '[@media(prefers-reduced-transparency:reduce)]:bg-card [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none',
        className,
      )}
    >
      <Hint label={state.playing ? 'Pause (Space)' : 'Play (Space)'}>
        <Button size="icon" aria-label={state.playing ? 'Pause' : 'Play'} disabled={disabled} onClick={() => player.toggle()} className="size-9 rounded-full">
          {state.playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
        </Button>
      </Hint>
      <Hint label="Previous frame (Left, Shift: 10)">
        <Button variant="ghost" size="icon" aria-label="Previous frame" disabled={disabled} onClick={() => player.step(-1)} className={quiet}>
          <SkipBackIcon />
        </Button>
      </Hint>
      <Hint label="Next frame (Right, Shift: 10)">
        <Button variant="ghost" size="icon" aria-label="Next frame" disabled={disabled} onClick={() => player.step(1)} className={quiet}>
          <SkipForwardIcon />
        </Button>
      </Hint>
      <Timecode comp={comp} frame={state.frame} player={player} />
      <span data-testid="frame-counter" className="text-muted-foreground font-mono text-xs tabular-nums">
        {state.frame} / {comp?.durationInFrames ?? 0}
      </span>
      <Progress comp={comp} frame={state.frame} edges={edges} player={player} />
      <span
        data-testid="preview-fps"
        className="text-muted-foreground/80 hidden min-w-[84px] text-right font-mono text-[11px] tabular-nums xl:inline"
        title={state.playing || state.scrubbing ? 'Half size, JPEG, while moving' : 'Full size, PNG, at rest'}
      >
        {state.fps === null ? '-' : state.fps.toFixed(1)} / {comp?.fps ?? '-'} fps
      </span>
      <Hint label="Loop (L)">
        <Toggle
          aria-label="Loop"
          pressed={state.loop}
          disabled={disabled}
          onPressedChange={(pressed) => player.setLoop(pressed)}
          className="data-pressed:bg-accent data-pressed:text-accent-foreground size-8 rounded-full px-0 sm:size-8"
        >
          <RepeatIcon />
        </Toggle>
      </Hint>
      <Hint label="Full screen">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Full screen"
          disabled={disabled}
          onClick={(event) => {
            const panel = event.currentTarget.closest('section');
            if (document.fullscreenElement) void document.exitFullscreen();
            else void panel?.requestFullscreen?.();
          }}
          className={quiet}
        >
          <MaximizeIcon />
        </Button>
      </Hint>
    </div>
  );
});
