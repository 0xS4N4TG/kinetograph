// `<IFrame>`: Remotion's `<iframe>` that holds the frame until the page has loaded. Kinetograph draws no embedded
// documents (the CSS engine reports an `iframe` as unsupported, docs/COMPAT.md §6), so this is the `iframe` element
// and nothing more: it is in the tree, `--strict` refuses it, and nothing loads, so there is nothing to wait for.

import type { ComponentPropsWithRef, ReactNode } from 'react';

export type IFrameProps = ComponentPropsWithRef<'iframe'> & {
  /** Accepted: there is no page load to retry. */
  delayRenderRetries?: number;
  /** Accepted: there is no page load to wait for. */
  delayRenderTimeoutInMilliseconds?: number;
};

export function IFrame({ delayRenderRetries: _retries, delayRenderTimeoutInMilliseconds: _timeout, ...props }: IFrameProps): ReactNode {
  return <iframe referrerPolicy="strict-origin-when-cross-origin" {...props} />;
}
