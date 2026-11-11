import { cn } from '@/lib/utils';

/**
 * The page's one picture treatment. `tint` is a pre-dithered greyscale file: screened over the cobalt field, black becomes
 * the accent and white stays white. `orig` is the untreated picture: it fades in over the tint when the nearest
 * `group/pic` ancestor is hovered (slowly in, a little faster out). Size the panel with `className` (an aspect ratio or a height). `containBelowLg` shows the whole picture, not a crop, below 1024px.
 */
export function Pic({ tint, orig, alt, className, containBelowLg = false }: { tint: string; orig?: string; alt: string; className?: string; containBelowLg?: boolean }) {
  const fit = containBelowLg && 'max-lg:object-contain!';
  return (
    <div className={cn('kg-pic kg-core kg-core-field', className)}>
      <img className={cn('tint', fit)} src={tint} alt={alt} loading="lazy" decoding="async" />
      {orig && <img className={cn('orig', fit)} src={orig} alt="" loading="lazy" decoding="async" />}
    </div>
  );
}
