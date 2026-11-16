'use client';

import { PlayIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { FitLine } from '@/components/fit-line';
import { Pic } from '@/components/pic';
import { doc } from '@/sections/links';
import { body, labelText, link, shell } from '@/sections/shared';
import { cn } from '@/lib/utils';

/** The launch film: a dithered still on the cobalt field, and a play button that plays the real film in place, with sound. */
export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <section id="film" className={`${shell} scroll-mt-6`}>
      <div data-reveal className="group/pic kg-tray">
        <div className="kg-core kg-core-field aspect-[4/3] sm:aspect-video">
          <Pic
            tint="/retro/film-camera.webp"
            orig="/retro/film-camera-orig.jpg"
            alt="A vintage film camera with a thin ring around it, a frame from the launch film."
            className="absolute inset-0 size-full rounded-none"
          />
          <video
            ref={video}
            className={cn('absolute inset-0 size-full bg-black object-cover transition-opacity duration-500 ease-[cubic-bezier(0,0,0.2,1)]', playing ? 'opacity-100' : 'pointer-events-none opacity-0')}
            src="/film/launch.mp4"
            poster="/film/poster.jpg"
            preload="none"
            playsInline
            controls={playing}
            onPlay={() => setPlaying(true)}
          />
          <div
            className={cn(
              'pointer-events-none absolute bottom-[6%] left-[4%] w-[50%] transition-opacity duration-500 ease-[cubic-bezier(0,0,0.2,1)] sm:w-[37%]',
              playing && 'opacity-0',
            )}
          >
            <h2 aria-label="The launch film, written in code." className="flex flex-col gap-[0.9vw] sm:gap-[0.7vw]">
              <FitLine text="THE LAUNCH FILM," r={5.024} still />
              <FitLine text="WRITTEN IN CODE." r={4.973} still />
            </h2>
          </div>
          {!playing && (
            <button
              type="button"
              onClick={() => void video.current?.play()}
              aria-label="Play the launch film"
              className={cn(
                labelText,
                'group absolute right-[3.5%] bottom-[5%] inline-flex h-14 items-center gap-4 rounded-full bg-on-field pr-2 pl-7 text-[18px] text-[#111113] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.98] max-sm:h-12 max-sm:pl-5',
              )}
            >
              Play
              <span className="grid size-10 place-items-center rounded-full bg-field text-on-field transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 group-hover:scale-105 max-sm:size-8">
                <PlayIcon className="ml-0.5 size-4 fill-current" />
              </span>
            </button>
          )}
        </div>
      </div>
      <p data-reveal style={{ '--i': 2 } as React.CSSProperties} className={`${body} mt-8 max-w-[56ch]`}>
        Kinetograph rendered this film's 1,184 frames. One TypeScript project makes all of it, sound effects included:{' '}
        <a className={link} href={doc('examples/launch')} target="_blank" rel="noreferrer">examples/launch</a>.
      </p>
    </section>
  );
}
