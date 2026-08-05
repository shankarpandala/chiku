// Session time as a sun crossing to a moon (the design's only time signal —
// §9.5 wires it to the hard session cap). t runs 0 (sunrise) to 1 (moonrise).
// Ported from the frozen prototype; colors come from the kid tokens.

interface SunMoonProps {
  /** 0..1 session progress. */
  t: number;
  /** ViewBox width; rendered size follows the CSS box. */
  w?: number;
  className?: string;
}

export function SunMoon({ t, w = 160, className }: SunMoonProps) {
  const clamped = Math.min(1, Math.max(0, t));
  const x = 12 + clamped * (w - 24);
  const y = 40 - 30 * Math.sin(Math.PI * clamped);
  return (
    <svg
      viewBox={`0 0 ${w} 52`}
      className={className}
      role="img"
      aria-label={`Session time: ${Math.round(clamped * 100)}%`}
      data-testid="sunmoon"
      data-t={clamped.toFixed(2)}
    >
      <path
        d={`M12 42 Q${w / 2} -16 ${w - 12} 42`}
        fill="none"
        stroke="#cdc3e4"
        strokeWidth={4}
        strokeLinecap="round"
      />
      <circle cx={12} cy={42} r={7} fill="var(--kid-marigold)" />
      <path d={`M${w - 19} 42 a7 7 0 1 0 9 -6 a6 6 0 0 1 -9 6 z`} fill="var(--kid-chiku-dark)" />
      <circle cx={x} cy={y} r={11} fill="var(--kid-marigold)" stroke="var(--kid-cream)" strokeWidth={4} />
    </svg>
  );
}
