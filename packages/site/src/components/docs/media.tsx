import { ClipPlayer } from '@/components/clip-player';

const BASE = '/docs-media/';

/**
 * A picture or a looping clip from `public/docs-media`, with the soft border of a code block.
 *
 * ```mdx
 * <Media src="studio/window-light.webp" dark="studio/window-dark.webp" width={1600} height={1160} alt="..." caption="..." />
 * <Media src="making-videos/noise-drift.mp4" poster="making-videos/noise-drift.webp" width={1280} height={720} alt="..." />
 * ```
 *
 * `src` is the light file and `dark` the one for the dark theme (the `dark` class on `<html>`); with no `dark`, `src`
 * shows in both. An `.mp4` is a muted loop that starts when it scrolls into view. `width` and `height` are the CSS
 * size, which reserves the space; the picture scales down to the column. `alt` is required.
 */
export function Media({
  src,
  dark,
  poster,
  alt,
  width,
  height,
  caption,
}: {
  src: string;
  dark?: string;
  poster?: string;
  alt: string;
  width: number;
  height: number;
  caption?: string;
}) {
  const frame = 'block h-auto w-full rounded-2xl border border-[var(--kg-box-border)]';
  const video = src.endsWith('.mp4');
  const picture = (file: string, className?: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={BASE + file} alt={alt} width={width} height={height} loading="lazy" decoding="async" className={`${frame} ${className ?? ''}`} />
  );
  return (
    <figure className="not-prose my-6" style={{ maxWidth: width }}>
      {video ? (
        <ClipPlayer
          clip={{ video: BASE + src, src: BASE + (poster ?? ''), w: width, h: height, from: '', len: 0 }}
          label={alt}
          className={frame}
        />
      ) : dark ? (
        <>
          {picture(src, 'dark:hidden')}
          {picture(dark, 'hidden dark:block')}
        </>
      ) : (
        picture(src)
      )}
      {caption ? <figcaption className="mt-2 text-center text-xs text-fd-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}
