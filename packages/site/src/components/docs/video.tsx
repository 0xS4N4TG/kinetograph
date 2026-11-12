import { HostedVideo } from '@/components/docs/hosted-video';
import { VIDEO_BASE } from '@/sections/links';

const PLACEHOLDER = '/docs-media/video-placeholder.svg';

/**
 * A finished clip in a docs page, with a poster. Nothing shows under the player: `label` is its aria-label. A `caption` prop is accepted and ignored.
 *
 * ```mdx
 * <Video name="first-video" label="The finished title card" silent />
 * ```
 *
 * `name` is the file name without extension: the clip is `VIDEO_BASE + name + .mp4` and the poster `VIDEO_BASE + name + .jpg`
 * (see `sections/links.ts`). `poster` is a local image used in place of `name.jpg`. `silent` makes a muted loop that plays by itself; without it the clip has sound and starts on
 * click. `label` is the aria-label. While `VIDEO_BASE` is empty the clip is not hosted yet and a placeholder poster shows.
 */
export function Video({ name, label, silent = false, poster }: { name: string; label: string; caption?: string; silent?: boolean; poster?: string }) {
  const frame = 'block aspect-video w-full rounded-2xl border border-[var(--kg-box-border)] bg-fd-card object-cover';
  return (
    <figure className="not-prose my-6">
      {VIDEO_BASE ? (
        <HostedVideo className={frame} src={`${VIDEO_BASE}${name}.mp4`} poster={poster ?? `${VIDEO_BASE}${name}.jpg`} label={label} silent={silent} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster ?? PLACEHOLDER} alt={`${label} (clip not published yet)`} width={1280} height={720} loading="lazy" className={frame} />
      )}
    </figure>
  );
}
