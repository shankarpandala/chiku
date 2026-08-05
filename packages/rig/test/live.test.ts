import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveRig, type LiveRig } from "../src/live";

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
    /** Advance the clock and run that many frames. */
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

const svg = (): SVGSVGElement | null => host.querySelector("svg");
const part = (name: string): Element | null => host.querySelector(`[data-part="${name}"]`);
const pupilL = (): Element | null => host.querySelectorAll('[data-part="eyesOpen"] circle')[0] ?? null;
/** The rig's own state marker, on the root only. */
const eyesState = (): string | null | undefined =>
  host.querySelector(".chiku-live")?.getAttribute("data-eyes");

describe("live rig: persistent nodes", () => {
  it("builds the scene once and never rebuilds it across frames", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });

    const svgBefore = svg();
    const figureBefore = part("figure");
    const pupilBefore = pupilL();
    expect(svgBefore).not.toBeNull();

    clock.advance(1000); // ~60 frames

    // Same node identity — attributes were written, nothing was re-created.
    expect(svg()).toBe(svgBefore);
    expect(part("figure")).toBe(figureBefore);
    expect(pupilL()).toBe(pupilBefore);
    expect(host.querySelectorAll("svg")).toHaveLength(1);
  });

  it("keeps painting frame after frame while alive", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    expect(clock.running).toBe(true);
    clock.advance(500);
    expect(clock.running).toBe(true);
  });
});

describe("live rig: gaze", () => {
  it("moves the pupils toward the gaze target and settles there", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setAttention(true);
    const baseCx = Number(pupilL()?.getAttribute("cx"));

    rig.setGaze(1, 0);
    clock.advance(600);
    const right = Number(pupilL()?.getAttribute("cx"));
    expect(right).toBeGreaterThan(baseCx);

    rig.setGaze(-1, 0);
    clock.advance(600);
    const left = Number(pupilL()?.getAttribute("cx"));
    expect(left).toBeLessThan(right);
  });

  it("eases rather than snapping — one frame moves only part of the way", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setAttention(true);
    rig.setGaze(1, 0);
    clock.advance(16, 1); // exactly one frame
    const after1 = rig.debug().gazeX;
    expect(after1).toBeGreaterThan(0);
    expect(after1).toBeLessThan(0.95); // not teleported to the target
  });

  it("clamps out-of-range and non-finite gaze input", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setAttention(true);
    rig.setGaze(9, -9);
    clock.advance(1200);
    expect(rig.debug().gazeX).toBeLessThanOrEqual(1);
    expect(rig.debug().gazeY).toBeGreaterThanOrEqual(-1);

    rig.setGaze(Number.NaN, Number.NaN);
    clock.advance(600);
    expect(Number.isFinite(rig.debug().gazeX)).toBe(true);
  });

  it("wanders on its own when nobody is attending", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setGaze(0, 0);
    rig.setAttention(false);
    clock.advance(1500);
    const a = rig.debug().gazeX;
    clock.advance(1500);
    const b = rig.debug().gazeX;
    expect(a).not.toBeCloseTo(b, 3); // eyes kept moving without any input
  });
});

describe("live rig: mouth + emote", () => {
  it("opens the mouth with loudness and closes again", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setMouthOpen(1);
    clock.advance(300);
    const open = part("mouth")?.getAttribute("transform") ?? "";
    expect(open).toMatch(/scale\(1 1\.[3-9]/); // scaled up

    rig.setMouthOpen(0);
    clock.advance(300);
    const shut = part("mouth")?.getAttribute("transform") ?? "";
    expect(shut).toMatch(/scale\(1 1\.0/);
  });

  it("swaps viseme paths and shows the tongue only for L", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setViseme("O");
    clock.advance(32);
    expect(host.querySelector(".chiku-live")?.getAttribute("data-viseme")).toBe("O");
    const tongueOpacity = () => part("mouth")?.querySelector("ellipse")?.getAttribute("opacity");
    expect(tongueOpacity()).toBe("0");

    rig.setViseme("L");
    clock.advance(32);
    expect(tongueOpacity()).toBe("1");
  });

  it("eases between emote poses and switches to arc eyes for happy", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    clock.advance(100);
    const arcOpacity = () => Number(part("eyesArc")?.getAttribute("opacity"));
    expect(arcOpacity()).toBeLessThan(0.1);

    rig.setEmote("happy");
    clock.advance(800);
    expect(arcOpacity()).toBeGreaterThan(0.8);
    expect(Number(part("blush")?.getAttribute("opacity"))).toBeGreaterThan(0.3);
  });

  it("uses the wave trunk for goodbye", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    const firstTrunkD = () => part("trunk")?.querySelector("path")?.getAttribute("d");
    const down = firstTrunkD();
    rig.setEmote("goodbye");
    clock.advance(32);
    expect(firstTrunkD()).not.toBe(down);
  });
});

describe("live rig: reducedMotion + dispose", () => {
  it("renders a static pose with no rAF loop at all", () => {
    const clock = makeClock();
    rig = createLiveRig(host, {
      reducedMotion: true,
      raf: clock.raf,
      cancelRaf: clock.cancelRaf,
      now: clock.now,
      random: () => 0.5,
    });
    expect(svg()).not.toBeNull();
    expect(clock.running).toBe(false); // nothing scheduled

    const before = part("figure")?.getAttribute("transform");
    clock.advance(2000);
    expect(part("figure")?.getAttribute("transform")).toBe(before); // frozen
  });

  it("dispose cancels the loop and removes the DOM", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    clock.advance(100);
    rig.dispose();
    expect(clock.running).toBe(false);
    expect(host.children.length).toBe(0);
    rig = null;
  });

  it("survives a tab-switch time jump without exploding", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.5 });
    rig.setAttention(true);
    rig.setGaze(1, 1);
    clock.advance(300_000, 2); // two frames, 2.5 minutes apart
    const d = rig.debug();
    expect(Number.isFinite(d.gazeX)).toBe(true);
    expect(d.gazeX).toBeLessThanOrEqual(1);
  });
});

describe("live rig: auto-blink", () => {
  it("blinks on its own within the 3–6s window, then reopens", () => {
    const clock = makeClock();
    // random()=0 puts every blink at the 3s lower bound.
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0 });

    // Sample every frame — a blink is only ~120ms, so a coarse advance would
    // step right over it.
    const seen = new Set<string>();
    const sample = (ms: number): void => {
      for (let i = 0; i < ms / 16; i++) {
        clock.advance(16, 1);
        const s = eyesState();
        if (typeof s === "string") seen.add(s);
      }
    };

    sample(2800); // before the earliest possible blink
    expect([...seen]).toEqual(["open"]);

    sample(600); // crosses t=3000
    expect(seen.has("closed")).toBe(true);
    expect(eyesState()).toBe("open"); // and it reopened by the end
  });

  it("blink() closes the eyes on demand", () => {
    const clock = makeClock();
    rig = createLiveRig(host, { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now, random: () => 0.9 });
    clock.advance(100);
    rig.blink();
    clock.advance(32, 1);
    expect(eyesState()).toBe("closed");
  });
});
