// Every kid-facing string the four Phase 5 activities need, in BOTH languages.
//
// Written out as a literal list rather than derived from the dictionaries:
// this list IS the spec. Deriving it would make a key deleted from BOTH files
// look like a pass, which is exactly the shape of a bug this repo has already
// shipped once.
//
// It is the mirror of `sweep.test.ts`, which fails on a dictionary key that
// nothing in `src/` reaches. That one says "no copy without a caller"; this one
// says "no caller without copy, in both languages". Neither is enough alone —
// the pair is what makes a missing Telugu line impossible rather than
// invisible. Nothing here lists a key the activities do not actually ask for.

import { describe, expect, it } from "vitest";

import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";
import { createBigSmallActivity } from "../src/activities/bigsmall";
import { createPeekabooActivity } from "../src/activities/peekaboo";
import { createSuccessorActivity } from "../src/activities/successor";
import { createThumbsActivity, THUMBS_QUESTIONS } from "../src/activities/thumbs";
import type { Activity } from "../src/activities/types";

const SUCCESSOR_KEYS = [
  "act.successor.prompt",
  "act.successor.retry",
  "act.successor.tap",
  "demo.successor.more",
] as const;

const BIGSMALL_KEYS = [
  "act.bigsmall.prompt",
  "act.bigsmall.retry",
  "act.bigsmall.tap",
  "choice.bigsmall.big",
  "choice.bigsmall.small",
  "demo.bigsmall.big",
  "demo.bigsmall.small",
] as const;

const THUMBS_KEYS = [
  "act.thumbs.retry",
  "act.thumbs.tap",
  "choice.thumbs.yes",
  "choice.thumbs.no",
  "demo.thumbs.yes",
  "demo.thumbs.no",
  ...THUMBS_QUESTIONS.map((q) => q.key),
] as const;

const PEEKABOO_KEYS = [
  "act.peekaboo.prompt",
  "act.peekaboo.retry",
  "act.peekaboo.tap",
  "choice.peekaboo.hiding",
  "choice.peekaboo.peek",
  "demo.peekaboo.hide",
  "demo.peekaboo.peek",
] as const;

const NEW_KEYS = [
  ...SUCCESSOR_KEYS,
  ...BIGSMALL_KEYS,
  ...THUMBS_KEYS,
  ...PEEKABOO_KEYS,
] as const;

const enDict = en as Record<string, string | undefined>;
const teDict = te as Record<string, string | undefined>;

/** Telugu block. One character of it is proof the line was actually written. */
const TELUGU = /[ఀ-౿]/;

describe("Phase 5 copy exists in both languages", () => {
  for (const key of NEW_KEYS) {
    it(`${key} — en and te`, () => {
      const e = enDict[key];
      const t = teDict[key];
      expect(e, `${key} missing from en.json`).toBeTypeOf("string");
      expect(t, `${key} missing from te.json`).toBeTypeOf("string");
      expect((e ?? "").trim(), `${key} is empty in en.json`).not.toBe("");
      expect((t ?? "").trim(), `${key} is empty in te.json`).not.toBe("");
      // The failure this actually catches: the English line pasted into te.json
      // to make a build go green.
      expect(t ?? "", `${key} in te.json is not Telugu script`).toMatch(TELUGU);
      expect(e ?? "", `${key} in en.json contains Telugu script`).not.toMatch(TELUGU);
      expect(t).not.toBe(e);
    });
  }

  it("keeps every line short enough to be said to a child", () => {
    // Spoken aloud to someone who cannot read them. A long line is a line a
    // 3-year-old stops listening to halfway through.
    for (const key of NEW_KEYS) {
      expect((enDict[key] ?? "").length, `${key} en is too long`).toBeLessThanOrEqual(90);
      expect((teDict[key] ?? "").length, `${key} te is too long`).toBeLessThanOrEqual(90);
    }
  });

  it("uses the same interpolation tokens in both languages", () => {
    const tokens = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
    for (const key of NEW_KEYS) {
      const e = new Set(tokens(enDict[key] ?? ""));
      const t = new Set(tokens(teDict[key] ?? ""));
      // A token present in one dictionary and not the other renders as a raw
      // "{next}" on screen in exactly one language.
      expect([...t].sort(), `${key} token mismatch`).toEqual([...e].sort());
    }
  });
});

describe("every key a Phase 5 activity actually reaches for resolves", () => {
  const built: readonly Activity[] = [
    createSuccessorActivity(() => 0),
    createSuccessorActivity(() => 0.9),
    createBigSmallActivity(() => 0),
    createPeekabooActivity(() => 0),
    ...THUMBS_QUESTIONS.map((_, i) =>
      createThumbsActivity(() => (i + 0.5) / THUMBS_QUESTIONS.length),
    ),
  ];

  for (const activity of built) {
    it(`${activity.kind}: prompt, retry, tap hint, choices and demo beats`, () => {
      const keys = [
        activity.promptKey,
        activity.retryKey,
        activity.tapHintKey,
        ...activity.choices.map((c) => c.labelKey),
        ...(activity.demonstrate?.() ?? []).flatMap((b) => (b.key ? [b.key] : [])),
      ];
      for (const key of keys) {
        expect(enDict[key], `${activity.kind} reaches for ${key}`).toBeTypeOf("string");
        expect(teDict[key], `${activity.kind} reaches for ${key}`).toBeTypeOf("string");
      }
      // A prompt that silently fell back to the retry line would mean the
      // question never reached the child.
      expect(activity.promptKey).not.toBe(activity.retryKey);
    });
  }
});
