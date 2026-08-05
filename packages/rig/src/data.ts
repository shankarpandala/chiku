// Pure data lifted verbatim from the canonical Claude Design export
// (design/ChikuFace.dc.html). If the export changes, regenerate these values —
// never tweak them here by eye.

import type { Emote, Viseme } from "./types";

/** Character palette (hexes exactly as exported). */
export const PALETTE = {
  /** Head / body fill. */
  body: "#a293c4",
  /** Outer ears, legs, hair strokes. */
  bodyShade: "#8b7ab0",
  /** Belly, feet. */
  bodyLight: "#cdc3e4",
  /** Inner ear pink. */
  innerEar: "#e9b6b4",
  /** Trunk outline stroke. */
  trunkOuter: "#7d6da3",
  /** Trunk inner stroke. */
  trunkInner: "#a698ca",
  /** Eyes (pupils), brows, mouth. */
  ink: "#2c2a35",
  /** Eye whites, glints. */
  cream: "#fdf6ec",
  /** Blush, tongue. */
  blush: "#e9848c",
  /** Listening ring + level bars. */
  teal: "#2f8f86",
} as const;

/** Viseme → mouth path dictionary. */
export const MOUTHS: Record<Viseme, string> = {
  closed: "M102 174 Q124 187 146 174 Q124 181 102 174 Z",
  A: "M105 166 Q124 157 143 166 Q138 196 124 196 Q110 196 105 166 Z",
  E: "M103 169 Q124 163 145 169 Q135 186 124 186 Q113 186 103 169 Z",
  O: "M124 160 C136 160 143 169 143 179 C143 190 136 198 124 198 C112 198 105 190 105 179 C105 169 112 160 124 160 Z",
  U: "M124 163 C133 163 139 171 139 180 C139 190 132 197 124 197 C116 197 109 190 109 180 C109 171 115 163 124 163 Z",
  F: "M103 174 Q124 167 145 174 Q124 186 103 174 Z",
  L: "M105 166 Q124 157 143 166 Q138 194 124 194 Q110 194 105 166 Z",
  smile: "M100 168 Q124 203 148 168 Q124 180 100 168 Z",
};

export type TrunkPose = "down" | "wave" | "lift";

/** Trunk pose → the three bezier segments [t1, t2, t3] (head → tip). */
export const TRUNKS: Record<TrunkPose, readonly [string, string, string]> = {
  down: [
    "M110 122 C104 140 96 154 84 162",
    "M84 162 C72 170 58 170 50 162",
    "M50 162 C43 155 44 145 51 141",
  ],
  wave: [
    "M110 122 C104 138 98 150 88 156",
    "M88 156 C76 160 62 154 58 142",
    "M58 142 C56 130 62 122 70 122",
  ],
  lift: [
    "M110 122 C104 138 98 150 88 156",
    "M88 156 C76 160 64 156 60 146",
    "M60 146 C58 138 62 132 68 131",
  ],
};

/** Everything that varies per emote, tabularized from the export's renderVals(). */
export interface EmoteParams {
  readonly defaultViseme: Viseme;
  readonly eyes: "open" | "happy";
  readonly eyeR: number;
  readonly pupilY: number;
  readonly pupilLX: number;
  readonly pupilRX: number;
  readonly glintY: number;
  readonly glintLX: number;
  readonly glintRX: number;
  readonly browL: string;
  readonly browR: string;
  readonly tilt: string;
  readonly earL: string;
  readonly earR: string;
  readonly trunk: TrunkPose;
  readonly ring: boolean;
  readonly bars: boolean;
  readonly blush: boolean;
}

// Gaze derived from the export's `look` flag: front (look=0) vs up-left (look=1,
// thinking only). Values are the base coordinates plus the look offsets.
const GAZE_FRONT = {
  pupilY: 98,
  pupilLX: 90,
  pupilRX: 158,
  glintY: 90,
  glintLX: 82,
  glintRX: 150,
} as const;

const GAZE_UP = {
  pupilY: 91,
  pupilLX: 94,
  pupilRX: 162,
  glintY: 85,
  glintLX: 88,
  glintRX: 156,
} as const;

const BROWS_REST = {
  browL: "M76 66 Q88 60 100 64",
  browR: "M144 64 Q156 60 168 66",
} as const;

export const EMOTES: Record<Emote, EmoteParams> = {
  idle: {
    defaultViseme: "closed",
    eyes: "open",
    eyeR: 17,
    ...GAZE_FRONT,
    ...BROWS_REST,
    tilt: "rotate(0)",
    earL: "rotate(0)",
    earR: "rotate(0)",
    trunk: "down",
    ring: false,
    bars: false,
    blush: false,
  },
  listening: {
    defaultViseme: "closed",
    eyes: "open",
    eyeR: 19,
    ...GAZE_FRONT,
    browL: "M74 62 Q88 52 102 58",
    browR: "M142 58 Q156 52 170 62",
    tilt: "rotate(-5)",
    earL: "rotate(-14) scale(1.08)",
    earR: "rotate(5)",
    trunk: "down",
    ring: true,
    bars: true,
    blush: false,
  },
  happy: {
    defaultViseme: "smile",
    eyes: "happy",
    eyeR: 17,
    ...GAZE_FRONT,
    ...BROWS_REST,
    tilt: "rotate(0)",
    earL: "rotate(0)",
    earR: "rotate(9)",
    trunk: "down",
    ring: false,
    bars: false,
    blush: true,
  },
  encouraging: {
    defaultViseme: "closed",
    eyes: "open",
    eyeR: 17,
    ...GAZE_FRONT,
    browL: "M74 64 Q88 52 102 60",
    browR: "M142 60 Q156 56 170 66",
    tilt: "rotate(3)",
    earL: "rotate(0)",
    earR: "rotate(0)",
    trunk: "lift",
    ring: false,
    bars: false,
    blush: true,
  },
  goodbye: {
    defaultViseme: "smile",
    eyes: "happy",
    eyeR: 17,
    ...GAZE_FRONT,
    ...BROWS_REST,
    tilt: "rotate(-4)",
    earL: "rotate(-8)",
    earR: "rotate(0)",
    trunk: "wave",
    ring: false,
    bars: false,
    blush: false,
  },
  thinking: {
    defaultViseme: "U",
    eyes: "open",
    eyeR: 17,
    ...GAZE_UP,
    browL: "M74 66 Q88 54 102 62",
    browR: "M142 56 Q156 48 170 58",
    tilt: "rotate(0)",
    earL: "rotate(0)",
    earR: "rotate(0)",
    trunk: "lift",
    ring: false,
    bars: false,
    blush: false,
  },
};

/** Head outline + hair strokes (static geometry). */
export const HEAD_PATH =
  "M120 28 C182 28 198 66 198 110 C198 164 166 200 120 200 C74 200 42 164 42 110 C42 66 58 28 120 28 Z";
export const HAIR_PATHS: readonly [string, string] = [
  "M100 31 C97 19 105 11 113 15",
  "M118 28 C120 16 130 10 136 16",
];

/** Arc eyes shown for happy/goodbye (the export's eyesHappy layer). */
export const ARC_EYE_PATHS: readonly [string, string] = [
  "M75 100 Q88 84 101 100",
  "M143 100 Q156 84 169 100",
];
