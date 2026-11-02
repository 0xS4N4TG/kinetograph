import { Label } from '@/sections/shared';

/** Numerals in the heading face: DM Sans 700, tight tracking, tabular so the tiles line up. */
const numeral = 'font-dm font-bold leading-none tracking-[-0.05em] tabular-nums';

const tile = 'flex flex-col justify-between border border-cobalt/30 p-[clamp(20px,2.4vw,32px)]';

/** The four small tiles: our own measured renders, whole `kinetograph render` to H.264 MP4. */
const SMALL = [
  { big: '87', unit: 'fps', label: 'Captions over video', detail: '180 frames, 1080p, 2.06 s' },
  { big: '83', unit: 'fps', label: 'A Remotion project, unchanged', detail: '150 frames, 1200×1000, 1.81 s' },
  { big: '62', unit: 'fps', label: 'A 3D character scene', detail: '180 frames, 1080p, 2.90 s' },
  { big: '29', unit: 's', label: 'The launch film, 1,184 frames', detail: '39.5 s of 1080p video, 40 fps' },
] as const;

/** Render speed as a bento: one large tile for the shapes reel, four small ones. */
export function Speed() {
  return (
    <div id="benchmark" className="mt-14 scroll-mt-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-2">
        <div className={`${tile} min-h-[280px] bg-cobalt text-white sm:col-span-2 lg:row-span-2`}>
          <Label className="text-white/75">A reel drawn from shapes</Label>
          <div className="mt-10">
            <p className={`${numeral} text-[clamp(88px,15vw,200px)]`}>
              11<span className="ml-[0.08em] text-[0.4em] tracking-[-0.03em]">s</span>
            </p>
            <p className="mt-5 max-w-[22ch] font-dm text-[clamp(20px,2.2vw,28px)] leading-tight font-medium tracking-[-0.02em]">
              to render 37 seconds of 1080p video.
            </p>
            <p className="mt-4 font-jb text-[12px] leading-relaxed text-white/75">
              928 frames, 81 fps, 3.2× real time
            </p>
          </div>
        </div>
        {SMALL.map((t) => (
          <div key={t.label} className={`${tile} min-h-[200px] bg-paper/60`}>
            <p className={`${numeral} text-[clamp(56px,6vw,84px)] text-cobalt`}>
              {t.big}
              <span className="ml-[0.12em] text-[0.34em] tracking-[-0.02em]">{t.unit}</span>
            </p>
            <div className="mt-8">
              <Label className="text-ink">{t.label}</Label>
              <p className="mt-2 font-jb text-[12px] leading-relaxed text-ink/75">{t.detail}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 max-w-[70ch] font-jb text-[11px] leading-relaxed text-ink/60">
        Apple M4 laptop, whole render to H.264 MP4, median of 3 runs, measured 1 Nov 2026 while other jobs ran.
      </p>
    </div>
  );
}
