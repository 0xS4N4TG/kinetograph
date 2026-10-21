/** Bar and swatch classes per layer type, shared by the timeline bars and the scene tree. */
const COLORS: Record<string, { bar: string; swatch: string }> = {
  sequence: {
    bar: 'bg-[#6b5d43]/90 border-[#9c8863] text-amber-50',
    swatch: 'bg-[#b59d72]',
  },
  text: {
    bar: 'bg-[#8c3539]/90 border-[#c95156] text-rose-50',
    swatch: 'bg-[#d95359]',
  },
  shape: {
    bar: 'bg-[#435282]/90 border-[#687fc7] text-indigo-50',
    swatch: 'bg-[#687fc7]',
  },
  group: {
    bar: 'bg-[#6e3b47]/90 border-[#a65b6c] text-pink-50',
    swatch: 'bg-[#b86577]',
  },
  image: {
    bar: 'bg-[#2f6955]/90 border-[#4ba385] text-emerald-50',
    swatch: 'bg-[#4ba385]',
  },
  video: {
    bar: 'bg-[#295f78]/90 border-[#4597bd] text-sky-50',
    swatch: 'bg-[#4597bd]',
  },
};

/** Unknown or missing types take the sequence colours. */
export function layerColors(type?: string): { bar: string; swatch: string } {
  return COLORS[type ?? 'sequence'] ?? COLORS.sequence!;
}
