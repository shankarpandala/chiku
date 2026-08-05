import { CREAM, CHDARK, MARI } from "../data/kidPalette";

// Session time as a sun crossing to a moon; t runs 0 (sunrise) to 1 (moonrise).
export function SunMoon({ t, w, cssW }) {
  const x = 12 + t * (w - 24), y = 40 - 30 * Math.sin(Math.PI * t);
  return (
    <svg width={cssW || w} height={cssW ? undefined : 52} style={cssW ? { height: "auto" } : undefined} viewBox={"0 0 " + w + " 52"}>
      <path d={"M12 42 Q" + (w / 2) + " -16 " + (w - 12) + " 42"} fill="none" stroke="#cdc3e4" strokeWidth={4} strokeLinecap="round" />
      <circle cx={12} cy={42} r={7} fill={MARI} />
      <path d={"M" + (w - 19) + " 42 a7 7 0 1 0 9 -6 a6 6 0 0 1 -9 6 z"} fill={CHDARK} />
      <circle cx={x} cy={y} r={11} fill={MARI} stroke={CREAM} strokeWidth={4} />
    </svg>
  );
}
