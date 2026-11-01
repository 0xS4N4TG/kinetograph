import { formatSeconds } from './script-math';

interface BeatStripProps {
  beats: number[];
  /** The script's running total, shown as the filled part of the strip. */
  total: number;
}

/** Ticks at the beat times over the track's length (or the script's, if that is longer). */
export function BeatStrip({ beats, total }: BeatStripProps) {
  const span = Math.max(total, ...beats, 0.001);
  return (
    <div
      role="img"
      aria-label={`${beats.length} beats over ${formatSeconds(span)}`}
      data-testid="beat-strip"
      className="bg-muted relative h-8 overflow-hidden rounded-md border"
    >
      <div
        data-testid="beat-script-span"
        className="bg-primary/15 absolute inset-y-0 left-0"
        style={{ width: `${Math.min(100, (total / span) * 100)}%` }}
      />
      {beats.map((beat, i) => (
        <span
          key={i}
          data-testid="beat-tick"
          className="bg-foreground/60 absolute inset-y-1.5 w-px"
          style={{ left: `${Math.min(100, Math.max(0, (beat / span) * 100))}%` }}
        />
      ))}
    </div>
  );
}
