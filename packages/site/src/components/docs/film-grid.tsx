'use client';

import { PlayIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { HostedVideo } from '@/components/docs/hosted-video';
import { FILMS, type Film } from '@/lib/films';
import { VIDEO_BASE } from '@/sections/links';

/**
 * One tile: poster, title, category and "Play · 40s". Opens the film in a dialog with sound: the title and a close button
 * above the film, the film's own controls on it. A native `<dialog>` opened with showModal, so Escape closes it, focus stays
 * inside and goes back to the tile on close; a click on the backdrop closes it too.
 */
export function FilmTile({ film }: { film: Film }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    setOpen(true);
    dialog.current?.showModal();
  };
  const hide = () => {
    setOpen(false);
    dialog.current?.close();
  };
  return (
    <li>
      <button
        type="button"
        onClick={show}
        className="group block w-full cursor-pointer overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-fd-card text-left transition-colors hover:border-fd-primary"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/docs-media/films/${film.name}.webp`} alt="" width={480} height={270} loading="lazy" className="block aspect-video w-full object-cover" />
        <span className="block px-4 py-3">
          <span className="block text-sm font-medium text-fd-foreground">{film.title}</span>
          <span className="block text-xs text-fd-muted-foreground">{film.category}</span>
          <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-fd-primary">
            <PlayIcon className="size-3 fill-current" aria-hidden />
            Play · {film.seconds}s
          </span>
        </span>
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === dialog.current && hide()}
        aria-labelledby={`film-${film.name}`}
        // The dialog is exactly as wide as the film: a 9:16 film is narrow, a 16:9 one wide. The width is capped so the film
        // and the title row above it fit the window (100dvh) with a 16px margin all round, at any size.
        style={{ width: film.portrait ? 'min(calc(100vw - 32px), calc((100dvh - 144px) * 9 / 16), 440px)' : 'min(calc(100vw - 32px), calc((100dvh - 144px) * 16 / 9), 1120px)' }}
        className="m-auto max-h-[calc(100dvh-32px)] overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-fd-card p-0 text-fd-foreground backdrop:bg-black/80"
      >
        <div className="flex items-start gap-3 py-2 pr-2 pl-4">
          <div className="min-w-0 flex-1 pt-2">
            <h3 id={`film-${film.name}`} className="text-sm leading-snug font-medium">
              {film.title}
            </h3>
            <p className="text-xs text-fd-muted-foreground">
              {film.category} &middot; {film.seconds}s
            </p>
          </div>
          <button
            type="button"
            onClick={hide}
            aria-label="Close"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-fd-primary"
          >
            <XIcon className="size-5" aria-hidden />
          </button>
        </div>
        {open && VIDEO_BASE ? (
          <HostedVideo
            src={`${VIDEO_BASE}films-${film.name}.mp4`}
            poster={`/docs-media/films/${film.name}.webp`}
            label={film.title}
            autoPlay
            className={`block w-full bg-black ${film.portrait ? 'aspect-[9/16]' : 'aspect-video'}`}
          />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-fd-muted-foreground">{film.title}: this film is coming soon.</p>
        )}
      </dialog>
    </li>
  );
}

/**
 * A two-column grid of film tiles. `<FilmGrid />` shows every film in `src/lib/films.ts`; `names` picks some of them.
 *
 * ```mdx
 * <FilmGrid names={['launch', 'showcase']} />
 * ```
 */
export function FilmGrid({ names }: { names?: string[] }) {
  const films = names ? names.flatMap((n) => FILMS.filter((f) => f.name === n)) : FILMS;
  return (
    <ul className="not-prose my-6 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
      {films.map((f) => (
        <FilmTile key={f.name} film={f} />
      ))}
    </ul>
  );
}
