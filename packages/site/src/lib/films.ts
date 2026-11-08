/**
 * The finished films the docs show in tiles, all rendered by Kinetograph from our own examples. The clip is
 * `VIDEO_BASE + 'films-' + name + '.mp4' (release assets are flat)`; the poster is a small WebP in `public/docs-media/films/`. Sources and
 * durations are listed in content/docs/VIDEOS.md.
 */
export interface Film {
  name: string;
  title: string;
  category: string;
  seconds: number;
  sound: boolean;
}

export const FILMS: Film[] = [
  { name: 'launch', title: 'The Kinetograph launch film', category: 'Launch', seconds: 40, sound: true },
  { name: 'showcase', title: 'Engine showcase', category: 'Showcase', seconds: 37, sound: false },
  { name: 'showcase-3d', title: 'A 3D scene', category: '3D', seconds: 6, sound: false },
  { name: 'datamosh', title: 'Datamosh over archive footage', category: 'Glitch', seconds: 5, sound: true },
  { name: 'papercut-card', title: 'A paper-cut card', category: 'Paper-cut', seconds: 2, sound: false },
  { name: 'canvas', title: 'Canvas and shaders', category: 'Shaders', seconds: 2, sound: false },
  { name: 'video-overlay', title: 'Footage with overlays', category: 'Footage', seconds: 6, sound: false },
  { name: 'bench-diorama', title: 'A diorama', category: 'Portrait', seconds: 3, sound: false },
];
