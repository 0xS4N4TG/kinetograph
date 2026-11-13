import { BackToTop } from '@/components/back-to-top';
import { Label, shell, Wordmark } from '@/sections/shared';

export interface FooterColumn {
  title: string;
  links: { label: string; href: string }[];
}

/**
 * The footer, revealed like a curtain: it sticks to the bottom of the window underneath the page, which is opaque and
 * lifts off it at the end. The giant wordmark is DM Sans 700, faint, with the one red full stop. Keep it shorter than the window.
 */
export function Footer({ columns }: { columns: FooterColumn[] }) {
  return (
    <footer className="sticky bottom-0 z-0 overflow-hidden bg-field text-on-field">
      <div aria-hidden className="kg-noise pointer-events-none absolute inset-0 opacity-[0.1]" />
      <div className={`${shell} relative flex flex-col gap-[clamp(40px,6vw,88px)] pt-[clamp(48px,6vw,88px)]`}>
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-[28ch]">
            <Wordmark className="text-[28px] text-on-field" />
            <p className="mt-4 font-dm text-[16px] leading-snug text-on-field/85">A programmatic video engine in Rust and TypeScript.</p>
            <div className="mt-8 max-md:hidden">
              <BackToTop />
            </div>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-3 gap-x-[clamp(20px,5vw,72px)] gap-y-8">
            {columns.map((c) => (
              <div key={c.title}>
                <Label className="text-on-field/80">{c.title}</Label>
                <ul className="mt-5 space-y-3">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} className="font-dm text-[15px] leading-tight text-on-field underline decoration-transparent underline-offset-4 transition-colors hover:decoration-on-field">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="md:hidden">
          <BackToTop />
        </div>
        <div aria-hidden className="kg-fit -mb-[0.012em] select-none">
          <span className="kg-wordmark-fit text-on-field/14" style={{ '--r': 5.52 } as React.CSSProperties}>
            <span className="in">
              kinetograph<span className="text-flag/55">.</span>
            </span>
          </span>
        </div>
      </div>
    </footer>
  );
}
