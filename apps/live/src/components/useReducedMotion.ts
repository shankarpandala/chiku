import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Read once at mount and then follow the media query. The rig is rebuilt when
 * this flips (it takes reducedMotion at construction), which is rare enough to
 * be free and means the no-motion path is never a stale render.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    const mq = globalThis.matchMedia?.(QUERY);
    return mq?.matches ?? false;
  });

  useEffect(() => {
    const mq = globalThis.matchMedia?.(QUERY);
    if (!mq?.addEventListener) return;
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
