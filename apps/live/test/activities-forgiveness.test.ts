// @vitest-environment happy-dom
//
// The forgiveness layer, at the level where a child feels it.
//
// Every test here is a sentence about a real failure we shipped: one dropped
// detection reset a 600ms hold; a finger resting on 150deg flickered extended
// and curled; a single null face made Chiku glance away mid-sentence; a smile
// wobbling around 0.45 made his mouth snap. All of it is arithmetic, so all of
// it is testable without a camera, a WASM runtime or a real child.
//
// The frame intervals below are 200ms on purpose: that is the real spacing on
// the mid-range Android the engine throttles to ~5fps, and it is what turned
// every wall-clock tolerance in this app into zero tolerance.

import { describe, expect, it } from "vitest";

import {
  HoldTracker,
  HOLD_SLACK_FRAMES,
  HOLD_UNKNOWN_FRAMES,
  type HoldVerdict,
} from "../src/activities/hold";
import { createFingersActivity } from "../src/activities/fingers";
import { createSmileActivity, SMILE_BAND, SMILE_THRESHOLD } from "../src/activities/smile";
import { createWaveActivity } from "../src/activities/wave";
import { verdictFor } from "../src/activities/types";
import {
  createAttentionGate,
  ATTENTION_BAND,
  ATTENTION_HOLD_FRAMES,
} from "../src/components/CameraStage";
import {
  countExtendedFingers,
  FINGER_EXTENDED_MIN_ANGLE_DEG,
  FINGER_EXTENDED_RELEASE_ANGLE_DEG,
  StableHandCount,
  type FiveBooleans,
  type Landmark,
} from "../src/vision/fingers";
import type { FaceSignal, HandSignal, VisionFrame } from "../src/vision/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The throttled-device frame interval. Everything is paced at this. */
const SLOW_FRAME_MS = 200;

const HALF = (): number => 0.5;

function frame(patch: Partial<VisionFrame> & { t: number }): VisionFrame {
  return { face: null, hands: [], totalFingers: null, waving: false, ...patch };
}

function face(patch: Partial<FaceSignal> = {}): FaceSignal {
  return { x: 0, y: 0, attention: 0.9, smile: 0, ...patch };
}

function hand(): HandSignal {
  return {
    handedness: "Right",
    fingers: 3,
    extended: [false, true, true, true, false],
    gesture: null,
    wrist: { x: 0.5, y: 0.5 },
  };
}

/** Feed a whole script of verdicts at the slow frame rate; report completions. */
function run(
  tracker: HoldTracker,
  script: readonly HoldVerdict[],
  holdMs: number,
  startAt = 0,
): { completions: number; lastT: number } {
  let completions = 0;
  let t = startAt;
  for (const verdict of script) {
    if (tracker.update(verdict, t, holdMs)) completions += 1;
    t += SLOW_FRAME_MS;
  }
  return { completions, lastT: t - SLOW_FRAME_MS };
}

function repeat<T>(value: T, n: number): T[] {
  return Array.from({ length: n }, () => value);
}

/* -------------------------------------------------------------------------- */
/* Hand fixtures — a 21-landmark hand with exact PIP angles.                   */
/* -------------------------------------------------------------------------- */

interface Pt {
  x: number;
  y: number;
  z: number;
}

const CURLED = 30;

/** Place `c` so the interior angle a -> b -> c is exactly `angleDeg`. */
function pointAtAngle(a: Pt, b: Pt, angleDeg: number, len: number, sign = 1): Pt {
  const vx = a.x - b.x;
  const vy = a.y - b.y;
  const n = Math.hypot(vx, vy);
  const ux = vx / n;
  const uy = vy / n;
  const r = (sign * angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: b.x + len * (ux * cos - uy * sin), y: b.y + len * (ux * sin + uy * cos), z: 0 };
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
}

/** Palm to camera, fingers up, each finger bent to the requested PIP angle. */
function buildHand(
  spec: { index?: number; middle?: number; thumb?: number } = {},
): Landmark[] {
  const pts: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  pts[0] = { x: 0.5, y: 0.9, z: 0 };

  const cmc: Pt = { x: 0.42, y: 0.85, z: 0 };
  const thumbMcp: Pt = { x: 0.37, y: 0.79, z: 0 };
  const thumbAngle = spec.thumb ?? CURLED;
  const ip = pointAtAngle(cmc, thumbMcp, thumbAngle, 0.05, -1);
  pts[1] = cmc;
  pts[2] = thumbMcp;
  pts[3] = ip;
  pts[4] = pointAtAngle(thumbMcp, ip, thumbAngle, 0.04, -1);

  const fingers = [
    { base: 5, x: 0.45, angle: spec.index ?? CURLED },
    { base: 9, x: 0.5, angle: spec.middle ?? CURLED },
    { base: 13, x: 0.55, angle: CURLED },
    { base: 17, x: 0.6, angle: CURLED },
  ];
  for (const f of fingers) {
    const mcp: Pt = { x: f.x, y: 0.62, z: 0 };
    const pip: Pt = { x: f.x, y: 0.55, z: 0 };
    const tip = pointAtAngle(mcp, pip, f.angle, 0.08);
    pts[f.base] = mcp;
    pts[f.base + 1] = pip;
    pts[f.base + 2] = mid(pip, tip);
    pts[f.base + 3] = tip;
  }
  return pts;
}

/* ========================================================================== */
/* 1. The hold survives the tracker                                            */
/* ========================================================================== */

describe("HoldTracker — slack is counted in frames, not milliseconds", () => {
  const HOLD_MS = 600;

  it("completes a 600ms hold on a 5fps device (the old 200ms slack could not)", () => {
    const tracker = new HoldTracker();
    // Four clean frames, 200ms apart: 600ms of evidence.
    const { completions } = run(tracker, repeat<HoldVerdict>("match", 4), HOLD_MS);
    expect(completions).toBe(1);
  });

  it("survives a burst of dropped detections and still completes", () => {
    const tracker = new HoldTracker();
    // Frame 2 through 6 tell us nothing — five consecutive failures on a device
    // where each one costs 200ms of wall clock. Under the old rule the first of
    // them alone reset the hold.
    const script: HoldVerdict[] = [
      "match",
      ...repeat<HoldVerdict>("unknown", 5),
      "match",
      "match",
    ];
    expect(run(tracker, script, HOLD_MS).completions).toBe(1);
  });

  it("survives HOLD_SLACK_FRAMES of confident mismatch inside the ceiling", () => {
    const tracker = new HoldTracker();
    // Six mismatching frames at 60fps: the frame budget is the binding limit,
    // and it holds. (16ms spacing keeps the wall-clock ceiling out of it.)
    let completions = 0;
    let t = 0;
    const step = 16;
    const script: HoldVerdict[] = [
      "match",
      ...repeat<HoldVerdict>("mismatch", HOLD_SLACK_FRAMES),
      ...repeat<HoldVerdict>("match", 40),
    ];
    for (const verdict of script) {
      if (tracker.update(verdict, t, HOLD_MS)) completions += 1;
      t += step;
    }
    expect(completions).toBe(1);
  });

  it("does reset once a real mismatch runs past the budget", () => {
    const tracker = new HoldTracker();
    let t = 0;
    const step = 16;
    // One more mismatching frame than the budget allows.
    const script: HoldVerdict[] = [
      "match",
      ...repeat<HoldVerdict>("mismatch", HOLD_SLACK_FRAMES + 1),
    ];
    for (const verdict of script) {
      tracker.update(verdict, t, HOLD_MS);
      t += step;
    }
    // The hold is gone: a single match cannot complete what has to restart.
    expect(tracker.update("match", t, HOLD_MS)).toBe(false);
    expect(tracker.progress(t, HOLD_MS)).toBe(0);
  });

  it("resets when the child confidently does something else for longer than the hold", () => {
    const tracker = new HoldTracker();
    // Only three mismatching frames — inside the frame budget — but they span
    // 600ms+ of the child plainly showing a different answer. That is not a
    // dropped frame, and the ceiling says so.
    const script: HoldVerdict[] = ["match", "mismatch", "mismatch", "mismatch", "mismatch"];
    run(tracker, script, HOLD_MS);
    expect(tracker.progress(4 * SLOW_FRAME_MS, HOLD_MS)).toBe(0);
  });
});

describe("HoldTracker — 'I could not tell' is not a wrong answer", () => {
  const HOLD_MS = 600;

  it("neither completes nor resets on an unknown frame", () => {
    const tracker = new HoldTracker();
    expect(tracker.update("match", 0, HOLD_MS)).toBe(false);

    // Long enough that a wall-clock hold would have fired on its own.
    expect(tracker.update("unknown", 800, HOLD_MS)).toBe(false);
    // ...and the hold is still alive: progress is preserved, not zeroed.
    expect(tracker.progress(800, HOLD_MS)).toBe(1);

    // It takes real evidence to finish.
    expect(tracker.update("match", 1000, HOLD_MS)).toBe(true);
  });

  it("cannot complete on unknown frames alone, however many arrive", () => {
    const tracker = new HoldTracker();
    tracker.update("match", 0, HOLD_MS);
    const { completions } = run(tracker, repeat<HoldVerdict>("unknown", 20), HOLD_MS, 200);
    expect(completions).toBe(0);
  });

  it("gives up eventually, so a hold cannot outlive the child leaving the room", () => {
    const tracker = new HoldTracker();
    tracker.update("match", 0, HOLD_MS);
    run(tracker, repeat<HoldVerdict>("unknown", HOLD_UNKNOWN_FRAMES + 1), HOLD_MS, 200);
    expect(tracker.progress(9999, HOLD_MS)).toBe(0);
  });
});

/* ========================================================================== */
/* 2. Activities report evidence, not just verdicts                            */
/* ========================================================================== */

describe("activities — hasEvidence", () => {
  it("treats an unscoreable hand as no evidence, not as a wrong count", () => {
    const fingers = createFingersActivity(HALF); // target 3
    expect(verdictFor(fingers, frame({ t: 0, totalFingers: 3 }))).toBe("match");
    expect(verdictFor(fingers, frame({ t: 1, totalFingers: 2 }))).toBe("mismatch");
    expect(verdictFor(fingers, frame({ t: 2, totalFingers: null }))).toBe("unknown");
  });

  it("treats a lost hand as no evidence about waving", () => {
    const wave = createWaveActivity(HALF);
    expect(verdictFor(wave, frame({ t: 0, hands: [hand()], waving: true }))).toBe("match");
    expect(verdictFor(wave, frame({ t: 1, hands: [hand()], waving: false }))).toBe("mismatch");
    expect(verdictFor(wave, frame({ t: 2, waving: false }))).toBe("unknown");
  });

  it("treats a lost face as no evidence about smiling", () => {
    const smile = createSmileActivity(HALF);
    expect(verdictFor(smile, frame({ t: 0, face: face({ smile: 0.8 }) }))).toBe("match");
    expect(verdictFor(smile, frame({ t: 1, face: null }))).toBe("unknown");
  });

  it("completes 'show me three' across the dropouts a real hand produces", () => {
    const fingers = createFingersActivity(HALF);
    const tracker = new HoldTracker();
    // What the tracker actually emits while a five-year-old holds up three
    // fingers on a slow phone: the count keeps vanishing into the ambiguity
    // band as the hand wobbles. Nothing here is a wrong answer.
    const counts: Array<number | null> = [3, null, 3, null, null, 3, 3];
    let completions = 0;
    counts.forEach((totalFingers, i) => {
      const f = frame({ t: i * SLOW_FRAME_MS, totalFingers });
      if (tracker.update(verdictFor(fingers, f), f.t, fingers.holdMs)) completions += 1;
    });
    expect(completions).toBe(1);
  });
});

/* ========================================================================== */
/* 3. Per-finger angle hysteresis                                              */
/* ========================================================================== */

describe("countExtendedFingers — per-finger hysteresis", () => {
  it("still needs a clear angle to call a finger extended in the first place", () => {
    // 145 is below the enter threshold: from cold, this finger is not extended.
    expect(countExtendedFingers(buildHand({ index: 145 })).extended[1]).toBe(false);
    expect(countExtendedFingers(buildHand({ index: 155 })).extended[1]).toBe(true);
  });

  it("holds an extended finger through 145deg instead of flickering at 150", () => {
    const wasExtended: FiveBooleans = [false, true, false, false, false];
    const held = countExtendedFingers(buildHand({ index: 145 }), undefined, wasExtended);
    expect(held.extended[1]).toBe(true);
    expect(held.total).toBe(1);
    // ...whereas the same hand judged cold reads as a fist.
    expect(countExtendedFingers(buildHand({ index: 145 })).total).toBe(0);
  });

  it("shrinks the ambiguity -> null -> hold-reset chain for fingers already up", () => {
    // Two fingers resting at 152: comfortably up, but within 8deg of the cold
    // threshold, so two ambiguous fingers, so the WHOLE HAND is unscoreable and
    // the activity gets a null it used to score as a wrong answer.
    const cold = countExtendedFingers(buildHand({ index: 152, middle: 152 }));
    expect(cold.ambiguousCount).toBe(2);
    expect(cold.total).toBeNull();

    // Once those two fingers are believed extended, the boundary that matters
    // is 142 — and 152 is nowhere near it.
    const warm = countExtendedFingers(buildHand({ index: 152, middle: 152 }), undefined, [
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(warm.ambiguousCount).toBe(0);
    expect(warm.total).toBe(2);
  });

  it("lets go below the release angle", () => {
    const wasExtended: FiveBooleans = [false, true, false, false, false];
    const dropped = countExtendedFingers(
      buildHand({ index: FINGER_EXTENDED_RELEASE_ANGLE_DEG - 3 }),
      undefined,
      wasExtended,
    );
    expect(dropped.extended[1]).toBe(false);
  });

  it("keeps the release angle below the enter angle", () => {
    expect(FINGER_EXTENDED_RELEASE_ANGLE_DEG).toBeLessThan(FINGER_EXTENDED_MIN_ANGLE_DEG);
  });

  it("stops the count flickering across a whole wobble, via StableHandCount", () => {
    // One finger up, measured at angles that straddle 150 the way a real hand
    // does. Without hysteresis this reads 1,0,1,0,1 — five different answers
    // for one finger that never moved.
    const wobble = [156, 148, 145, 149, 152];
    const stable = new StableHandCount();
    const stableCounts = wobble.map((a) => stable.count(buildHand({ index: a })).total);
    expect(stableCounts).toEqual([1, 1, 1, 1, 1]);

    const naive = wobble.map((a) => countExtendedFingers(buildHand({ index: a })).extended[1]);
    expect(naive).not.toEqual([true, true, true, true, true]);
  });

  it("does not let a tracker dropout erase what it knew about the hand", () => {
    const stable = new StableHandCount();
    expect(stable.count(buildHand({ index: 156 })).total).toBe(1);
    // The hand leaves the frame for one tick...
    expect(stable.count(null).total).toBeNull();
    // ...and comes back mid-band. The memory survived, so it is still one.
    expect(stable.count(buildHand({ index: 145 })).total).toBe(1);
  });

  it("behaves exactly as before when no previous frame is supplied", () => {
    // The engine's cold path must be unchanged: 150 is still the only boundary.
    expect(countExtendedFingers(buildHand({ index: 155 })).total).toBe(1);
    expect(countExtendedFingers(buildHand({ index: 145 })).total).toBe(0);
  });
});

/* ========================================================================== */
/* 4. Attention                                                                */
/* ========================================================================== */

describe("attention gate — Chiku does not glance away on a dropped frame", () => {
  it("locks on as soon as a face is clearly attending", () => {
    const gate = createAttentionGate();
    expect(gate.update(face({ attention: 0.9 }))).toBe(true);
  });

  it("does not drop on a single null frame", () => {
    const gate = createAttentionGate();
    gate.update(face({ attention: 0.9 }));
    expect(gate.update(null)).toBe(true);
    expect(gate.update(face({ attention: 0.9 }))).toBe(true);
  });

  it("holds through a whole burst of dropouts", () => {
    const gate = createAttentionGate();
    gate.update(face({ attention: 0.9 }));
    for (let i = 0; i < ATTENTION_HOLD_FRAMES; i += 1) {
      expect(gate.update(null)).toBe(true);
    }
  });

  it("does let go once the child is really gone", () => {
    const gate = createAttentionGate();
    gate.update(face({ attention: 0.9 }));
    for (let i = 0; i < 30; i += 1) gate.update(null);
    expect(gate.on).toBe(false);
  });

  it("does not strobe while a child hovers at the boundary", () => {
    // Exactly what the fingers activity forces: the child looks DOWN at their
    // own hands, so the attention score sits either side of the old 0.35.
    const gate = createAttentionGate();
    gate.update(face({ attention: 0.9 })); // locked on
    const hover = [0.34, 0.36, 0.3, 0.38, 0.33, 0.37];
    for (const attention of hover) {
      expect(gate.update(face({ attention }))).toBe(true);
    }
    // The old code compared each of those against 0.35 and flipped six times.
    expect(hover.some((a) => a < 0.35)).toBe(true);
    expect(hover.some((a) => a >= 0.35)).toBe(true);
  });

  it("prefers the engine's own facePresence when the frame carries one", () => {
    const gate = createAttentionGate();
    // The engine's Presence rises 0.12/frame and holds flat through its
    // dropout window. A raw multiply would leave Chiku ignoring the child for
    // the first four frames; the ratio treats 0.12-then-0.12 as "unchanged".
    expect(gate.update(face({ attention: 0.9 }), 0.12)).toBe(true);
    expect(gate.update(null, 0.12)).toBe(true);
    expect(gate.update(null, 0.12)).toBe(true);
    // Now it starts decaying, and belief falls with it.
    expect(gate.update(null, 0.07)).toBe(true); // 0.9 * 0.58 = 0.52
    expect(gate.update(null, 0.02)).toBe(false); // 0.9 * 0.17 = 0.15
  });

  it("still requires the enter threshold to acquire from cold", () => {
    const gate = createAttentionGate();
    expect(gate.update(face({ attention: ATTENTION_BAND.enter - 0.01 }))).toBe(false);
    expect(gate.update(face({ attention: ATTENTION_BAND.enter }))).toBe(true);
    // ...and releases only below the exit threshold.
    expect(gate.update(face({ attention: ATTENTION_BAND.exit + 0.01 }))).toBe(true);
    expect(gate.update(face({ attention: ATTENTION_BAND.exit }))).toBe(false);
  });
});

/* ========================================================================== */
/* 5. Smile                                                                    */
/* ========================================================================== */

describe("smile — the mouth stops snapping at the boundary", () => {
  it("needs a real smile to start", () => {
    const smile = createSmileActivity(HALF);
    expect(smile.matches(frame({ t: 0, face: face({ smile: SMILE_THRESHOLD - 0.01 }) }))).toBe(
      false,
    );
    expect(smile.matches(frame({ t: 1, face: face({ smile: SMILE_THRESHOLD }) }))).toBe(true);
  });

  it("does not flicker while a held smile wobbles across the threshold", () => {
    const smile = createSmileActivity(HALF);
    smile.matches(frame({ t: 0, face: face({ smile: 0.6 }) }));
    // A real blendshape trace for one continuous smile.
    for (const value of [0.44, 0.46, 0.43, 0.47, 0.41, 0.45]) {
      expect(smile.matches(frame({ t: 1, face: face({ smile: value }) }))).toBe(true);
    }
  });

  it("lets go when the smile really drops", () => {
    const smile = createSmileActivity(HALF);
    smile.matches(frame({ t: 0, face: face({ smile: 0.6 }) }));
    expect(smile.matches(frame({ t: 1, face: face({ smile: SMILE_BAND.exit - 0.01 }) }))).toBe(
      false,
    );
  });

  it("completes a held smile that wobbles, on a slow device", () => {
    const smile = createSmileActivity(HALF);
    const tracker = new HoldTracker();
    let completions = 0;
    const trace = [0.5, 0.44, 0.46, 0.42];
    trace.forEach((value, i) => {
      const f = frame({ t: i * SLOW_FRAME_MS, face: face({ smile: value }) });
      if (tracker.update(verdictFor(smile, f), f.t, smile.holdMs)) completions += 1;
    });
    expect(completions).toBe(1);
  });

  it("gives each round its own gate, so a smile cannot leak between rounds", () => {
    const first = createSmileActivity(HALF);
    first.matches(frame({ t: 0, face: face({ smile: 0.9 }) }));
    const second = createSmileActivity(HALF);
    expect(second.matches(frame({ t: 0, face: face({ smile: 0.42 }) }))).toBe(false);
  });
});
