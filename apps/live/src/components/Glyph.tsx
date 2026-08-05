// Tap-answer pictures. Drawn, not emoji: emoji render differently on every
// device and a 3-year-old is matching shapes, not fonts. Stroke-only so they
// inherit the kid ink colour and stay legible at TV distance.

import type { GlyphName } from "../activities/types";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Hand({ waving }: { waving: boolean }) {
  return (
    <g transform={waving ? "rotate(-16 32 46)" : undefined}>
      <path d="M22 44V22a4 4 0 018 0v20" {...STROKE} />
      <path d="M30 42V18a4 4 0 018 0v24" {...STROKE} />
      <path d="M38 42V22a4 4 0 018 0v20" {...STROKE} />
      <path d="M46 42V28a4 4 0 018 0v16c0 10-7 16-16 16s-16-6-16-16v-6" {...STROKE} />
      {waving && (
        <>
          <path d="M12 16c-3 3-3 8 0 11" {...STROKE} />
          <path d="M5 12c-5 5-5 14 0 19" {...STROKE} />
        </>
      )}
    </g>
  );
}

function Face({ happy }: { happy: boolean }) {
  return (
    <g>
      <circle cx="32" cy="32" r="24" {...STROKE} />
      <circle cx="24" cy="27" r="2.6" fill="currentColor" />
      <circle cx="40" cy="27" r="2.6" fill="currentColor" />
      <path d={happy ? "M21 39c4 6 18 6 22 0" : "M21 45c4-6 18-6 22 0"} {...STROKE} />
    </g>
  );
}

export function Glyph({ name }: { name: GlyphName }) {
  return (
    <svg className="glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {name === "wave" && <Hand waving />}
      {name === "still" && <Hand waving={false} />}
      {name === "smile" && <Face happy />}
      {name === "sad" && <Face happy={false} />}
    </svg>
  );
}
