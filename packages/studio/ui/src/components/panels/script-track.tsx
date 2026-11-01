import { PauseIcon, PlayIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { trackUrl } from './brief-upload';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * Plays a script's track from the project (the studio serves the file under the window's token). The file is not
 * fetched until the first play, and playing stops when the panel goes away.
 */
export function TrackPlayer({ src, name }: { src: string; name: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);

  useEffect(() => {
    const element = audio.current;
    return () => {
      if (element && !element.paused) element.pause();
    };
  }, []);

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) return element.pause();
    setFailed(false);
    Promise.resolve(element.play()).catch(() => setFailed(true));
  };

  return (
    <div className="flex items-center gap-2">
      <audio
        ref={audio}
        src={trackUrl(src)}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onError={() => {
          setPlaying(false);
          setFailed(true);
        }}
      />
      <Button variant="outline" size="icon-xs" aria-label={playing ? `Pause ${name}` : `Play ${name}`} aria-pressed={playing} onClick={toggle}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <span className="text-muted-foreground text-xs tabular-nums" data-testid="track-time">
        {clock(time)}
      </span>
      {failed && (
        <span role="alert" className="text-destructive-foreground text-xs">
          The track could not be played.
        </span>
      )}
    </div>
  );
}
