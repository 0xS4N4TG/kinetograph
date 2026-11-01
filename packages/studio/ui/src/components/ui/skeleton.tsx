import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactElement } from "react";
import { cn } from "@/lib/utils";

/** A placeholder with the shape of what is loading: a soft shimmer that holds still under prefers-reduced-motion. */
export function Skeleton({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "animate-skeleton rounded-sm bg-[linear-gradient(120deg,transparent_40%,var(--color-foreground)/6%,transparent_60%)_var(--color-muted)_0_0/200%_100%] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * An `<img>` that shows a skeleton over its box until the picture has loaded. The box around it must be `relative` and
 * sized; the image keeps its own attributes (lazy loading, error handling) and is never remounted for the skeleton.
 */
export function LoadingImage({ onLoad, onError, ...props }: ComponentProps<"img">): ReactElement {
  const ref = useRef<HTMLImageElement>(null);
  const [loading, setLoading] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    setLoading(!(el && el.complete && el.naturalWidth > 0));
  }, [props.src]);
  return (
    <>
      <img
        ref={ref}
        {...props}
        onLoad={(e) => {
          setLoading(false);
          onLoad?.(e);
        }}
        onError={(e) => {
          setLoading(false);
          onError?.(e);
        }}
      />
      {loading && <Skeleton className="absolute inset-0 rounded-[inherit]" />}
    </>
  );
}
