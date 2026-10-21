import {
  ChevronFirstIcon,
  ChevronLastIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import type { CompositionInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTimecode } from '@/lib/format';
import type { Player, PlayerState } from '@/lib/player';

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface TransportProps {
  comp: CompositionInfo | null;
  player: Player;
  state: PlayerState;
}

/** Play and pause, frame step, loop, the frame counter and timecode, and the fps the preview reaches. */
export function Transport({ comp, player, state }: TransportProps) {
  const disabled = comp === null;
  const maxFrame = Math.max(0, (comp?.durationInFrames ?? 1) - 1);

  return (
    <div className="bg-card flex h-9 shrink-0 items-center gap-2 border-t px-3 select-none">
      {/* Left: timecode and frame counter */}
      <div className="flex items-center gap-2.5 font-mono text-xs tabular-nums">
        <span
          data-testid="timecode"
          className="rounded-xs bg-black/40 px-2 py-0.5 font-semibold tracking-wider text-nle-value ring-1 ring-white/10"
        >
          {formatTimecode(state.frame, comp?.fps ?? 30)}
        </span>
        <span data-testid="frame-counter" className="text-muted-foreground text-[11px]">
          {state.frame} / {comp?.durationInFrames ?? 0}
        </span>
      </div>

      {/* Center: NLE Transport Deck */}
      <div className="mx-auto flex items-center gap-0.5">
        <Hint label="First frame (Home)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="First frame"
            disabled={disabled}
            onClick={() => player.seek(0)}
            className="size-7"
          >
            <ChevronFirstIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="Previous frame (Left, Shift: 10)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous frame"
            disabled={disabled}
            onClick={() => player.step(-1)}
            className="size-7"
          >
            <SkipBackIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label={state.playing ? 'Pause (Space)' : 'Play (Space)'}>
          <Button
            variant={state.playing ? 'default' : 'secondary'}
            size="icon-sm"
            aria-label={state.playing ? 'Pause' : 'Play'}
            disabled={disabled}
            onClick={() => player.toggle()}
            className="mx-0.5 size-7"
          >
            {state.playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          </Button>
        </Hint>
        <Hint label="Next frame (Right, Shift: 10)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next frame"
            disabled={disabled}
            onClick={() => player.step(1)}
            className="size-7"
          >
            <SkipForwardIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="Last frame (End)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Last frame"
            disabled={disabled}
            onClick={() => player.seek(maxFrame)}
            className="size-7"
          >
            <ChevronLastIcon className="size-3.5" />
          </Button>
        </Hint>
        <div className="bg-border mx-1 h-4 w-px" />
        <Hint label="Loop">
          <Toggle
            size="sm"
            aria-label="Loop"
            pressed={state.loop}
            disabled={disabled}
            onPressedChange={(pressed) => player.setLoop(pressed)}
            className="size-7 p-0 data-[state=on]:bg-nle-blue/25 data-[state=on]:text-sky-300"
          >
            <RepeatIcon className="size-3.5" />
          </Toggle>
        </Hint>
      </div>

      {/* Right: Quality mode & Live FPS readout */}
      <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
        <span className="text-muted-foreground hidden rounded-xs border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] sm:inline-block">
          {state.playing || state.scrubbing ? 'Half (JPEG)' : 'Auto (Full)'}
        </span>
        <div
          data-testid="preview-fps"
          className="text-muted-foreground min-w-[78px] text-right"
          title="Frames per second the preview is actually showing"
        >
          {state.fps === null ? '-' : state.fps.toFixed(1)} / {comp?.fps ?? '-'} fps
        </div>
      </div>
    </div>
  );
}
