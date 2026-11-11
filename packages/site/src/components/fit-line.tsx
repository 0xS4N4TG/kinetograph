import { Fragment, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/**
 * One line of display type fitted to its container's width and cut to the capitals (see .kg-cap in index.css). `r` is
 * the string's width in em in Sofia Sans Extra Condensed 400 with kerning off, measured in a browser; a new string needs a
 * new measurement. The letters rise under the line's edge, `step` ms apart, after `lead` ms. Pass `still` for no entrance.
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
  return (
    <span aria-hidden className="kg-fit block">
      <span className={cn('kg-cap', className)} style={{ '--r': r, '--step': `${step}ms`, '--l': `${lead}ms` } as CSSProperties}>
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
