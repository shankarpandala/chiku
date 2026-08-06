// Tap-answer pictures. Drawn, not emoji: emoji render differently on every
// device and a 3-year-old is matching shapes, not fonts. Stroke-only so they
// inherit the kid ink colour and stay legible at TV distance.
//
// EVERY GlyphName HAS A SHAPE, AND THE COMPILER ENFORCES IT. This used to be a
// chain of `{name === "wave" && …}`, which meant a new name in `GlyphName`
// rendered an empty box: a tap answer with an accessible name and no face, on
// the one control that exists for the child who cannot use the camera. The
// switch below is exhaustive over the union and ends in a `never`, so adding a
// name to `GlyphName` without drawing it fails the build instead of shipping a
// blank button. (Phase 5 landed six names in exactly that state.)

import type { ReactElement } from "react";
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

/**
 * A child, arms and legs out (big) or tucked in and crouched (small).
 *
 * The two are drawn at deliberately different SIZES as well as different
 * poses: the answer to "make yourself big" is legible from across a room as a
 * shape that fills its button, and the small one is legible as one that does
 * not. A pose difference alone would read as "two people standing oddly".
 */
function Body({ big }: { big: boolean }) {
  return big ? (
    <g>
      <circle cx="32" cy="13" r="7" {...STROKE} />
      <path d="M32 20v20" {...STROKE} />
      <path d="M32 25L12 12M32 25l20-13" {...STROKE} />
      <path d="M32 40L16 58M32 40l16 18" {...STROKE} />
    </g>
  ) : (
    <g>
      <circle cx="32" cy="26" r="6" {...STROKE} />
      <path d="M32 32v10" {...STROKE} />
      <path d="M32 34l-9 5M32 34l9 5" {...STROKE} />
      <path d="M32 42l-7 9M32 42l7 9" {...STROKE} />
    </g>
  );
}

/** A fist with the thumb out. Rotated for "down", so the pair cannot drift. */
function Thumb({ up }: { up: boolean }) {
  return (
    <g transform={up ? undefined : "rotate(180 32 32)"}>
      <rect x="16" y="30" width="28" height="26" rx="7" {...STROKE} />
      <path d="M24 30V17a5 5 0 0110 0v13" {...STROKE} />
      <path d="M44 38h4a4 4 0 010 8h-4" {...STROKE} />
    </g>
  );
}

/**
 * Peekaboo, as one picture with the hands in two places: raised over the eyes
 * (hidden) or dropped below them (peeking). Same face, same bar — the only
 * thing that moves is the thing the game is about.
 */
function Peek({ hidden }: { hidden: boolean }) {
  return (
    <g>
      <circle cx="32" cy="32" r="24" {...STROKE} />
      {!hidden && (
        <>
          <circle cx="24" cy="27" r="2.6" fill="currentColor" />
          <circle cx="40" cy="27" r="2.6" fill="currentColor" />
        </>
      )}
      <rect
        x="10"
        y={hidden ? 21 : 40}
        width="44"
        height="12"
        rx="6"
        {...STROKE}
        /* Filled with the button's own sand so the hands OCCLUDE the face
           rather than being drawn on top of it as a see-through box. */
        fill="var(--kid-sand, none)"
      />
      <path d={hidden ? "M22 27h20" : "M22 46h20"} {...STROKE} strokeWidth={2.5} />
    </g>
  );
}

function shapeFor(name: GlyphName): ReactElement {
  switch (name) {
    case "wave":
      return <Hand waving />;
    case "still":
      return <Hand waving={false} />;
    case "smile":
      return <Face happy />;
    case "sad":
      return <Face happy={false} />;
    case "big":
      return <Body big />;
    case "small":
      return <Body big={false} />;
    case "thumbUp":
      return <Thumb up />;
    case "thumbDown":
      return <Thumb up={false} />;
    case "hide":
      return <Peek hidden />;
    case "peek":
      return <Peek hidden={false} />;
    default: {
      // Exhaustive: a new GlyphName with no shape is a compile error, not a
      // blank button a child taps and nothing happens.
      const never: never = name;
      return <g data-glyph-missing={String(never)} />;
    }
  }
}

export function Glyph({ name }: { name: GlyphName }) {
  return (
    <svg
      className="glyph"
      data-glyph={name}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      {shapeFor(name)}
    </svg>
  );
}
