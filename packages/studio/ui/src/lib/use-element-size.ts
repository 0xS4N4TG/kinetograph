import { useLayoutEffect, useState, type RefObject } from 'react';

/** The client size (padding included) of `ref`'s element, kept up to date with a ResizeObserver; zeros where there is none. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) =>
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    update(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update(element.clientWidth, element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
