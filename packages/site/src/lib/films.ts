/**
 * The finished films the docs show in tiles, all rendered by Kinetograph (the templates of kinetograph-ui, and the
 * launch film). The clip is `VIDEO_BASE + 'films-' + name + '.mp4'` (a flat name, for release assets); the poster is a
 * small WebP in `public/docs-media/films/`. Sources and durations are listed in content/docs/VIDEOS.md.
 */
export interface Film {
  name: string;
  title: string;
  category: string;
  seconds: number;
  /** A tall (9:16) film: its dialog player is narrow. */
  portrait?: boolean;
}

export const FILMS: Film[] = [
  { name: 'launch2', title: 'Every frame, straight', category: 'Launch film', seconds: 43 },
  { name: 'dostoevsky', title: 'Dostoevsky in 40 seconds', category: 'Explainer', seconds: 40, portrait: true },
  { name: 'worlds', title: 'Worlds', category: 'Showreel', seconds: 30 },
  { name: 'page-turn', title: 'Page turn', category: 'Looks', seconds: 6, portrait: true },
  { name: 'match-cut', title: 'Match cut', category: 'Text', seconds: 5, portrait: true },
  { name: 'papercut-demo', title: 'All paper', category: 'Paper-cut', seconds: 5, portrait: true },
  { name: 'stack-credits', title: 'Stacked credits', category: 'Titles', seconds: 5, portrait: true },
];
