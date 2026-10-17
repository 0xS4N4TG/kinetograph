import { PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon, SkipForwardIcon } from 'lucide-react';
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
  return (
    <div className="flex items-center gap-1 border-t px-4 py-2.5">
      <Hint label="Previous frame (Left, Shift: 10)">
        <Button variant="ghost" size="icon-sm" aria-label="Previous frame" disabled={disabled} onClick={() => player.step(-1)}>
          <SkipBackIcon />
        </Button>
      </Hint>
      <Hint label={state.playing ? 'Pause (Space)' : 'Play (Space)'}>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={state.playing ? 'Pause' : 'Play'}
          disabled={disabled}
          onClick={() => player.toggle()}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
      </Hint>
      <Hint label="Next frame (Right, Shift: 10)">
        <Button variant="ghost" size="icon-sm" aria-label="Next frame" disabled={disabled} onClick={() => player.step(1)}>
          <SkipForwardIcon />
        </Button>
      </Hint>
      <Hint label="Loop">
        <Toggle
          size="sm"
          aria-label="Loop"
          pressed={state.loop}
          disabled={disabled}
          onPressedChange={(pressed) => player.setLoop(pressed)}
        >
          <RepeatIcon />
        </Toggle>
      </Hint>
      <div className="ml-3 flex items-baseline gap-3 font-mono text-xs tabular-nums">
        <span data-testid="frame-counter">
          {state.frame} / {comp?.durationInFrames ?? 0}
        </span>
        <span data-testid="timecode" className="text-muted-foreground">
          {formatTimecode(state.frame, comp?.fps ?? 30)}
        </span>
      </div>
      <div
        data-testid="preview-fps"
        className="text-muted-foreground ml-auto font-mono text-xs tabular-nums"
        title="Frames per second the preview is actually showing"
      >
        {state.fps === null ? '-' : state.fps.toFixed(1)} / {comp?.fps ?? '-'} fps
      </div>
    </div>
  );
}
