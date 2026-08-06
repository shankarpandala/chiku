// @vitest-environment happy-dom
//
// THE KID LAYER: what the child SEES while they are trying, and what they hear
// when trying was not enough on its own.
//
// Two findings are pinned here.
//
//   * `HoldTracker.progress()` was written "for the progress cue" and nothing
//     ever called it. For 600ms — longer on the slow devices we target, where
//     the hold can silently reset — a child holding three fingers up got no
//     evidence at all that Chiku was counting, and then a nudge that read as
//     "you did nothing". The ring is that evidence, and it must hold through a
//     tracker blink rather than snap back, or it lies in the discouraging
//     direction.
//
//   * The mercy ladder's copy. Every line has to exist in BOTH languages before
//     it can ship, because a missing Telugu line is not a degraded experience,
//     it is a silent fallback to English on a surface whose whole promise is
//     that the child's language is not the second one. Hence the loop below:
//     one missing string fails the build.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { HoldRing } from "../src/components/HoldRing";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function ring(): HTMLElement | null {
  return container.querySelector(".hold-ring");
}

/** The proportion the ring is actually drawing, or null when it draws nothing. */
function drawn(): number | null {
  const el = ring();
  if (!el) return null;
  const attr = el.dataset["holdProgress"];
  const custom = el.style.getPropertyValue("--hold-progress");
  // The attribute is for tests; the custom property is what paints. If they
  // ever disagree the test is measuring something the child cannot see.
  expect(custom).toBe(attr);
  return Number(attr);
}

/**
 * Read a file from the app root. Same reasoning as surface-reality.test.tsx:
 * under happy-dom `import.meta.url` is an http:// URL and cannot be resolved.
 */
function appFile(rel: string): string {
  for (const dir of [process.cwd(), resolve(process.cwd(), "apps/live")]) {
    try {
      return readFileSync(resolve(dir, rel), "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`cannot read ${rel} from ${process.cwd()}`);
}

/** A rule body with its comments removed — prose is not a declaration. */
function declarations(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Take the rAF loop off the clock so an ease-down is a decision, not a race. */
function manualRaf(): { step: (advanceMs: number) => void; pending: () => number } {
  let queue: FrameRequestCallback[] = [];
  let clock = performance.now();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => {
    queue = [];
  });
  return {
    step(advanceMs: number) {
      clock += advanceMs;
      const due = queue;
      queue = [];
      act(() => {
        for (const cb of due) cb(clock);
      });
    },
    pending: () => queue.length,
  };
}

/* -------------------------------------------------------------------------- */
/* the ring                                                                    */
/* -------------------------------------------------------------------------- */

describe("HoldRing — Chiku is visibly counting", () => {
  it("draws nothing at all when no hold is running", () => {
    render(<HoldRing progress={0} label="counting" />);
    expect(ring()).toBeNull();
  });

  it("tracks the prop: the filled proportion IS the child's progress", () => {
    for (const p of [0.08, 0.25, 0.5, 0.75, 1]) {
      render(<HoldRing progress={p} label="counting" />);
      expect(drawn()).toBeCloseTo(p, 3);
    }
  });

  it("rises with the child on the very same commit — no lag, no catch-up", () => {
    // A ring that eased UPWARD would be behind the hand it is describing, and
    // a 600ms hold cannot afford to spend any of it convincing the child that
    // something is happening.
    render(<HoldRing progress={0.2} label="counting" />);
    render(<HoldRing progress={0.9} label="counting" />);
    expect(drawn()).toBeCloseTo(0.9, 3);
  });

  it("clamps nonsense rather than painting it", () => {
    // `reducedMotion` here only to take the ease-down out of the picture: a
    // clamp is about the value, and the hold behaviour is tested next.
    render(<HoldRing progress={4} label="counting" reducedMotion />);
    expect(drawn()).toBe(1);
    render(<HoldRing progress={Number.NaN} label="counting" reducedMotion />);
    expect(ring()).toBeNull();
    render(<HoldRing progress={-3} label="counting" reducedMotion />);
    expect(ring()).toBeNull();
  });

  it("HOLDS through a tracker blink instead of snapping back to zero", () => {
    const raf = manualRaf();
    render(<HoldRing progress={0.7} label="counting" />);
    expect(drawn()).toBeCloseTo(0.7, 3);

    // The detector loses the hand for a frame. HoldTracker forgives that; the
    // cue must forgive it too, or it tells the child a lie the tracker didn't.
    render(<HoldRing progress={0} label="counting" />);
    const held = drawn();
    expect(held).not.toBeNull();
    expect(held ?? 0).toBeCloseTo(0.7, 3);
    expect(ring()?.className).toContain("is-holding");

    // ...and it eases down rather than cutting: still visible mid-fall.
    raf.step(200);
    const midFall = drawn() ?? 0;
    expect(midFall).toBeGreaterThan(0);
    expect(midFall).toBeLessThan(0.7);

    // ...and it does get out of the way once the child has really stopped.
    raf.step(1000);
    expect(ring()).toBeNull();
  });

  it("comes straight back up if the child recovers mid-fade", () => {
    const raf = manualRaf();
    render(<HoldRing progress={0.6} label="counting" />);
    render(<HoldRing progress={0} label="counting" />);
    raf.step(100);
    expect(drawn() ?? 0).toBeLessThan(0.6);

    render(<HoldRing progress={0.8} label="counting" />);
    expect(drawn()).toBeCloseTo(0.8, 3);
    expect(ring()?.className).not.toContain("is-holding");
  });

  it("carries an accessible name and is not a chattering progressbar", () => {
    render(<HoldRing progress={0.5} label="Chiku is counting" />);
    const el = ring();
    expect(el?.getAttribute("role")).toBe("img");
    expect(el?.getAttribute("aria-label")).toBe("Chiku is counting");
    // No aria-valuenow: thirty announcements a second is not accessibility.
    expect(el?.getAttribute("aria-valuenow")).toBeNull();
  });

  it("is NOT teal — teal means 'Chiku is hearing you', marigold means action", () => {
    render(<HoldRing progress={0.5} label="counting" />);
    const el = ring();
    expect(el?.className).not.toContain("teal");
    expect(el?.querySelector(".hold-ring-fill")).not.toBeNull();

    const css = appFile("src/styles.css");
    const rules = [...css.matchAll(/([^{}]*hold-ring[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule[2] ?? "").not.toContain("teal");
    }
    expect(rules.some((r) => (r[2] ?? "").includes("--kid-marigold"))).toBe(true);

    // And the teal that does exist still belongs to the attention glow alone.
    expect(css).toMatch(/\.stage\.is-attending\s*\{[^}]*--kid-teal/);
  });
});

describe("HoldRing — prefers-reduced-motion", () => {
  it("renders a static proportion, with no easing loop at all", () => {
    const raf = manualRaf();
    render(<HoldRing progress={0.7} label="counting" reducedMotion />);
    expect(drawn()).toBeCloseTo(0.7, 3);
    expect(ring()?.className).toContain("is-static");

    // No animation frames were ever asked for...
    expect(raf.pending()).toBe(0);
    // ...and the ring simply reflects the truth of the moment, without a fade.
    render(<HoldRing progress={0} label="counting" reducedMotion />);
    expect(ring()).toBeNull();
    expect(raf.pending()).toBe(0);
  });

  it("follows the media query when the surface does not pass a value", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<HoldRing progress={0.4} label="counting" />);
    expect(ring()?.className).toContain("is-static");
  });

  it("kills the breath animation in CSS too", () => {
    const css = appFile("src/styles.css");
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block?.[0] ?? "").toMatch(/\.hold-ring-fill\s*\{[^}]*animation:\s*none/);
    // No spin anywhere in the cue: a spinner says "wait", not "keep going".
    const rules = [...css.matchAll(/([^{}]*hold-ring[^{}]*)\{([^}]*)\}/g)];
    for (const rule of rules) {
      expect(declarations(rule[2] ?? "")).not.toMatch(/rotate|spin/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* the copy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every string the mercy ladder and the effort praise need. Written out rather
 * than derived from the dictionary on purpose: this list is the spec, and the
 * dictionaries are checked against it. Deriving it would make a key that was
 * deleted from both files look like a pass.
 *
 * Note what is NOT here: there is no copy for the "easier" rung. That rung
 * quietly loosens the detector (assist.ts `relaxFor`) and says nothing at all,
 * because telling a child you have made it easier is a small humiliation they
 * did not ask for.
 */
const PRAISE_KEYS = [
  "praise.light.one",
  "praise.light.two",
  "praise.light.three",
  "praise.warm.one",
  "praise.warm.two",
  "praise.warm.three",
  "praise.effort.one",
  "praise.effort.two",
  "praise.effort.three",
  "praise.effort.four",
] as const;

const LADDER_KEYS = [
  "watch.fingers",
  "watch.wave",
  "watch.smile",
  "together.fingers",
  "together.wave",
  "together.smile",
] as const;

const NEW_KEYS = [...PRAISE_KEYS, ...LADDER_KEYS, "hold.counting"] as const;

const enDict = en as Record<string, string | undefined>;
const teDict = te as Record<string, string | undefined>;

/** Telugu block. One character of it is proof the line was actually written. */
const TELUGU = /[ఀ-౿]/;

describe("the mercy ladder copy exists in both languages", () => {
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
    // These are spoken aloud to someone who cannot read them. A long line is a
    // line the child stops listening to before the point arrives.
    for (const key of NEW_KEYS) {
      expect((enDict[key] ?? "").length, `${key} (en) is too long to speak`).toBeLessThanOrEqual(56);
      expect((teDict[key] ?? "").length, `${key} (te) is too long to speak`).toBeLessThanOrEqual(56);
    }
  });

  it("praises the EFFORT and never the child", () => {
    // Gunderson/Dweck: person-praise at 4-5 predicts a fixed mindset. "You kept
    // trying" is a fact about what happened; "clever girl" is a verdict about
    // who they are, and it is the verdict that does the damage.
    const person = /\bclever\b|\bsmart\b|\bgenius\b|\bbright\b|good (girl|boy)|\btalented\b/i;
    for (const key of PRAISE_KEYS) {
      expect(enDict[key] ?? "", `${key} praises the child, not the effort`).not.toMatch(person);
    }
    // ...and at least one effort line names the trying out loud.
    const effort = PRAISE_KEYS.filter((k) => k.startsWith("praise.effort")).map((k) => enDict[k] ?? "");
    expect(effort.some((s) => /tried|trying|together|hard/i.test(s))).toBe(true);
  });

  it("never reads as failure, scolding or 'wrong'", () => {
    const bad = /\bwrong\b|\bno\b|\bnot\b|\bfail\w*|\bsorry\b|\bbad\b|\bcan't\b|\bdon't\b|\bnever\b/i;
    for (const key of NEW_KEYS) {
      expect(enDict[key] ?? "", `${key} reads as a failure`).not.toMatch(bad);
    }
    // Telugu equivalents of "no"/"wrong". "వదల్లేదు" (did not give up) is a
    // deliberate exception: it is the effort being named, not a refusal.
    const badTe = /తప్పు|కాదు|వద్దు/;
    for (const key of NEW_KEYS) {
      expect(teDict[key] ?? "", `${key} (te) reads as a failure`).not.toMatch(badTe);
    }
  });

  it("covers every activity kind on both rungs that speak", () => {
    for (const kind of ["fingers", "wave", "smile"] as const) {
      expect(enDict[`watch.${kind}`]).toBeTypeOf("string");
      expect(teDict[`watch.${kind}`]).toBeTypeOf("string");
      expect(enDict[`together.${kind}`]).toBeTypeOf("string");
      expect(teDict[`together.${kind}`]).toBeTypeOf("string");
    }
    // "Together" has to sound like company, not like a correction.
    for (const kind of ["fingers", "wave", "smile"] as const) {
      expect(enDict[`together.${kind}`] ?? "").toMatch(/together/i);
      expect(teDict[`together.${kind}`] ?? "").toMatch(/కలిసి/);
    }
  });
});

describe("the demonstration actually speaks", () => {
  // Regression: Phase 3's "watch" rung posed Chiku correctly but said NOTHING
  // for fingers, wave and smile — the code asked for demo.* keys that had never
  // been written, while a parallel watch.*/together.* family sat unused. A
  // demonstration a child cannot hear is half a demonstration.
  const REQUIRED = [
    "demo.count.1",
    "demo.count.2",
    "demo.count.3",
    "demo.count.4",
    "demo.count.5",
    "demo.wave",
    "demo.smile",
    "demo.together",
  ] as const;

  it.each(REQUIRED)("%s exists and is non-empty in BOTH languages", (key) => {
    for (const dict of [en, te]) {
      const value = (dict as Record<string, string>)[key];
      expect(value, `${key} missing`).toBeTypeOf("string");
      expect(value?.trim().length ?? 0, `${key} empty`).toBeGreaterThan(0);
    }
  });
});
