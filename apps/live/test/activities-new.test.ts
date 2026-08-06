// Phase 5's four new activities, at the level where a child feels them.
//
// Every test below is a sentence about a real room: a sibling reaching into
// frame, a phone dropping a detection, a hand held sideways, a child walking
// out. All four activities are pure functions over `VisionFrame`, so all four
// are testable without a camera, a WASM runtime or a real child.
//
// Frames are spaced 200ms apart throughout — the real interval on the
// mid-range Android the engine throttles to ~5fps, and the number that turned
// every wall-clock tolerance in this app into zero tolerance.

import { describe, expect, it } from "vitest";

import {
  createSuccessorActivity,
  SUCCESSOR_BASE_FRAMES,
  SUCCESSOR_DIRECT_FRAMES,
} from "../src/activities/successor";
import {
  BIG_MARGIN,
  BIGSMALL_STAGE_FRAMES,
  createBigSmallActivity,
  isBigPose,
  isSmallPose,
  SMALL_DROP,
  SMALL_SPREAD,
} from "../src/activities/bigsmall";
import {
  createThumbsActivity,
  isThumbOnlyShape,
  THUMB_DOWN_GESTURE,
  THUMB_UP_GESTURE,
  THUMBS_QUESTIONS,
  thumbVerdict,
} from "../src/activities/thumbs";
import {
  createPeekabooActivity,
  HIDE_RADIUS,
  PEEKABOO_ARM_FRAMES,
  PEEKABOO_HIDE_FRAMES,
  PEEKABOO_HIDE_MAX_MS,
} from "../src/activities/peekaboo";
import {
  ARM_REACH,
  faceImagePoint,
  FaceAnchor,
  verdictFor,
  type Activity,
} from "../src/activities/types";
import type { FaceSignal, HandSignal, VisionFrame } from "../src/vision/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The throttled-device frame interval. Everything is paced at this. */
const SLOW_FRAME_MS = 200;

/** A deterministic "random" so a factory's target is known, not guessed. */
function fixed(value: number): () => number {
  return () => value;
}

/**
 * Frames carry `facePresence` by default, because the engine always sets it and
 * a fixture that omits it is testing a surface bug rather than an activity.
 * The tests that care about a dropped detection set it explicitly.
 */
function frame(patch: Partial<VisionFrame> & { t: number }): VisionFrame {
  const seen = (patch.face ?? null) !== null;
  return {
    face: null,
    hands: [],
    totalFingers: null,
    waving: false,
    facePresence: seen ? 1 : 0,
    ...patch,
  };
}

/** A face at the centre of the image unless placed. `y` is -1 up … +1 down. */
function face(patch: Partial<FaceSignal> = {}): FaceSignal {
  return { x: 0, y: 0, attention: 0.9, smile: 0, ...patch };
}

/** A hand with a wrist in 0..1 image space. Shape defaults to a flat palm. */
function hand(patch: Partial<HandSignal> & { wrist: { x: number; y: number } }): HandSignal {
  return {
    handedness: "Right",
    fingers: 5,
    extended: [true, true, true, true, true],
    gesture: null,
    ...patch,
  };
}

/** A thumb-only hand: thumb out, everything else curled. */
function thumb(
  gesture: string | null,
  wrist = { x: 0.5, y: 0.5 },
  extended: HandSignal["extended"] = [true, false, false, false, false],
): HandSignal {
  return { handedness: "Right", fingers: 1, extended, gesture, wrist };
}

/** Play a list of frames through an activity, collecting one verdict each. */
function play(activity: Activity, frames: readonly VisionFrame[]): string[] {
  return frames.map((f) => verdictFor(activity, f));
}

/** `n` frames, `build` given the frame index, spaced at the slow rate. */
function frames(n: number, build: (i: number, t: number) => Partial<VisionFrame>): VisionFrame[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i * SLOW_FRAME_MS;
    return frame({ t, ...build(i, t) });
  });
}

/* ========================================================================== */
/* successor — "ఇంకో వేలు!"                                                    */
/* ========================================================================== */

describe("successor: the step from N to N+1", () => {
  /** random() === 0 puts the base at the bottom of [1, 3]. */
  const baseOne = () => createSuccessorActivity(fixed(0));
  /** random() === 0.9 puts it at the top: base 3, successor 4. */
  const baseThree = () => createSuccessorActivity(fixed(0.9));

  it("asks for a base that keeps the successor on one hand", () => {
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const activity = createSuccessorActivity(fixed(r));
      const base = Number(activity.promptValues?.["n"]);
      const next = Number(activity.promptValues?.["next"]);
      expect(base).toBeGreaterThanOrEqual(1);
      expect(base).toBeLessThanOrEqual(3);
      expect(next).toBe(base + 1);
      // Crossing to a second hand would turn "add one" into "start again".
      expect(next).toBeLessThanOrEqual(5);
    }
  });

  it("does not fire on the successor until the base has been held", () => {
    const activity = baseThree();
    // Straight to four, once. That is not a step, it is a guess.
    expect(verdictFor(activity, frame({ t: 0, totalFingers: 4 }))).toBe("mismatch");
  });

  it("fires once the child settles on the base and then adds one", () => {
    const activity = baseThree();
    const script = [
      ...frames(SUCCESSOR_BASE_FRAMES, () => ({ totalFingers: 3 })),
      frame({ t: 999, totalFingers: 4 }),
    ];
    const verdicts = play(activity, script);
    expect(verdicts.slice(0, SUCCESSOR_BASE_FRAMES)).toEqual(
      Array(SUCCESSOR_BASE_FRAMES).fill("mismatch"),
    );
    expect(verdicts[verdicts.length - 1]).toBe("match");
  });

  it("needs more than one flickering frame of the base", () => {
    const activity = baseThree();
    // A hand opening from a fist passes through 3 for exactly one frame.
    play(activity, [frame({ t: 0, totalFingers: 3 }), frame({ t: 200, totalFingers: 1 })]);
    expect(verdictFor(activity, frame({ t: 400, totalFingers: 4 }))).toBe("mismatch");
  });

  it("a sibling's fingers cannot make the step — totalFingers is subject-locked", () => {
    const activity = baseThree();
    // The child is settled on three. A sibling puts one finger in frame, which
    // shows up in `hands` but NOT in `totalFingers` (the engine locks the
    // subject). If this activity summed `hands` it would read four and cheer.
    const settle = frames(SUCCESSOR_BASE_FRAMES, () => ({ totalFingers: 3 }));
    play(activity, settle);
    const sibling = frame({
      t: 1000,
      totalFingers: 3,
      hands: [
        hand({ wrist: { x: 0.4, y: 0.5 }, fingers: 3 }),
        hand({ wrist: { x: 0.9, y: 0.5 }, fingers: 1 }),
      ],
    });
    expect(verdictFor(activity, sibling)).toBe("mismatch");
  });

  it("an uncountable hand is unknown, never wrong", () => {
    const activity = baseThree();
    play(activity, frames(SUCCESSOR_BASE_FRAMES, () => ({ totalFingers: 3 })));
    expect(verdictFor(activity, frame({ t: 900, totalFingers: null }))).toBe("unknown");
  });

  it("lets a child who anticipates the answer win eventually", () => {
    const activity = baseOne();
    const next = Number(activity.promptValues?.["next"]);
    // They never show the base at all — they go straight to the successor and
    // hold it. That is more impressive than the step, not less.
    const script = frames(SUCCESSOR_DIRECT_FRAMES, () => ({ totalFingers: next }));
    const verdicts = play(activity, script);
    expect(verdicts[0]).toBe("mismatch");
    expect(verdicts[verdicts.length - 1]).toBe("match");
  });

  it("going back to the base cancels an anticipation run", () => {
    const activity = baseOne();
    const base = Number(activity.promptValues?.["n"]);
    const next = base + 1;
    // Nearly enough frames of the successor, then back to the base — which
    // re-arms the honest path rather than the shortcut.
    play(
      activity,
      frames(SUCCESSOR_DIRECT_FRAMES - 1, () => ({ totalFingers: next })),
    );
    play(activity, [frame({ t: 5000, totalFingers: base })]);
    // One frame of the base is not yet the settled base either.
    expect(verdictFor(activity, frame({ t: 5200, totalFingers: next }))).toBe("mismatch");
  });

  it("counts each frame once however many times the runner asks", () => {
    const activity = baseThree();
    const f = frame({ t: 0, totalFingers: 3 });
    // hasEvidence + matches + a surface peeking at progress: same frame, and
    // the frame counter must not advance three times.
    activity.hasEvidence(f);
    activity.matches(f);
    activity.hasEvidence(f);
    expect(verdictFor(activity, frame({ t: 200, totalFingers: 4 }))).toBe("mismatch");
  });

  it("says the successor out loud, in both languages", () => {
    const activity = baseThree();
    expect(activity.accepts("naalugu")).toBe(true);
    expect(activity.accepts("four!")).toBe(true);
    expect(activity.accepts("నాలుగు")).toBe(true);
    // The base is not the answer to "what comes after three".
    expect(activity.accepts("moodu")).toBe(false);
  });

  it("has a tap answer that stands alone with no camera", () => {
    const activity = baseThree();
    expect(activity.choices).toHaveLength(5);
    const correct = activity.choices.filter((c) => c.correct);
    expect(correct).toHaveLength(1);
    expect(correct[0]?.digit).toBe(4);
    // A pre-reader counts the dots; nobody has to read a word.
    for (const choice of activity.choices) expect(choice.digit).toBeGreaterThan(0);
  });

  it("demonstrates the count and then, visibly, the extra one", () => {
    const activity = baseThree();
    const beats = activity.demonstrate?.() ?? [];
    // Three counting beats plus the "and one more" beat.
    expect(beats).toHaveLength(4);
    expect(beats[beats.length - 1]?.key).toBe("demo.successor.more");
    expect(beats[beats.length - 1]?.values?.["next"]).toBe(4);
    const total = beats.reduce((sum, b) => sum + b.ms, 0);
    // Short enough that a stuck three-year-old still watches it.
    expect(total).toBeLessThanOrEqual(3000);
  });
});

/* ========================================================================== */
/* bigsmall — పెద్ద / చిన్న                                                     */
/* ========================================================================== */

/** Face centre in wrist space, for a face signal at the image centre. */
const CENTRE = faceImagePoint(face());

describe("bigsmall: the poses themselves", () => {
  it("reads both wrists above the face as BIG", () => {
    const hands = [
      hand({ wrist: { x: 0.35, y: CENTRE.y - BIG_MARGIN - 0.1 } }),
      hand({ wrist: { x: 0.65, y: CENTRE.y - BIG_MARGIN - 0.1 } }),
    ];
    expect(isBigPose(hands, CENTRE)).toBe(true);
  });

  it("does not read one arm up as BIG", () => {
    const hands = [
      hand({ wrist: { x: 0.35, y: CENTRE.y - 0.3 } }),
      hand({ wrist: { x: 0.65, y: CENTRE.y + 0.3 } }),
    ];
    expect(isBigPose(hands, CENTRE)).toBe(false);
  });

  it("reads both wrists low and tucked in as small", () => {
    const hands = [
      hand({ wrist: { x: 0.46, y: CENTRE.y + SMALL_DROP + 0.05 } }),
      hand({ wrist: { x: 0.54, y: CENTRE.y + SMALL_DROP + 0.05 } }),
    ];
    expect(isSmallPose(hands, CENTRE)).toBe(true);
  });

  it("does NOT read arms flung out sideways at hip height as small", () => {
    // The failure that matters: this is nearly the opposite pose, and the whole
    // lesson is that the two are opposites.
    const hands = [
      hand({ wrist: { x: 0.5 - SMALL_SPREAD, y: CENTRE.y + SMALL_DROP + 0.05 } }),
      hand({ wrist: { x: 0.5 + SMALL_SPREAD, y: CENTRE.y + SMALL_DROP + 0.05 } }),
    ];
    expect(isSmallPose(hands, CENTRE)).toBe(false);
  });
});

describe("bigsmall: the round", () => {
  const big = (y = CENTRE.y - 0.25) => [
    hand({ wrist: { x: 0.38, y } }),
    hand({ wrist: { x: 0.62, y }, handedness: "Left" }),
  ];
  const small = () => [
    hand({ wrist: { x: 0.47, y: CENTRE.y + 0.3 } }),
    hand({ wrist: { x: 0.55, y: CENTRE.y + 0.3 }, handedness: "Left" }),
  ];

  it("only accepts small AFTER big — the pair is the lesson", () => {
    const activity = createBigSmallActivity(fixed(0));
    expect(verdictFor(activity, frame({ t: 0, face: face(), hands: small() }))).toBe("mismatch");
  });

  it("completes the sentence: big, then small", () => {
    const activity = createBigSmallActivity(fixed(0));
    const script = [
      ...frames(BIGSMALL_STAGE_FRAMES, () => ({ face: face(), hands: big() })),
      frame({ t: 900, face: face(), hands: small() }),
    ];
    const verdicts = play(activity, script);
    expect(verdicts[verdicts.length - 1]).toBe("match");
  });

  it("survives a dropped face detection mid-pose", () => {
    // THE false-trigger case for this activity. The face is the ruler every
    // wrist is measured against; one dropped detection must not delete it and
    // score a child holding a perfect pose as "not big".
    const activity = createBigSmallActivity(fixed(0));
    play(activity, frames(BIGSMALL_STAGE_FRAMES, () => ({ face: face(), hands: big() })));
    // The tracker blinks: no face this frame, but the engine still believes.
    const blink = frame({ t: 900, face: null, facePresence: 1, hands: small() });
    expect(verdictFor(activity, blink)).toBe("match");
  });

  it("goes unknown once the child is genuinely gone", () => {
    const activity = createBigSmallActivity(fixed(0));
    play(activity, frames(BIGSMALL_STAGE_FRAMES, () => ({ face: face(), hands: big() })));
    const gone = frame({ t: 900, face: null, facePresence: 0.1, hands: small() });
    expect(verdictFor(activity, gone)).toBe("unknown");
  });

  it("a sibling leaning in makes the frame unreadable, not wrong", () => {
    const activity = createBigSmallActivity(fixed(0));
    play(activity, frames(BIGSMALL_STAGE_FRAMES, () => ({ face: face(), hands: big() })));
    const crowded = frame({
      t: 900,
      face: face(),
      hands: [...small(), hand({ wrist: { x: 0.6, y: CENTRE.y + 0.25 } })],
    });
    expect(verdictFor(activity, crowded)).toBe("unknown");
  });

  it("ignores a hand that is nowhere near this child", () => {
    const activity = createBigSmallActivity(fixed(0));
    // A parent's hand at the far edge is outside arm's reach, so the child's
    // own two hands still read as exactly two candidates.
    const far = hand({ wrist: { x: CENTRE.x + ARM_REACH + 0.2, y: CENTRE.y } });
    const script = [
      ...frames(BIGSMALL_STAGE_FRAMES, () => ({ face: face(), hands: [...big(), far] })),
      frame({ t: 900, face: face(), hands: [...small(), far] }),
    ];
    expect(play(activity, script).pop()).toBe("match");
  });

  it("one hand lost is unknown, never wrong", () => {
    const activity = createBigSmallActivity(fixed(0));
    const only = frame({ t: 0, face: face(), hands: [hand({ wrist: { x: 0.4, y: 0.2 } })] });
    expect(verdictFor(activity, only)).toBe("unknown");
  });

  it("does not confuse the face and wrist coordinate spaces", () => {
    // `face.y` is -1 at the top; `wrist.y` is 0 at the top. A child standing
    // high in frame has face.y = -0.5, which is wrist-space 0.25 — so wrists at
    // 0.1 are above them and wrists at 0.45 are not.
    const high = faceImagePoint(face({ y: -0.5 }));
    expect(high.y).toBeCloseTo(0.25);
    expect(isBigPose([hand({ wrist: { x: 0.4, y: 0.1 } }), hand({ wrist: { x: 0.6, y: 0.1 } })], high)).toBe(true);
    expect(isBigPose([hand({ wrist: { x: 0.4, y: 0.45 } }), hand({ wrist: { x: 0.6, y: 0.45 } })], high)).toBe(false);
  });

  it("accepts చిన్న out loud, in either script", () => {
    const activity = createBigSmallActivity(fixed(0));
    expect(activity.accepts("chinna")).toBe(true);
    expect(activity.accepts("చిన్నది")).toBe(true);
    expect(activity.accepts("small")).toBe(true);
    // A child who names both halves still matches — the word is in there.
    expect(activity.accepts("pedda… chinna!")).toBe(true);
    // A child who only ever said "big" has done half the lesson.
    expect(activity.accepts("pedda")).toBe(false);
  });

  it("has a camera-free tap answer with exactly one right button", () => {
    const activity = createBigSmallActivity(fixed(0));
    expect(activity.choices).toHaveLength(2);
    expect(activity.choices.filter((c) => c.correct)).toHaveLength(1);
    expect(activity.choices.find((c) => c.correct)?.glyph).toBe("small");
    expect(new Set(activity.choices.map((c) => c.glyph))).toEqual(new Set(["big", "small"]));
  });

  it("puts the right answer in either slot, so position cannot be learned", () => {
    const first = createBigSmallActivity(fixed(0)).choices[0]?.id;
    const other = createBigSmallActivity(fixed(0.9)).choices[0]?.id;
    expect(first).not.toBe(other);
  });

  it("demonstrates both halves of the pair", () => {
    const beats = createBigSmallActivity(fixed(0)).demonstrate?.() ?? [];
    expect(beats.map((b) => b.key)).toEqual(["demo.bigsmall.big", "demo.bigsmall.small"]);
  });
});

/* ========================================================================== */
/* thumbs — the mic-free comprehension path                                    */
/* ========================================================================== */

describe("thumbs: reading a thumb", () => {
  it("believes a label its shape agrees with", () => {
    expect(thumbVerdict(frame({ t: 0, hands: [thumb(THUMB_UP_GESTURE)] }))).toBe("up");
    expect(thumbVerdict(frame({ t: 0, hands: [thumb(THUMB_DOWN_GESTURE)] }))).toBe("down");
  });

  it("refuses a rotated thumb: a label its shape contradicts", () => {
    // THE false-trigger case for this activity. MediaPipe's canned classes are
    // not rotation-invariant, so a hand held sideways gets a confident label
    // over a shape that is not a thumb-only hand at all. Believing it would be
    // Chiku telling a child they said "no" when they meant "yes".
    const rotated = thumb(THUMB_UP_GESTURE, { x: 0.5, y: 0.5 }, [true, true, false, false, false]);
    expect(thumbVerdict(frame({ t: 0, hands: [rotated] }))).toBe(null);
  });

  it("refuses a thumb the classifier would not name", () => {
    // The other half of the rotation failure: on a tilted hand the recogniser
    // often drops below its own confidence floor and reports nothing. A shape
    // with no label cannot tell up from down, so it is not an answer.
    expect(thumbVerdict(frame({ t: 0, hands: [thumb(null)] }))).toBe(null);
  });

  it("refuses two hands that disagree", () => {
    const two = frame({
      t: 0,
      hands: [thumb(THUMB_UP_GESTURE, { x: 0.3, y: 0.5 }), thumb(THUMB_DOWN_GESTURE, { x: 0.7, y: 0.5 })],
    });
    expect(thumbVerdict(two)).toBe(null);
  });

  it("lets a child rest their other hand in their lap", () => {
    const resting = hand({ wrist: { x: 0.2, y: 0.9 } });
    const one = frame({ t: 0, hands: [thumb(THUMB_UP_GESTURE), resting] });
    expect(thumbVerdict(one)).toBe("up");
  });

  it("accepts two hands that agree", () => {
    const both = frame({
      t: 0,
      hands: [thumb(THUMB_UP_GESTURE, { x: 0.3, y: 0.5 }), thumb(THUMB_UP_GESTURE, { x: 0.7, y: 0.5 })],
    });
    expect(thumbVerdict(both)).toBe("up");
  });

  it("knows the shape independently of which way it points", () => {
    expect(isThumbOnlyShape(thumb(null))).toBe(true);
    expect(isThumbOnlyShape(hand({ wrist: { x: 0.5, y: 0.5 } }))).toBe(false);
  });
});

describe("thumbs: the round", () => {
  /** Build the activity whose question has the wanted answer. */
  function activityFor(yes: boolean): Activity {
    const index = THUMBS_QUESTIONS.findIndex((q) => q.yes === yes);
    // randInt maps r into [0, n-1] by flooring r * n.
    const r = (index + 0.5) / THUMBS_QUESTIONS.length;
    return createThumbsActivity(() => r);
  }

  it("asks a question this session already taught", () => {
    for (const q of THUMBS_QUESTIONS) {
      expect(q.key.startsWith("act.thumbs.q.")).toBe(true);
    }
    // Balanced, so a child who has worked out that a raised thumb makes Chiku
    // happy cannot win by agreeing with everything.
    const yes = THUMBS_QUESTIONS.filter((q) => q.yes).length;
    expect(yes).toBe(THUMBS_QUESTIONS.length - yes);
  });

  it("scores the thumb that answers the question", () => {
    const activity = activityFor(true);
    expect(verdictFor(activity, frame({ t: 0, hands: [thumb(THUMB_UP_GESTURE)] }))).toBe("match");
    expect(verdictFor(activity, frame({ t: 200, hands: [thumb(THUMB_DOWN_GESTURE)] }))).toBe(
      "mismatch",
    );
  });

  it("scores a NO question the other way round", () => {
    const activity = activityFor(false);
    expect(verdictFor(activity, frame({ t: 0, hands: [thumb(THUMB_DOWN_GESTURE)] }))).toBe("match");
    expect(verdictFor(activity, frame({ t: 200, hands: [thumb(THUMB_UP_GESTURE)] }))).toBe(
      "mismatch",
    );
  });

  it("treats an unreadable thumb as unknown, never as the wrong answer", () => {
    const activity = activityFor(true);
    const rotated = thumb(THUMB_DOWN_GESTURE, { x: 0.5, y: 0.5 }, [true, true, true, false, false]);
    expect(verdictFor(activity, frame({ t: 0, hands: [rotated] }))).toBe("unknown");
    expect(verdictFor(activity, frame({ t: 200, hands: [] }))).toBe("unknown");
  });

  it("hears yes and no in both languages", () => {
    const yesAsk = activityFor(true);
    expect(yesAsk.accepts("avunu")).toBe(true);
    expect(yesAsk.accepts("అవును")).toBe(true);
    expect(yesAsk.accepts("yes!")).toBe(true);
    expect(yesAsk.accepts("kaadu")).toBe(false);

    const noAsk = activityFor(false);
    expect(noAsk.accepts("kaadu")).toBe(true);
    expect(noAsk.accepts("లేదు")).toBe(true);
    expect(noAsk.accepts("no")).toBe(true);
    expect(noAsk.accepts("avunu")).toBe(false);
  });

  it("has a tap answer whose correct button follows the question", () => {
    const yesAsk = activityFor(true);
    expect(yesAsk.choices.find((c) => c.correct)?.id).toBe("thumbs-yes");
    const noAsk = activityFor(false);
    expect(noAsk.choices.find((c) => c.correct)?.id).toBe("thumbs-no");
    for (const activity of [yesAsk, noAsk]) {
      expect(activity.choices).toHaveLength(2);
      expect(activity.choices.filter((c) => c.correct)).toHaveLength(1);
    }
  });

  it("demonstrates both thumbs and gives nothing away", () => {
    const activity = activityFor(false);
    const beats = activity.demonstrate?.() ?? [];
    // Both, in a fixed order — the help is "what is a thumbs-down", not "the
    // answer is no". The one comprehension check in the app must not be
    // turnable into a copying exercise.
    expect(beats.map((b) => b.key)).toEqual(["demo.thumbs.yes", "demo.thumbs.no"]);
  });
});

/* ========================================================================== */
/* peekaboo — దాగుడుమూతలు                                                      */
/* ========================================================================== */

describe("peekaboo", () => {
  const covering = () => [
    hand({ wrist: { x: CENTRE.x - 0.08, y: CENTRE.y - 0.05 } }),
    hand({ wrist: { x: CENTRE.x + 0.08, y: CENTRE.y - 0.05 }, handedness: "Left" }),
  ];
  const lap = () => [hand({ wrist: { x: CENTRE.x, y: CENTRE.y + HIDE_RADIUS + 0.2 } })];

  /** Frames of hands-on-face while still visible, then `gone` blank frames. */
  function hideScript(goneFrames: number, startAt = 0): VisionFrame[] {
    const seen = Array.from({ length: PEEKABOO_ARM_FRAMES }, (_, i) =>
      frame({ t: startAt + i * SLOW_FRAME_MS, face: face(), hands: covering() }),
    );
    const blank = Array.from({ length: goneFrames }, (_, i) =>
      frame({
        t: startAt + (PEEKABOO_ARM_FRAMES + i) * SLOW_FRAME_MS,
        face: null,
        facePresence: 1,
      }),
    );
    return [...seen, ...blank];
  }

  it("is delighted when a hidden child reappears", () => {
    const activity = createPeekabooActivity(fixed(0));
    play(activity, hideScript(PEEKABOO_HIDE_FRAMES));
    const back = frame({ t: 5000, face: face(), hands: lap() });
    expect(verdictFor(activity, back)).toBe("match");
  });

  it("does NOT fire when a child simply walks out of the room", () => {
    // THE false-trigger case for this activity. No hands anywhere near the
    // face, then the face is gone — and when someone comes back, whoever it is,
    // that is not a reveal.
    const activity = createPeekabooActivity(fixed(0));
    const script = [
      ...frames(3, () => ({ face: face(), hands: lap() })),
      ...Array.from({ length: 6 }, (_, i) =>
        frame({ t: 1000 + i * SLOW_FRAME_MS, face: null, facePresence: 1 }),
      ),
    ];
    play(activity, script);
    const returned = frame({ t: 5000, face: face(), hands: lap() });
    expect(verdictFor(activity, returned)).toBe("mismatch");
  });

  it("calls a child who left the room unknown, not wrong", () => {
    const activity = createPeekabooActivity(fixed(0));
    play(activity, frames(3, () => ({ face: face(), hands: lap() })));
    const scripted = Array.from({ length: PEEKABOO_HIDE_FRAMES + 2 }, (_, i) =>
      frame({ t: 1000 + i * SLOW_FRAME_MS, face: null, facePresence: 1 }),
    );
    const verdicts = play(activity, scripted);
    expect(verdicts[verdicts.length - 1]).toBe("unknown");
  });

  it("does not fire on a single dropped detection", () => {
    // Hands are on the face — the game IS armed — but the tracker only blinked.
    const activity = createPeekabooActivity(fixed(0));
    play(activity, hideScript(PEEKABOO_HIDE_FRAMES - 2));
    const back = frame({ t: 4000, face: face(), hands: covering() });
    expect(verdictFor(activity, back)).toBe("mismatch");
  });

  it("disarms when the hands come down again before the face goes", () => {
    const activity = createPeekabooActivity(fixed(0));
    play(activity, [
      ...frames(PEEKABOO_ARM_FRAMES, () => ({ face: face(), hands: covering() })),
      // Hands back in the lap. The game must not stay cocked all round.
      frame({ t: 900, face: face(), hands: lap() }),
      ...Array.from({ length: PEEKABOO_HIDE_FRAMES + 1 }, (_, i) =>
        frame({ t: 1200 + i * SLOW_FRAME_MS, face: null, facePresence: 1 }),
      ),
    ]);
    expect(verdictFor(activity, frame({ t: 4000, face: face() }))).toBe("mismatch");
  });

  it("stops waiting after a hide that is really an absence", () => {
    const activity = createPeekabooActivity(fixed(0));
    play(activity, hideScript(PEEKABOO_HIDE_FRAMES));
    // Still gone, long past any real peekaboo.
    play(activity, [frame({ t: PEEKABOO_HIDE_MAX_MS + 2000, face: null, facePresence: 1 })]);
    const someone = frame({ t: PEEKABOO_HIDE_MAX_MS + 4000, face: face() });
    expect(verdictFor(activity, someone)).toBe("mismatch");
  });

  it("ignores a hand that is not near the face", () => {
    const activity = createPeekabooActivity(fixed(0));
    // A hand raised but at chest height is not covering anything.
    const chest = [hand({ wrist: { x: CENTRE.x, y: CENTRE.y + HIDE_RADIUS + 0.05 } })];
    play(activity, [
      ...frames(PEEKABOO_ARM_FRAMES + 1, () => ({ face: face(), hands: chest })),
      ...Array.from({ length: PEEKABOO_HIDE_FRAMES + 1 }, (_, i) =>
        frame({ t: 2000 + i * SLOW_FRAME_MS, face: null, facePresence: 1 }),
      ),
    ]);
    expect(verdictFor(activity, frame({ t: 5000, face: face() }))).toBe("mismatch");
  });

  it("has no opinion before it has ever seen the child", () => {
    const activity = createPeekabooActivity(fixed(0));
    expect(verdictFor(activity, frame({ t: 0, face: null, facePresence: 0 }))).toBe("unknown");
  });

  it("stays found — the reveal is not undone by hiding again", () => {
    const activity = createPeekabooActivity(fixed(0));
    play(activity, hideScript(PEEKABOO_HIDE_FRAMES));
    play(activity, [frame({ t: 5000, face: face() })]);
    expect(verdictFor(activity, frame({ t: 5200, face: null, facePresence: 1 }))).toBe("match");
  });

  it("hears the call, in both languages", () => {
    const activity = createPeekabooActivity(fixed(0));
    expect(activity.accepts("idugo")).toBe(true);
    expect(activity.accepts("ఇదుగో")).toBe(true);
    expect(activity.accepts("peekaboo!")).toBe(true);
    expect(activity.accepts("here i am")).toBe(true);
    expect(activity.accepts("moodu")).toBe(false);
  });

  it("has a tap answer that works with the camera off", () => {
    const activity = createPeekabooActivity(fixed(0));
    expect(activity.choices).toHaveLength(2);
    expect(activity.choices.filter((c) => c.correct)).toHaveLength(1);
    expect(activity.choices.find((c) => c.correct)?.glyph).toBe("peek");
  });

  it("takes the first turn itself", () => {
    const beats = createPeekabooActivity(fixed(0)).demonstrate?.() ?? [];
    expect(beats.map((b) => b.key)).toEqual(["demo.peekaboo.hide", "demo.peekaboo.peek"]);
  });
});

/* ========================================================================== */
/* The shared pieces                                                          */
/* ========================================================================== */

describe("FaceAnchor", () => {
  it("keeps the last face through a tracker blink", () => {
    const anchor = new FaceAnchor();
    anchor.update(frame({ t: 0, face: face({ x: 0.2, y: -0.4 }) }));
    const held = anchor.update(frame({ t: 200, face: null, facePresence: 1 }));
    expect(held).toEqual(faceImagePoint(face({ x: 0.2, y: -0.4 })));
  });

  it("lets go once the engine stops believing", () => {
    const anchor = new FaceAnchor();
    anchor.update(frame({ t: 0, face: face() }));
    expect(anchor.update(frame({ t: 200, face: null, facePresence: 0.2 }))).toBe(null);
  });

  it("forgives a frame that carries no presence at all", () => {
    // Hand-built frames, and any surface that forgets to plumb `facePresence`.
    const anchor = new FaceAnchor();
    anchor.update({ t: 0, face: face(), hands: [], totalFingers: null, waving: false });
    const held = anchor.update({
      t: 200,
      face: null,
      hands: [],
      totalFingers: null,
      waving: false,
    });
    expect(held).toEqual(CENTRE);
  });
});

describe("every new activity keeps the contract", () => {
  const built: readonly [string, Activity][] = [
    ["successor", createSuccessorActivity(fixed(0.5))],
    ["bigsmall", createBigSmallActivity(fixed(0.5))],
    ["thumbs", createThumbsActivity(fixed(0.5))],
    ["peekaboo", createPeekabooActivity(fixed(0.5))],
  ];

  for (const [name, activity] of built) {
    it(`${name}: a tap answer, a spoken answer and a demonstration`, () => {
      expect(activity.choices.length).toBeGreaterThanOrEqual(2);
      expect(activity.choices.filter((c) => c.correct)).toHaveLength(1);
      // Every choice has SOMETHING to render: a numeral or a picture. A button
      // with neither is a blank square to a child who cannot read.
      for (const choice of activity.choices) {
        expect(choice.digit !== undefined || choice.glyph !== undefined).toBe(true);
      }
      expect(activity.answers.te.length).toBeGreaterThan(0);
      expect(activity.answers.en.length).toBeGreaterThan(0);
      expect(activity.demonstrate?.().length ?? 0).toBeGreaterThan(0);
      expect(activity.holdMs).toBeGreaterThan(0);
    });

    it(`${name}: an empty frame is unknown, never wrong`, () => {
      const empty = frame({ t: 0, face: null, facePresence: 0 });
      expect(verdictFor(activity, empty)).toBe("unknown");
    });
  }
});
