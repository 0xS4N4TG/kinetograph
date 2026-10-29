/** Bar and swatch classes per layer type, shared by the timeline bars and the scene tree. Soft tints that work on both themes. */
const COLORS: Record<string, { bar: string; swatch: string }> = {
  sequence: { bar: 'bg-primary/25 border-primary/45 text-foreground', swatch: 'bg-primary' },
  text: { bar: 'bg-rose-400/25 border-rose-400/45 text-foreground', swatch: 'bg-rose-400' },
  shape: { bar: 'bg-violet-400/25 border-violet-400/45 text-foreground', swatch: 'bg-violet-400' },
  group: { bar: 'bg-amber-400/25 border-amber-400/45 text-foreground', swatch: 'bg-amber-400' },
  image: { bar: 'bg-emerald-400/25 border-emerald-400/45 text-foreground', swatch: 'bg-emerald-400' },
  video: { bar: 'bg-sky-400/25 border-sky-400/45 text-foreground', swatch: 'bg-sky-400' },
};

/** Unknown or missing types take the sequence colours. */
export function layerColors(type?: string): { bar: string; swatch: string } {
  return COLORS[type ?? 'sequence'] ?? COLORS.sequence!;
}
