'use client';

import { PlayIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { FILMS, type Film } from '@/lib/films';
import { VIDEO_BASE } from '@/sections/links';

/** One tile: poster, title, category and "Play · 40s". Opens the film in a dialog with sound. */
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
        aria-label={film.title}
        className="m-auto w-[min(92vw,960px)] rounded-2xl border border-[var(--kg-box-border)] bg-fd-card p-3 text-fd-foreground backdrop:bg-black/70"
      >
        {open && VIDEO_BASE ? (
          <video
            src={`${VIDEO_BASE}films-${film.name}.mp4`}
            poster={`/docs-media/films/${film.name}.webp`}
            aria-label={film.title}
            controls
            autoPlay
            playsInline
            className={`mx-auto block rounded-lg bg-black ${film.portrait ? 'max-h-[80vh] w-auto' : 'aspect-video w-full'}`}
          />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-fd-muted-foreground">{film.title}: this film is coming soon.</p>
        )}
        <button type="button" onClick={hide} className="mt-3 text-xs text-fd-muted-foreground underline">
          Close
        </button>
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
