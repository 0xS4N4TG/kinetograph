import { ClapperboardIcon, FolderIcon, ImageIcon, ShapesIcon, TypeIcon, type LucideIcon } from 'lucide-react';

interface Kind {
  /** The clip card: the same dark soft card for every kind. */
  bar: string;
  /** The icon tile, in the kind's colour (coss chart tokens: a light and a dark set). */
  tile: string;
  swatch: string;
  icon: LucideIcon;
  /** The word before the name on a clip: "Text: Welcome". */
  word: string;
}

const CARD = 'bg-foreground/[0.07] border-border';
const KINDS: Record<string, Kind> = {
  sequence: { bar: CARD, tile: 'bg-foreground/10 text-foreground/70', swatch: 'bg-foreground/60', icon: ClapperboardIcon, word: 'Sequence' },
  text: { bar: CARD, tile: 'bg-chart-1/20 text-chart-1', swatch: 'bg-chart-1', icon: TypeIcon, word: 'Text' },
  shape: { bar: CARD, tile: 'bg-chart-2/20 text-chart-2', swatch: 'bg-chart-2', icon: ShapesIcon, word: 'Shape' },
  group: { bar: CARD, tile: 'bg-chart-3/20 text-chart-3', swatch: 'bg-chart-3', icon: FolderIcon, word: 'Group' },
  image: { bar: CARD, tile: 'bg-chart-4/20 text-chart-4', swatch: 'bg-chart-4', icon: ImageIcon, word: 'Image' },
  video: { bar: CARD, tile: 'bg-chart-5/20 text-chart-5', swatch: 'bg-chart-5', icon: ClapperboardIcon, word: 'Video' },
};

/** Unknown types (paths, svg, canvas, plugin layers) look like shapes: motion graphics. */
export function layerColors(type?: string): Kind {
  const known = KINDS[type ?? 'sequence'];
  if (known) return known;
  return { ...KINDS.shape!, word: type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Layer' };
}
