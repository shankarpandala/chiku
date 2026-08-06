/**
 * The magic window, detected.
 *
 * `quad.ts` defines what a window IS and supplies the geometry; this decides
 * whether the child is making one right now, and hands the app a signal steady
 * enough to draw. Pure over landmark arrays — no MediaPipe import, no camera,
 * no clock — so every rule below is testable from hand-built fixtures.
 *
 * NOTHING HERE LEAVES THE DEVICE. Landmarks in, four numbers-pairs out. There
 * is no fetch in this file and there must never be one: the whole reason this
 * port exists without the reference's cloud video model is that a child's hands
 * are not something we send anywhere.
 *
 * THE LADDER
 * ----------
 * Tried in order of the bilateral coordination each demands, hardest first:
 *
 *   FRAME  (7-8)  both hands, the reference's own director's-frame gesture
 *   PINCH  (5-6)  one hand, thumb + index, an aperture
 *   PALM   (3-4)  one open palm, a window centred on it
 *
 * Hardest-first is deliberate: a 7-year-old holding a proper two-handed frame
 * also has an open palm somewhere in there, and should get the frame they
 * meant. A 3-year-old who cannot coordinate two hands falls through to the palm
 * and never learns they "failed" — the ladder exists so that no child fails at
 * the INPUT before they reach the thing we are trying to show them.
 *
 * STICKY, NOT FLICKERY
 * --------------------
 * Whichever kind is already active is preferred over anything the ladder would
 * otherwise pick, and a challenger must win `KIND_SWITCH_FRAMES` consecutive
 * frames before it takes over. A window that changes shape twice a second
 * because the tracker cannot decide between "palm" and "pinch" is worse than a
 * slightly wrong window: a change the child cannot perceive as caused by them
 * reads as random, and random is what they stop trusting.
 *
 * FORGIVENESS
 * -----------
 * All four of Phase 1's primitives are reused as-is:
 *   - `HysteresisGate` per rung, strict to acquire and loose to keep;
 *   - `StablePoint` per corner, so one mis-detection cannot teleport the window
 *     across the screen and a still hand does not shimmer;
 *   - `Presence`, so the window fades in and out and survives a ~25-frame
 *     tracker dropout instead of blinking;
 * and the exit thresholds in `QUAD_THRESHOLDS` are looser than the reference's,
 * because the moment something appears inside a child's window their pose
 * degrades — they gasp, they lean in, they point at it. Losing the window at
 * exactly the instant it becomes interesting is the one failure that would make
 * this feature not worth having.
 */

import {
  ADULT_THRESHOLDS,
  countExtendedFingers,
  type FingerThresholds,
  type Landmark,
} from "./fingers";
import {
  LM,
  QUAD_THRESHOLDS,
  frameCorners,
  handScale,
  pinchCorners,
  polygonArea,
  quadCentre,
  squareAround,
  type Quad,
  type QuadKind,
} from "./quad";
import {
  DEFAULT_LOST_FRAMES,
  HysteresisGate,
  Presence,
  StablePoint,
  distance,
  type Point,
} from "./stability";

/** Four corners, the shape every rung produces. */
export type Corners = readonly [Point, Point, Point, Point];

/** One hand, as this module wants it: just its 21 landmarks. */
export type HandLandmarks = readonly Landmark[];

/**
 * Hardest coordination first. See the header — this order is the reason a
 * 7-year-old gets the frame they meant and a 3-year-old still gets a window.
 */
export const QUAD_LADDER: readonly QuadKind[] = ["frame", "pinch", "palm"];

/**
 * Palm window half-width, in multiples of `handScale` (wrist -> middle MCP).
 *
 * WHY 1.6. `handScale` is roughly the palm's length, and a whole hand — wrist
 * to fingertip — measures about 2.2 of them, so the hand's own radius about its
 * palm centre is roughly 1.3. A half-width of 1.6 therefore puts the frame
 * comfortably OUTSIDE the fingers (a ~3.2-wide square around a ~2.6-wide hand)
 * rather than cropping them. That margin is the point: the window is a thing
 * the child holds up and looks THROUGH, so their own fingers must not be the
 * first thing inside it. Bigger than this and the window stops reading as
 * something they are holding.
 */
export const PALM_WINDOW_HALF_SCALES = 1.6;

/**
 * …but never more than this, in normalized units. A hand shoved at the lens
 * has a huge `handScale`, and without a cap the window would be several times
 * the screen — which is indistinguishable from no window at all.
 */
export const PALM_WINDOW_MAX_HALF = 0.45;

/**
 * Consecutive frames a DIFFERENT rung must win before it takes the window from
 * the active one. Three frames is ~125ms at 24fps and ~500ms on a throttled
 * device — long enough that a single confused frame changes nothing, short
 * enough that a child deliberately switching hands is not left waiting.
 * Counted in frames, not milliseconds, for the reason the whole forgiveness
 * layer is: a wall-clock tolerance silently becomes zero the moment the device
 * slows down, which is exactly when it is needed.
 */
export const KIND_SWITCH_FRAMES = 3;

/**
 * How far a corner may move in one frame before we disbelieve it. Matches
 * `StablePoint`'s own default: 30% of the frame in one step is not a hand, it
 * is a mis-detection, and it must insist for two frames to be believed.
 */
export const QUAD_JUMP_THRESHOLD = 0.3;

/** Below this a "hand" is a degenerate blob; dividing by it produces nonsense. */
export const MIN_HAND_SCALE = 1e-4;

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thumb-to-index gap as a multiple of the hand's own size — the reference's
 * spread, made distance-invariant. 0 when the hand is unmeasurable, which
 * releases any gate fed with it.
 */
export function spreadOf(lm: HandLandmarks): number {
  const scale = handScale(lm);
  if (scale < MIN_HAND_SCALE) return 0;
  const thumb = lm[LM.thumbTip];
  const index = lm[LM.indexTip];
  if (thumb === undefined || index === undefined) return 0;
  return distance(thumb, index) / scale;
}

/**
 * How open the hand is, 0..1, as the fraction of fingers extended.
 *
 * Deliberately over FIVE fingers including the thumb, which is what makes
 * `QUAD_THRESHOLDS.palmEnter` (0.8) mean exactly "four fingers out, thumb
 * optional": children hold a palm up with a floppy thumb and requiring it made
 * real open palms go unnoticed (the same finding that shaped `isOpenPalm`).
 * And `palmExit` (0.35) means "two fingers still out" — a palm that sags into a
 * loose claw while the child stares at what is inside their window keeps it.
 *
 * Uses `extended` rather than `total` on purpose: `total` is null whenever the
 * hand is too ambiguous to COUNT, and a window is not a count. We do not need
 * to know whether it is four fingers or five to know it is a palm.
 */
export function opennessOf(
  lm: HandLandmarks,
  thresholds: FingerThresholds = ADULT_THRESHOLDS,
): number {
  const count = countExtendedFingers(lm, thresholds);
  let out = 0;
  for (const e of count.extended) if (e) out += 1;
  return out / 5;
}

/**
 * A pinch is thumb + index doing the work, so a hand with middle, ring AND
 * pinky all out is not one — it is an open palm, and it must fall through to
 * the palm rung instead of being read as an enormous pinch. Only the full
 * three-finger case is excluded: a stray pinky is left alone, because insisting
 * on a tidy pinch is exactly the kind of demand this ladder exists to remove.
 */
export function isPinchShape(
  lm: HandLandmarks,
  thresholds: FingerThresholds = ADULT_THRESHOLDS,
): boolean {
  const count = countExtendedFingers(lm, thresholds);
  return !(count.extended[2] && count.extended[3] && count.extended[4]);
}

/** Palm centre: the centroid of the wrist and the knuckle line. */
export function palmCentre(lm: HandLandmarks): Point | null {
  const wrist = lm[LM.wrist];
  const index = lm[LM.indexMcp];
  const middle = lm[LM.middleMcp];
  const pinky = lm[LM.pinkyMcp];
  if (wrist === undefined || index === undefined) return null;
  if (middle === undefined || pinky === undefined) return null;
  return quadCentre([wrist, index, middle, pinky]);
}

/* -------------------------------------------------------------------------- */
/* Smoothing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Four `StablePoint`s, one per corner.
 *
 * Per-corner rather than centre-plus-size on purpose: the frame rung's corners
 * come from two independently tracked hands, and when one hand drops out for a
 * frame only its two corners should hold still — smoothing a shared centre
 * would drag the good hand's corners along with the bad one's.
 */
export class StableQuad {
  readonly #a = new StablePoint(QUAD_JUMP_THRESHOLD);
  readonly #b = new StablePoint(QUAD_JUMP_THRESHOLD);
  readonly #c = new StablePoint(QUAD_JUMP_THRESHOLD);
  readonly #d = new StablePoint(QUAD_JUMP_THRESHOLD);

  /** Feed this frame's raw corners, or null to hold the last good ones. */
  update(corners: Corners | null): Corners | null {
    const a = this.#a.update(corners === null ? null : corners[0]);
    const b = this.#b.update(corners === null ? null : corners[1]);
    const c = this.#c.update(corners === null ? null : corners[2]);
    const d = this.#d.update(corners === null ? null : corners[3]);
    if (a === null || b === null || c === null || d === null) return null;
    return [a, b, c, d];
  }

  get value(): Corners | null {
    return this.update(null);
  }

  reset(): void {
    this.#a.reset();
    this.#b.reset();
    this.#c.reset();
    this.#d.reset();
  }
}

/* -------------------------------------------------------------------------- */
/* The detector                                                               */
/* -------------------------------------------------------------------------- */

export class QuadDetector {
  /** Both frame gates are fed every frame, so neither can go stale. */
  readonly #frameSpread = new HysteresisGate({
    enter: QUAD_THRESHOLDS.spreadEnter,
    exit: QUAD_THRESHOLDS.spreadExit,
  });
  readonly #frameArea = new HysteresisGate({
    enter: QUAD_THRESHOLDS.areaEnter,
    exit: QUAD_THRESHOLDS.areaExit,
  });
  readonly #pinchSpread = new HysteresisGate({
    enter: QUAD_THRESHOLDS.spreadEnter,
    exit: QUAD_THRESHOLDS.spreadExit,
  });
  readonly #palmOpen = new HysteresisGate({
    enter: QUAD_THRESHOLDS.palmEnter,
    exit: QUAD_THRESHOLDS.palmExit,
  });

  readonly #shape = new StableQuad();
  readonly #presence: Presence;

  #kind: QuadKind | null = null;
  #challenger: QuadKind | null = null;
  #challengerFrames = 0;

  constructor(maxLostFrames: number = DEFAULT_LOST_FRAMES) {
    this.#presence = new Presence(maxLostFrames);
  }

  /**
   * One frame. `hands` must be the PRIMARY person's hands only — a sibling's
   * hands are not offered here, so a sibling cannot make the child's window.
   * (`FrameReducer` is where that filtering happens.)
   */
  update(
    hands: readonly HandLandmarks[],
    thresholds: FingerThresholds = ADULT_THRESHOLDS,
  ): Quad | null {
    // Every rung is evaluated every frame — not just the winning one — so that
    // every gate keeps ageing. A gate only fed while its rung is on would still
    // be holding a stale `true` the next time the ladder looked at it.
    const candidates: Partial<Record<QuadKind, Corners>> = {
      frame: this.#frameRung(hands) ?? undefined,
      pinch: this.#pinchRung(hands, thresholds) ?? undefined,
      palm: this.#palmRung(hands, thresholds) ?? undefined,
    };

    const chosen = this.#choose(candidates);
    if (chosen === null) return this.#hold();

    const smoothed = this.#shape.update(chosen.corners);
    if (smoothed === null) return this.#hold();

    const presence = this.#presence.update(true);
    return {
      kind: chosen.kind,
      corners: smoothed,
      centre: quadCentre(smoothed),
      presence,
    };
  }

  /** Which rung is drawing the window right now, if any. */
  get kind(): QuadKind | null {
    return this.#kind;
  }

  reset(): void {
    this.#frameSpread.reset();
    this.#frameArea.reset();
    this.#pinchSpread.reset();
    this.#palmOpen.reset();
    this.#shape.reset();
    this.#presence.reset();
    this.#kind = null;
    this.#challenger = null;
    this.#challengerFrames = 0;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Nothing qualified this frame. Do NOT cut: hold the last good window and let
   * `Presence` age it, so a tracker blink is invisible and a child genuinely
   * putting their hands down gets a fade rather than a disappearance.
   */
  #hold(): Quad | null {
    const presence = this.#presence.update(false);
    const kind = this.#kind;
    const held = this.#shape.value;
    if (presence <= 0 || kind === null || held === null) {
      // Believed gone. Release everything, so the next window has to earn the
      // strict entry thresholds again rather than inheriting a warm gate.
      if (presence <= 0) this.reset();
      return null;
    }
    return { kind, corners: held, centre: quadCentre(held), presence };
  }

  /**
   * The ladder, with the incumbent favoured.
   *
   * Order of preference: the active kind if it still qualifies, else the
   * hardest-coordination rung that does — but only after it has won
   * `KIND_SWITCH_FRAMES` in a row. While a challenger is still proving itself
   * the window holds, which is why this returns null rather than the challenger.
   */
  #choose(
    candidates: Partial<Record<QuadKind, Corners>>,
  ): { readonly kind: QuadKind; readonly corners: Corners } | null {
    const active = this.#kind;
    if (active !== null) {
      const held = candidates[active];
      if (held !== undefined) {
        this.#challenger = null;
        this.#challengerFrames = 0;
        return { kind: active, corners: held };
      }
    }

    let best: { readonly kind: QuadKind; readonly corners: Corners } | null = null;
    for (const kind of QUAD_LADDER) {
      const corners = candidates[kind];
      if (corners !== undefined) {
        best = { kind, corners };
        break;
      }
    }
    if (best === null) {
      this.#challenger = null;
      this.#challengerFrames = 0;
      return null;
    }

    // No window at all yet: adopt at once. There is nothing to flicker away
    // from, and making a child hold a pose for three frames before anything
    // appears reads as the app ignoring them.
    if (active === null) {
      this.#adopt(best.kind);
      return best;
    }

    if (this.#challenger === best.kind) this.#challengerFrames += 1;
    else {
      this.#challenger = best.kind;
      this.#challengerFrames = 1;
    }
    if (this.#challengerFrames < KIND_SWITCH_FRAMES) return null;

    this.#adopt(best.kind);
    return best;
  }

  #adopt(kind: QuadKind): void {
    if (this.#kind !== null && this.#kind !== kind) {
      // A genuine change of gesture moves the corners somewhere unrelated, and
      // that IS a teleport as far as `StablePoint` is concerned. Clearing the
      // smoothers lets the new window appear where the child's hands actually
      // are instead of crawling there over several frames. Safe because a
      // switch has already survived `KIND_SWITCH_FRAMES` of scrutiny.
      this.#shape.reset();
    }
    this.#kind = kind;
    this.#challenger = null;
    this.#challengerFrames = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Rungs                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * FRAME (7-8): both hands, the reference's gesture. Hands are ordered by
   * wrist x so `frameCorners`' anatomical cycle stays a rectangle rather than a
   * bowtie as the child moves, and both the spread and the enclosed area must
   * pass — spread alone would accept two hands touching, which encloses nothing.
   */
  #frameRung(hands: readonly HandLandmarks[]): Corners | null {
    const pair = twoLargest(hands);
    if (pair === null) {
      this.#frameSpread.update(0);
      this.#frameArea.update(0);
      return null;
    }
    const [a, b] = pair;
    const corners = frameCorners(a, b);
    if (corners === null) {
      this.#frameSpread.update(0);
      this.#frameArea.update(0);
      return null;
    }
    // The WEAKER hand's spread gates the pair: one good hand and one closed fist
    // is not a frame, however convincing the good hand looks.
    const spreadOn = this.#frameSpread.update(Math.min(spreadOf(a), spreadOf(b)));
    const areaOn = this.#frameArea.update(polygonArea(corners));
    return spreadOn && areaOn ? corners : null;
  }

  /**
   * PINCH (5-6): one hand's thumb-index aperture. The widest eligible hand
   * wins, so a child who pinches with one hand while the other rests gets the
   * window they meant.
   */
  #pinchRung(hands: readonly HandLandmarks[], thresholds: FingerThresholds): Corners | null {
    let best: HandLandmarks | null = null;
    let bestSpread = 0;
    for (const hand of hands) {
      if (!isPinchShape(hand, thresholds)) continue;
      const spread = spreadOf(hand);
      if (best === null || spread > bestSpread) {
        best = hand;
        bestSpread = spread;
      }
    }
    const on = this.#pinchSpread.update(best === null ? 0 : bestSpread);
    if (!on || best === null) return null;
    return pinchCorners(best);
  }

  /**
   * PALM (3-4): one open palm, a square around it. The most open hand wins.
   */
  #palmRung(hands: readonly HandLandmarks[], thresholds: FingerThresholds): Corners | null {
    let best: HandLandmarks | null = null;
    let bestOpen = 0;
    for (const hand of hands) {
      const open = opennessOf(hand, thresholds);
      if (best === null || open > bestOpen) {
        best = hand;
        bestOpen = open;
      }
    }
    const on = this.#palmOpen.update(best === null ? 0 : bestOpen);
    if (!on || best === null) return null;

    const centre = palmCentre(best);
    const scale = handScale(best);
    if (centre === null || scale < MIN_HAND_SCALE) return null;
    const half = Math.min(PALM_WINDOW_MAX_HALF, PALM_WINDOW_HALF_SCALES * scale);
    return squareAround(centre, half);
  }
}

/**
 * The two biggest hands, ordered by wrist x (left first, as the image sees it).
 * Biggest first because with three attributed hands the two nearest the camera
 * are the ones being held up deliberately; ordering by x afterwards is what
 * `frameCorners` needs.
 */
function twoLargest(
  hands: readonly HandLandmarks[],
): readonly [HandLandmarks, HandLandmarks] | null {
  if (hands.length < 2) return null;
  const ranked = [...hands].sort((p, q) => handScale(q) - handScale(p)).slice(0, 2);
  const a = ranked[0];
  const b = ranked[1];
  if (a === undefined || b === undefined) return null;
  const ax = a[LM.wrist]?.x ?? 0;
  const bx = b[LM.wrist]?.x ?? 0;
  return ax <= bx ? [a, b] : [b, a];
}
