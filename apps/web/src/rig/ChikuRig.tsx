import { useEffect, useRef } from "react";
import { createRig, type Rig, type RigState } from "@chiku/rig";

interface ChikuRigProps {
  /** Declarative state. Omit it to drive the rig imperatively via onReady. */
  state?: RigState;
  crop?: "full" | "head";
  showBody?: boolean;
  className?: string;
  /** Hands the live Rig to the parent (speak(), imperative transitions). */
  onReady?: (rig: Rig) => void;
}

/** React binding for the framework-agnostic @chiku/rig runtime. */
export function ChikuRig({ state = "idle", crop, showBody, className, onReady }: ChikuRigProps) {
  const host = useRef<HTMLDivElement>(null);
  const rig = useRef<Rig | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!host.current) return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = createRig(host.current, {
      ...(crop !== undefined ? { crop } : {}),
      ...(showBody !== undefined ? { showBody } : {}),
      reducedMotion,
    });
    r.setState(stateRef.current);
    rig.current = r;
    onReadyRef.current?.(r);
    return () => {
      r.dispose();
      rig.current = null;
    };
  }, [crop, showBody]);

  useEffect(() => {
    rig.current?.setState(state);
  }, [state]);

  return <div ref={host} className={className} role="img" aria-label="Chiku" />;
}
