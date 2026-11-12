import { Fragment, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/** Side bearings in em (Sofia Sans Extra Condensed 400) for the letters a fitted line starts or ends with, measured in a browser. */
const BEARING: Record<string, { l: number; r: number }> = {
  B: { l: 0.052, r: 0.029 }, P: { l: 0.052, r: 0.024 }, T: { l: 0.017, r: 0.017 }, V: { l: 0.01, r: 0.01 },
  W: { l: 0.013, r: 0.013 }, O: { l: 0.043, r: 0.043 }, E: { l: 0.052, r: 0.041 }, N: { l: 0.052, r: 0.051 },
  '.': { l: 0.037, r: 0.037 }, ',': { l: 0.017, r: 0.029 },
};

/**
 * One line of display type fitted to its container's width and cut to the capitals (see .kg-cap in index.css). `r` is
 * the string's width in em in Sofia Sans Extra Condensed 400 with kerning off, measured in a browser; a new string needs a
 * new measurement. The first letter's left bearing and the last one's right bearing are trimmed, so the ink, not the
 * advance box, meets both edges and stacked lines share one optical edge. The letters rise under the line's edge, `step` ms apart, after `lead` ms. Pass `still` for no entrance.
 */
export function FitLine({
  text,
  r,
  step = 24,
  lead = 0,
  still = false,
  className,
}: {
  text: string;
  r: number;
  step?: number;
  lead?: number;
  still?: boolean;
  className?: string;
}) {
  let n = 0;
  const lsb = BEARING[text[0]]?.l ?? 0;
  const rsb = BEARING[text[text.length - 1]]?.r ?? 0;
  return (
    <span aria-hidden className="kg-fit block">
      <span className={cn('kg-cap', className)} style={{ '--r': r - lsb - rsb, '--lsb': lsb, '--step': `${step}ms`, '--l': `${lead}ms` } as CSSProperties}>
        <span className="in">
          {text.split(' ').map((word, wi) => (
            <Fragment key={wi}>
              {wi > 0 && ' '}
              <span className="inline-block whitespace-nowrap">
                {[...word].map((ch, ci) => (
                  <span key={ci} className={still ? 'inline-block' : 'kg-ch'} style={still ? undefined : ({ '--n': n++ } as CSSProperties)}>
                    {ch}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
        </span>
      </span>
    </span>
  );
}
