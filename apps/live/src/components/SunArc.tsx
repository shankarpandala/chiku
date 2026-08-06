// How much play time is left, for someone who cannot read a clock.
//
// The sun climbs from the left, crosses the top, and comes down as a moon on
// the right. That is the whole idea: a child glances at it and knows roughly
// where they are, and a parent gets a shared vocabulary — "when the sun gets to
// the moon, Chiku says bye" — that does not require a countdown to be argued
// with. §9.5 forbids a "stay longer" prompt; it does not forbid making the end
// visible long before it arrives, which is the difference between a session
// that ends and a session that is taken away.
//
// Deliberately one small SVG with no state and no animation loop: the surface
// re-reads the clock every five seconds (SESSION_TICK_MS) and passes a number.
// At a 20-minute cap that is a step of about half a degree — invisible as
// motion, exact enough as information.

interface SunArcProps {
  /** 0 → the session just started, 1 → the cap has been reached. */
  progress: number;
  /** Accessible name; bilingual is handled by the caller's i18n. */
  label: string;
}

/** Half-ellipse from (8,40) up over (50,6) and down to (92,40). */
const ARC_PATH = "M 8 40 A 42 34 0 0 1 92 40";

export function SunArc({ progress, label }: SunArcProps) {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const x = 50 - 42 * Math.cos(Math.PI * p);
  const y = 40 - 34 * Math.sin(Math.PI * p);
  // Past the crest it is evening: the marker cools from marigold to the deep
  // indigo the goodbye screen already uses.
  const night = p >= 0.75;

  return (
    <svg
      className="session-arc"
      viewBox="0 0 100 46"
      role="img"
      aria-label={label}
      data-session-progress={p.toFixed(2)}
    >
      <path className="session-arc-track" d={ARC_PATH} />
      <circle
        className={`session-arc-marker${night ? " is-night" : ""}`}
        cx={x}
        cy={y}
        r={7}
      />
    </svg>
  );
}
