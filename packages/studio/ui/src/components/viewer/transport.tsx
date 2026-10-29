import { ChevronFirstIcon, ChevronLastIcon, PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon, SkipForwardIcon } from 'lucide-react';
import { memo, useState, useSyncExternalStore } from 'react';

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
        className="hover:bg-accent focus-visible:ring-ring rounded-full px-2.5 py-1 font-mono text-[13px] font-medium tracking-wide tabular-nums outline-none focus-visible:ring-2 disabled:opacity-50"
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
      className="bg-input/60 ring-ring aria-[invalid=true]:ring-destructive w-28 rounded-full px-3 py-1 font-mono text-[13px] font-medium tracking-wide outline-none ring-2"
    />
  );
}

interface TransportProps {
  comp: CompositionInfo | null;
  player: Player;
  className?: string;
}

/**
 * Play and pause, frame step, loop, the timecode and frame counter, and the fps the preview reaches: a pill that floats
 * over the preview. It follows the player itself, so a frame ticking by renders this and nothing else.
 */
export const Transport = memo(function Transport({ comp, player, className }: TransportProps) {
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const disabled = comp === null;
  const maxFrame = Math.max(0, (comp?.durationInFrames ?? 1) - 1);
  const ghost = 'size-8 rounded-full';

  return (
    <div
      className={cn(
        'bg-card/85 border-border/60 flex items-center gap-1 rounded-full border py-1.5 pr-4 pl-2 shadow-lg shadow-black/20 backdrop-blur-xl select-none',
        className,
      )}
    >
      <Hint label="First frame (Home)">
        <Button variant="ghost" size="icon" aria-label="First frame" disabled={disabled} onClick={() => player.seek(0)} className={ghost}>
          <ChevronFirstIcon />
        </Button>
      </Hint>
      <Hint label="Previous frame (Left, Shift: 10)">
        <Button variant="ghost" size="icon" aria-label="Previous frame" disabled={disabled} onClick={() => player.step(-1)} className={ghost}>
          <SkipBackIcon />
        </Button>
      </Hint>
      <Hint label={state.playing ? 'Pause (Space)' : 'Play (Space)'}>
        <Button
          size="icon-lg"
          aria-label={state.playing ? 'Pause' : 'Play'}
          disabled={disabled}
          onClick={() => player.toggle()}
          className="mx-0.5 size-10 rounded-full sm:size-10"
        >
          {state.playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
        </Button>
      </Hint>
      <Hint label="Next frame (Right, Shift: 10)">
        <Button variant="ghost" size="icon" aria-label="Next frame" disabled={disabled} onClick={() => player.step(1)} className={ghost}>
          <SkipForwardIcon />
        </Button>
      </Hint>
      <Hint label="Last frame (End)">
        <Button variant="ghost" size="icon" aria-label="Last frame" disabled={disabled} onClick={() => player.seek(maxFrame)} className={ghost}>
          <ChevronLastIcon />
        </Button>
      </Hint>
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

      <span className="bg-border mx-2 h-5 w-px" aria-hidden="true" />
      <Timecode comp={comp} frame={state.frame} player={player} />
      <span data-testid="frame-counter" className="text-muted-foreground font-mono text-xs tabular-nums">
        {state.frame} / {comp?.durationInFrames ?? 0}
      </span>
      <span
        data-testid="preview-fps"
        className="text-muted-foreground/80 ml-2 hidden min-w-[84px] text-right font-mono text-[11px] tabular-nums lg:inline"
        title={state.playing || state.scrubbing ? 'Half size, JPEG, while moving' : 'Full size, PNG, at rest'}
      >
        {state.fps === null ? '-' : state.fps.toFixed(1)} / {comp?.fps ?? '-'} fps
      </span>
    </div>
  );
});
