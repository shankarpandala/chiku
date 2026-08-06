// THE ROTATION — which three activities a child actually gets, and the
// contract every activity in the pool has to keep.
//
// Phase 5 took the pool from four to eight without making the session any
// longer, which means the interesting question stopped being "does the round
// contain everything" and became "is this particular round playable". Three
// activities drawn badly is a worse show than three drawn at random: three
// counting games in a row is one activity that outstayed its welcome, and a
// round of nothing but the colour hunt and the successor is a round the
// youngest band cannot play at all.
//
// What is pinned here, in order of how badly it would hurt a child:
//
//   1. NOTHING IS UNREACHABLE. An activity module that exists and is not in
//      `ACTIVITY_SPEC` is the bug that has bitten this app three phases
//      running: built, tested, green, and no child can get to it. That is a
//      build failure here, not a discovery in six weeks.
//   2. EVERY ACTIVITY KEEPS THE CONTRACT. A tap answer that works with no
//      camera, a spoken answer, retry copy in both languages, and an empty
//      frame scored as "no evidence" rather than as a wrong answer. Written
//      over the POOL rather than over a list, so the ninth activity is held to
//      it the day it lands.
//   3. THE ROUND IS SHAPED. One skill each, at most one advanced, at least one
//      foundation — and still exactly three of them.
//   4. THE FIXTURE DOES NOT MOVE. Four surface test files are written against
//      the round a constant 0.5 produces. Growing the pool must not rewrite it.

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_MODULES,
  ACTIVITY_SPEC,
  buildRound,
  pickRound,
  POOL,
  ROUND_LENGTH,
  SIZE_MIRROR_KINDS,
} from "../src/activities";
import { verdictFor } from "../src/activities/types";
import type { VisionFrame } from "../src/vision/types";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

const enDict = en as Record<string, string | undefined>;
const teDict = te as Record<string, string | undefined>;

/** The constant every surface test uses. */
const HALF = (): number => 0.5;

/** A frame with nothing in it: no face, no hands, no window. */
function emptyFrame(t = 0): VisionFrame {
  return { t, face: null, hands: [], totalFingers: null, waving: false };
}

/* ========================================================================== */
/* 1. nothing is unreachable                                                  */
/* ========================================================================== */

describe("the pool is the whole pool", () => {
  it("schedules every activity module that exists", () => {
    // The Phase 1-4 bug, as a build failure. If you add
    // `src/activities/hopscotch.ts` and forget `ACTIVITY_SPEC`, this is what
    // tells you — rather than a child never being asked to hop.
    const scheduled = new Set(POOL.map((entry) => entry.id));
    const orphans = ACTIVITY_MODULES.filter((id) => !scheduled.has(id));
    expect(orphans, `activity modules missing from ACTIVITY_SPEC: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps the spec and the pool in the same order, with no duplicates", () => {
    const ids = POOL.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const specOrder = ACTIVITY_SPEC.map((s) => s.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(specOrder);
  });

  it("declares a skill and a band for every activity", () => {
    for (const entry of POOL) {
      expect(entry.skill, entry.id).toBeTypeOf("string");
      expect(entry.band, entry.id).toBeTypeOf("string");
    }
  });

  it("mirrors Chiku's size only for activities that are about size", () => {
    // The set is what the surface keys off. A name in it that is not an
    // activity would be a silent no-op — Chiku never growing, no error.
    const ids = new Set(POOL.map((entry) => entry.id));
    for (const kind of SIZE_MIRROR_KINDS) {
      if (ids.has(kind)) expect(POOL.find((e) => e.id === kind)?.skill).toBe("size");
    }
  });
});

/* ========================================================================== */
/* 2. every activity keeps the contract                                       */
/* ========================================================================== */

describe("every activity in the pool", () => {
  for (const entry of POOL) {
    describe(entry.id, () => {
      it("has a tap answer that works with the camera off", () => {
        const activity = entry.make(HALF);
        expect(activity.choices.length).toBeGreaterThanOrEqual(2);
        expect(activity.choices.filter((c) => c.correct).length).toBeGreaterThanOrEqual(1);
        // Every choice is a picture, a numeral or a colour — never a bare
        // button. A child who cannot read has to be able to answer.
        for (const choice of activity.choices) {
          const hasFace =
            choice.digit !== undefined || choice.glyph !== undefined || choice.swatch !== undefined;
          expect(hasFace, `${activity.kind} choice ${choice.id} has no picture`).toBe(true);
          expect(enDict[choice.labelKey], `${choice.labelKey} (en)`).toBeTypeOf("string");
          expect(teDict[choice.labelKey], `${choice.labelKey} (te)`).toBeTypeOf("string");
        }
      });

      it("carries its copy in both languages", () => {
        const activity = entry.make(HALF);
        for (const key of [activity.promptKey, activity.retryKey, activity.tapHintKey]) {
          expect(enDict[key], `${key} (en)`).toBeTypeOf("string");
          expect(teDict[key], `${key} (te)`).toBeTypeOf("string");
        }
      });

      it("treats an empty frame as no evidence, never as a wrong answer", () => {
        // Phase 1's whole point, held for every activity that will ever exist:
        // "I could not tell" must cost the child nothing.
        const activity = entry.make(HALF);
        expect(verdictFor(activity, emptyFrame(0))).toBe("unknown");
        expect(verdictFor(activity, emptyFrame(16))).toBe("unknown");
      });

      it("has a hold the mercy ladder can scale, and a demo it can play", () => {
        const activity = entry.make(HALF);
        expect(activity.holdMs).toBeGreaterThan(0);
        // `demonstrate` is optional — but if it exists, every beat has to be a
        // real beat, or the "watch me" rung is a pause with nothing in it.
        for (const beat of activity.demonstrate?.() ?? []) {
          expect(beat.ms).toBeGreaterThan(0);
          if (beat.key !== undefined) {
            expect(enDict[beat.key], `${beat.key} (en)`).toBeTypeOf("string");
            expect(teDict[beat.key], `${beat.key} (te)`).toBeTypeOf("string");
          }
        }
      });

      it("accepts a spoken answer, and does not accept silence", () => {
        const activity = entry.make(HALF);
        expect(activity.answers.te.length + activity.answers.en.length).toBeGreaterThan(0);
        expect(activity.accepts("")).toBe(false);
        expect(activity.accepts("   ")).toBe(false);
        for (const said of [...activity.answers.te, ...activity.answers.en]) {
          expect(activity.accepts(said), `${activity.kind} rejects "${said}"`).toBe(true);
        }
      });
    });
  }
});

/* ========================================================================== */
/* 3. the round is shaped                                                     */
/* ========================================================================== */

describe("the shape of a round", () => {
  it("is still three activities, however big the pool gets", () => {
    expect(ROUND_LENGTH).toBe(3);
    for (let i = 0; i < 200; i += 1) {
      expect(buildRound(Math.random).length).toBe(Math.min(3, POOL.length));
    }
  });

  it("never repeats an activity, and never two of the same skill", () => {
    for (let i = 0; i < 300; i += 1) {
      const round = pickRound(Math.random);
      const ids = round.map((e) => e.id);
      const skills = round.map((e) => e.skill);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(skills).size, `two of one skill: ${ids.join(", ")}`).toBe(skills.length);
    }
  });

  it("never asks for two advanced activities in one three-activity session", () => {
    for (let i = 0; i < 300; i += 1) {
      const round = pickRound(Math.random);
      const advanced = round.filter((e) => e.band === "advanced");
      expect(advanced.length, `two advanced: ${round.map((e) => e.id).join(", ")}`).toBeLessThanOrEqual(1);
    }
  });

  it("always contains something the youngest band can just do", () => {
    // The rule that makes "rounds end in praise" reachable for a three-year-
    // old: at least one activity that needs no instruction, only imitation.
    const hasFoundation = POOL.some((e) => e.band === "foundation");
    for (let i = 0; i < 300; i += 1) {
      const round = pickRound(Math.random);
      expect(round.some((e) => e.band === "foundation")).toBe(hasFoundation);
    }
  });

  it("gives every activity in the pool a turn", () => {
    // Not decoration: an activity that the shaping rules quietly make
    // impossible to draw is unreachable in the way that matters.
    const seen = new Set<string>();
    for (let i = 0; i < 600; i += 1) {
      for (const entry of pickRound(Math.random)) seen.add(entry.id);
    }
    expect([...seen].sort()).toEqual(POOL.map((e) => e.id).sort());
  });

  it("lets every activity be the FIRST thing a child meets", () => {
    // Deliberate: the opener is not reserved for the easy ones. Rule 3 already
    // guarantees the round is playable, and reserving slot one would mean the
    // magic window could only ever appear third.
    const openers = new Set<string>();
    for (let i = 0; i < 600; i += 1) {
      const first = pickRound(Math.random)[0];
      if (first) openers.add(first.id);
    }
    expect([...openers].sort()).toEqual(POOL.map((e) => e.id).sort());
  });
});

/* ========================================================================== */
/* 4. the fixture does not move                                               */
/* ========================================================================== */

describe("seeded determinism", () => {
  it("leaves the constant-0.5 round exactly as it was", () => {
    // FOUR SURFACE TEST FILES DEPEND ON THIS LINE. `buildRound` draws one sort
    // key per pool entry and sorts stably, so a constant random leaves
    // ACTIVITY_SPEC order intact and the first three legal entries win. That
    // is why the spec starts fingers, smile, wave — and why adding a ninth
    // activity cannot move the fixture. If this ever goes red, it fails HERE
    // rather than as four unrelated files.
    expect(buildRound(HALF).map((a) => a.kind)).toEqual(["fingers", "smile", "wave"]);
  });

  it("still puts 3 in the constant-0.5 counting game", () => {
    const first = buildRound(HALF)[0];
    expect(first?.promptValues).toEqual({ n: 3 });
  });

  it("is a pure function of the random it is handed", () => {
    const seeded = (): (() => number) => {
      let s = 12345;
      return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    };
    const a = pickRound(seeded()).map((e) => e.id);
    const b = pickRound(seeded()).map((e) => e.id);
    expect(a).toEqual(b);
  });
});
