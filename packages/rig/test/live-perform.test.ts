/**
 * Chiku DOING the exercises.
 *
 * This is the instruction channel for a pre-verbal child. There is no sentence
 * to understand and no button to find: Chiku jumps, and the child jumps. So the
 * things worth pinning down here are the things that make a movement READABLE
 * to a two-year-old, not the things that make it correct on paper:
 *
 *   - it is BIG (the whole figure moves, not a detail);
 *   - it is SLOW (over a second — they have to finish looking at it);
 *   - it has ANTICIPATION (a counter-movement first, which is both what makes
 *     the move read as deliberate and what gives a small child time to look up);
 *   - it ENDS WHERE IT STARTED, so calling it again — which at this age is what
 *     they will want, over and over — does not walk him off the screen;
 *   - and none of it rebuilds the scene, because the persistent-node renderer
 *     exists precisely so 60fps procedural motion is affordable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveRig, type LiveRig, type PerformMove } from "../src/live";

let host: HTMLElement;
let rig: LiveRig | null = null;

/** Deterministic rAF driver: frames advance only when we say so. */
function makeClock() {
  let t = 0;
  let pending: ((t: number) => void) | null = null;
  let nextHandle = 1;
  return {
    now: () => t,
    raf: (cb: (t: number) => void): number => {
      pending = cb;
      return nextHandle++;
    },
    cancelRaf: (): void => {
      pending = null;
    },
    advance(ms: number, frames = Math.max(1, Math.round(ms / 16))): void {
      const step = ms / frames;
      for (let i = 0; i < frames; i++) {
        t += step;
        const cb = pending;
        pending = null;
        cb?.(t);
      }
    },
    get running(): boolean {
      return pending !== null;
    },
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  host.remove();
});

const MOVES: readonly PerformMove[] = ["jump", "stomp", "crouch", "sway", "reach", "clap", "swing"];

const part = (name: string): Element | null => host.querySelector(`[data-part="${name}"]`);
const root = (): Element | null => host.querySelector(".chiku-live");
const figureTransform = (): string => part("figure")?.getAttribute("transform") ?? "";
const trunkTransform = (): string => part("trunk")?.getAttribute("transform") ?? "";

function build(opts: Parameters<typeof createLiveRig>[1] = {}) {
  const clock = makeClock();
  rig = createLiveRig(host, {
    showBody: true,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    now: clock.now,
    random: () => 0.5,
    ...opts,
  });
  return { clock, rig };
}

/**
 * The translate() a beat contributes, or null when he is at rest.
 *
 * At rest the figure transform is byte-for-byte the one the rig always wrote
 * (`translate(120 170) rotate(…)`) — a beat prepends its own offset and a
 * squash pivoted on the floor, so the two are told apart by shape.
 */
function performOffset(): { x: number; y: number } | null {
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) translate\(/.exec(figureTransform());
  const x = m?.[1];
  const y = m?.[2];
  if (x === undefined || y === undefined) return null;
  return { x: Number(x), y: Number(y) };
}

/** How far a leg is lifted, in viewBox units (0 = planted). */
function legLift(name: "legL" | "legR"): number {
  const m = /translate\(0 (-?[\d.]+)\)/.exec(part(name)?.getAttribute("transform") ?? "");
  return -Number(m?.[1] ?? 0);
}

/* -------------------------------------------------------------------------- */

describe("live rig: perform — a body that can demonstrate", () => {
  it("has legs and feet to stomp with when a body was asked for", () => {
    build();
    expect(part("legL")).not.toBeNull();
    expect(part("legR")).not.toBeNull();
  });

  it("moves the whole figure, and moves it BIG", () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    expect(performOffset()).toBeNull(); // at rest before anything is asked

    void r.perform("jump");
    let highest = 0;
    for (let i = 0; i < 100; i++) {
      clock.advance(16, 1);
      const off = performOffset();
      if (off !== null && off.y < highest) highest = off.y;
    }
    // Tens of viewBox units, not a nudge. A toddler copies a silhouette.
    expect(highest).toBeLessThan(-30);
  });

  it("anticipates: every move starts with a counter-movement", () => {
    // Down before up, up before down, away before toward. That beat of
    // opposite motion is what makes it read as deliberate rather than a
    // glitch — and it is the warning that lets a small child look up in time.
    const { clock, rig: r } = build();
    clock.advance(100);

    void r.perform("jump");
    let sankFirst = false;
    for (let i = 0; i < 20; i++) {
      clock.advance(16, 1);
      const off = performOffset();
      if (off !== null && off.y > 2) sankFirst = true;
      if (off !== null && off.y < -2) break; // already launching
    }
    expect(sankFirst).toBe(true);
  });

  it("is slow enough to copy — every beat lasts over a second", async () => {
    for (const move of MOVES) {
      const { clock, rig: r } = build();
      clock.advance(50);
      let done = false;
      void r.perform(move).then(() => {
        done = true;
      });

      clock.advance(1000, 60);
      await Promise.resolve();
      expect(done, `${move} finished inside a second`).toBe(false);

      clock.advance(4000, 240);
      await Promise.resolve();
      expect(done, `${move} never finished`).toBe(true);

      r.dispose();
      rig = null;
    }
  });

  it("ends where it started, so the same move again is the same move", async () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    const before = figureTransform();

    for (let round = 0; round < 3; round++) {
      let done = false;
      void r.perform("stomp").then(() => {
        done = true;
      });
      clock.advance(4000, 240);
      await Promise.resolve();
      expect(done).toBe(true);
      // Rest is rest: no accumulated drift, no leftover squash, no leg still
      // in the air. Repetition is the point at this age, so the tenth stomp
      // has to look exactly like the first.
      expect(performOffset()).toBeNull();
      expect(legLift("legL")).toBeCloseTo(0, 6);
      expect(legLift("legR")).toBeCloseTo(0, 6);
    }
    // Breathing has moved on, so this is not a string comparison — but the
    // performance contribution is gone entirely.
    expect(before.startsWith("translate(120 170)")).toBe(true);
    expect(figureTransform().startsWith("translate(120 170)")).toBe(true);
  });

  it("lifts one leg at a time for a stomp", () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    void r.perform("stomp");

    let onlyRight = false;
    let onlyLeft = false;
    for (let i = 0; i < 200; i++) {
      clock.advance(16, 1);
      const l = legLift("legL");
      const rr = legLift("legR");
      if (rr > 10 && l < 1) onlyRight = true;
      if (l > 10 && rr < 1) onlyLeft = true;
    }
    // Two stomps, alternating: one stomp is an event, two is a rhythm, and a
    // rhythm is the thing a 2-year-old joins in with.
    expect(onlyRight).toBe(true);
    expect(onlyLeft).toBe(true);
  });

  it("swings the trunk for a swing, and puts the trunk back afterwards", async () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    const restingTrunkD = part("trunk")?.querySelector("path")?.getAttribute("d");

    let done = false;
    void r.perform("swing").then(() => {
      done = true;
    });
    clock.advance(32, 2);
    // The beat took the trunk pose over…
    expect(part("trunk")?.querySelector("path")?.getAttribute("d")).not.toBe(restingTrunkD);

    let extreme = 0;
    for (let i = 0; i < 200; i++) {
      clock.advance(16, 1);
      const deg = Number(/-?[\d.]+/.exec(trunkTransform())?.[0] ?? 0);
      if (Math.abs(deg) > Math.abs(extreme)) extreme = deg;
    }
    expect(Math.abs(extreme)).toBeGreaterThan(20);

    clock.advance(3000, 180);
    await Promise.resolve();
    expect(done).toBe(true);
    // …and handed it back to the emote when it finished.
    expect(part("trunk")?.querySelector("path")?.getAttribute("d")).toBe(restingTrunkD);
  });

  it("never rebuilds the scene to animate", () => {
    const { clock, rig: r } = build();
    const svgBefore = host.querySelector("svg");
    const figureBefore = part("figure");
    const legBefore = part("legL");

    for (const move of MOVES) {
      void r.perform(move);
      clock.advance(600, 36);
    }

    expect(host.querySelector("svg")).toBe(svgBefore);
    expect(part("figure")).toBe(figureBefore);
    expect(part("legL")).toBe(legBefore);
    expect(host.querySelectorAll("svg")).toHaveLength(1);
  });

  it("marks what he is doing on the root, for tests and for CSS", () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    expect(root()?.getAttribute("data-perform")).toBeNull();
    void r.perform("crouch");
    clock.advance(32, 2);
    expect(root()?.getAttribute("data-perform")).toBe("crouch");
    expect(r.debug().performing).toBe("crouch");
    expect(r.debug().performProgress).toBeGreaterThan(0);
  });
});

describe("live rig: perform — interruption", () => {
  it("a new call interrupts the old one and RESOLVES it, like speak()", async () => {
    const { clock, rig: r } = build();
    clock.advance(100);

    let firstDone = false;
    void r.perform("crouch").then(() => {
      firstDone = true;
    });
    clock.advance(300, 18);
    await Promise.resolve();
    expect(firstDone).toBe(false);

    void r.perform("jump");
    await Promise.resolve();
    // Released, not left hanging and not rejected. A child who moved on
    // deserves Chiku to move on too, and the caller has to be told.
    expect(firstDone).toBe(true);
    expect(r.debug().performing).toBe("jump");
  });

  it("the same move again just does it again", async () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    for (let i = 0; i < 4; i++) {
      let done = false;
      void r.perform("jump").then(() => {
        done = true;
      });
      clock.advance(4000, 240);
      await Promise.resolve();
      expect(done, `repeat ${i} never finished`).toBe(true);
    }
  });

  it("dispose() releases a beat that will now never finish", async () => {
    const { clock, rig: r } = build();
    clock.advance(100);
    let done = false;
    void r.perform("sway").then(() => {
      done = true;
    });
    clock.advance(200, 12);
    await Promise.resolve();
    expect(done).toBe(false);

    r.dispose();
    rig = null;
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("perform() after dispose() resolves rather than throwing", async () => {
    const { rig: r } = build();
    r.dispose();
    rig = null;
    await expect(r.perform("clap")).resolves.toBeUndefined();
  });
});

describe("live rig: perform — reduced motion", () => {
  it("holds a static pose instead of moving, and starts no loop", () => {
    const clock = makeClock();
    rig = createLiveRig(host, {
      showBody: true,
      reducedMotion: true,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      now: clock.now,
      random: () => 0.5,
    });
    expect(clock.running).toBe(false);

    void rig.perform("reach");
    expect(clock.running).toBe(false); // still no rAF: nothing is animating

    // He IS in the pose — the most legible frame of the move — so a child who
    // cannot be shown motion is still shown the movement.
    const held = figureTransform();
    expect(held.startsWith("translate(")).toBe(true);
    expect(performOffset()?.y ?? 0).toBeLessThan(-10);
    expect(root()?.getAttribute("data-perform")).toBe("reach");

    clock.advance(3000);
    expect(figureTransform()).toBe(held); // and it does not drift
  });

  it("resolves immediately, because there is no motion to wait out", async () => {
    const clock = makeClock();
    rig = createLiveRig(host, {
      reducedMotion: true,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      now: clock.now,
      random: () => 0.5,
    });
    let done = false;
    void rig.perform("stomp").then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("swaps to the next held pose when asked for a different move", () => {
    const clock = makeClock();
    rig = createLiveRig(host, {
      showBody: true,
      reducedMotion: true,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      now: clock.now,
      random: () => 0.5,
    });
    void rig.perform("reach");
    const up = performOffset()?.y ?? 0;
    void rig.perform("crouch");
    const down = performOffset()?.y ?? 0;

    expect(up).toBeLessThan(0); // risen
    expect(down).toBeGreaterThan(0); // sunk
    expect(root()?.getAttribute("data-perform")).toBe("crouch");
  });
});

describe("live rig: perform — every move is real", () => {
  it("each of the seven actually moves something", async () => {
    for (const move of MOVES) {
      const { clock, rig: r } = build();
      clock.advance(100);
      const restTrunk = trunkTransform();

      void r.perform(move);
      let moved = false;
      for (let i = 0; i < 200 && !moved; i++) {
        clock.advance(16, 1);
        const off = performOffset();
        const ear = part("earL")?.getAttribute("transform") ?? "";
        if (off !== null) moved = true;
        if (trunkTransform() !== restTrunk && Math.abs(Number(/-?[\d.]+/.exec(trunkTransform())?.[0] ?? 0)) > 5) {
          moved = true;
        }
        if (/rotate\((-?[\d.]+)\)/.test(ear) && Math.abs(Number(/rotate\((-?[\d.]+)\)/.exec(ear)?.[1] ?? 0)) > 5) {
          moved = true;
        }
      }
      expect(moved, `${move} did nothing a child could see`).toBe(true);

      r.dispose();
      rig = null;
    }
  });
});
