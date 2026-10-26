// Children as a flat list: arrays and `<Fragment>`s (nested too) are replaced by what they hold,
// so `.map()` can emit a pair of elements per item. `null`, `undefined` and booleans are dropped,
// as `Children.toArray` does. Each key is prefixed with the keys of the fragments around it, so
// an element keeps its key (and React keeps its state) when the list around it changes.

import { Children, Fragment, cloneElement, isValidElement, type ReactNode } from 'react';

export function flattenChildren(children: ReactNode, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const key = `${keyPrefix}${child.key ?? ''}`;
      if (child.type === Fragment) {
        out.push(...flattenChildren((child.props as { children?: ReactNode }).children, `${key}/`));
      } else {
        out.push(keyPrefix ? cloneElement(child, { key }) : child);
      }
    } else {
      out.push(child);
    }
  }
  return out;
}
