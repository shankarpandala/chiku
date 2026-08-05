import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRig, type Rig, type VisemeMark } from "../src/index";
import type { RigClock } from "../src/rig";

let host: HTMLElement;
let rig: Rig | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const eyes = (): string | null | undefined =>
  host.querySelector("[data-eyes]")?.getAttribute("data-eyes");
const visemeAttr = (): string | null | undefined =>
  host.querySelector(`.chiku-rig`)?.getAttribute("data-viseme");
const emoteAttr = (): string | null | undefined =>
  host.querySelector(`.chiku-rig`)?.getAttribute("data-emote");

describe("blink scheduler", () => {
  it("fires within the 3-6s bounds and re-schedules with fresh jitter", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0.5);
    rig = createRig(host);

    // random()=0 -> first blink at exactly 3000ms (the lower bound)
    vi.advanceTimersByTime(2999);
    expect(eyes()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(eyes()).toBe("closed");

    // eye reopens after the closed flash, then a new timer is scheduled
    vi.advanceTimersByTime(150);
    expect(eyes()).toBe("open");

    // random()=1 -> second blink 6000ms (the upper bound) after reopening
    vi.advanceTimersByTime(5999);
    expect(eyes()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(eyes()).toBe("closed");
  });

  it("does not blink during celebrate or goodbye, and resumes after", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // every blink delay = 3000ms
    rig = createRig(host);

    rig.setState("celebrate");
    expect(eyes()).toBe("happy");
    expect(vi.getTimerCount()).toBe(0); // blink timer cancelled, nothing else pending
    vi.advanceTimersByTime(20000);
    expect(eyes()).toBe("happy");

    rig.setState("goodbye");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20000);
    expect(eyes()).toBe("happy");

    rig.setState("idle");
    expect(eyes()).toBe("open");
    vi.advanceTimersByTime(3000);
    expect(eyes()).toBe("closed"); // scheduler resumed
  });
});

describe("speaking", () => {
  it("cycles visemes every 200ms through closed/A/E/O/U/F/L and never smiles", () => {
    rig = createRig(host);
    rig.setState("speaking");
    expect(rig.getState()).toBe("speaking");
    expect(emoteAttr()).toBe("encouraging");

    const seen: string[] = [visemeAttr() ?? ""];
    for (let i = 0; i < 13; i++) {
      vi.advanceTimersByTime(200); // 13 * 200 = 2600ms < 3000ms, no blink interference
      seen.push(visemeAttr() ?? "");
    }
    expect(seen.slice(0, 8)).toEqual(["closed", "A", "E", "O", "U", "F", "L", "closed"]);
    expect(seen).not.toContain("smile");

    rig.setState("idle");
    expect(visemeAttr()).toBe("closed");
    expect(vi.getTimerCount()).toBe(1); // only the blink timer survives the cycle
  });

  it("speak() with marks applies each viseme at its time and resolves, then returns to idle", async () => {
    rig = createRig(host, { createAudio: () => null }); // timer-fallback chain
    const marks: VisemeMark[] = [
      { t: 0, viseme: "O" },
      { t: 300, viseme: "A" },
      { t: 600, viseme: "closed" },
    ];
    let resolved = false;
    const p = rig.speak("checkpoint-1.mp3", marks).then(() => {
      resolved = true;
    });

    expect(rig.getState()).toBe("speaking");
    expect(emoteAttr()).toBe("encouraging");

    await vi.advanceTimersByTimeAsync(0);
    expect(visemeAttr()).toBe("O");

    await vi.advanceTimersByTimeAsync(300);
    expect(visemeAttr()).toBe("A");
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(299);
    expect(visemeAttr()).toBe("A");
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1); // t=600: last mark applies, then speak completes
    await p;
    expect(resolved).toBe(true);
    expect(rig.getState()).toBe("idle");
    expect(visemeAttr()).toBe("closed");
  });

  it("speak() without marks runs the placeholder cycle and resolves after 2s", async () => {
    rig = createRig(host, { createAudio: () => null }); // timer-fallback chain
    let resolved = false;
    const p = rig.speak("hello.mp3").then(() => {
      resolved = true;
    });

    expect(rig.getState()).toBe("speaking");
    await vi.advanceTimersByTimeAsync(200);
    expect(visemeAttr()).toBe("A");

    await vi.advanceTimersByTimeAsync(1799);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    expect(rig.getState()).toBe("idle");
  });

  it("an external setState interrupts an in-flight speak and resolves it", async () => {
    rig = createRig(host, { createAudio: () => null });
    let resolved = false;
    const p = rig.speak("long.mp3").then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(500);
    rig.setState("listening");
    await p;
    expect(resolved).toBe(true);
    expect(rig.getState()).toBe("listening");
  });
});

describe("emote rendering", () => {
  it("listening shows ring + bars, cups the near ear, and widens the eyes", () => {
    rig = createRig(host);
    rig.setState("listening");

    expect(host.querySelector('[data-part="ring"]')).toBeTruthy();
    expect(host.querySelector('[data-part="bars"]')).toBeTruthy();
    expect(host.querySelector('[data-part="earL"]')?.getAttribute("transform")).toBe(
      "rotate(-14) scale(1.08)",
    );
    expect(host.querySelector('[data-part="earR"]')?.getAttribute("transform")).toBe("rotate(5)");
    expect(host.querySelector('[data-eyes="open"] ellipse')?.getAttribute("rx")).toBe("19");
    expect(host.querySelector("style")?.textContent).toContain("@keyframes chikuSpin");

    rig.setState("idle");
    expect(host.querySelector('[data-part="ring"]')).toBeNull();
    expect(host.querySelector('[data-part="bars"]')).toBeNull();
  });

  it("goodbye waves the trunk with arc eyes; celebrate is happy with blush", () => {
    rig = createRig(host);

    rig.setState("goodbye");
    expect(emoteAttr()).toBe("goodbye");
    expect(host.querySelector('[data-part="trunk"]')?.getAttribute("data-trunk")).toBe("wave");
    expect(eyes()).toBe("happy");

    rig.setState("celebrate");
    expect(emoteAttr()).toBe("happy");
    expect(eyes()).toBe("happy");
    expect(host.querySelector('[data-part="blush"]')).toBeTruthy();
    expect(host.querySelector('[data-part="trunk"]')?.getAttribute("data-trunk")).toBe("down");
  });
});

describe("reducedMotion", () => {
  it("renders a static pose with zero timers and no inline animations", () => {
    rig = createRig(host, { reducedMotion: true });
    expect(vi.getTimerCount()).toBe(0);

    rig.setState("speaking");
    expect(vi.getTimerCount()).toBe(0);
    expect(visemeAttr()).toBe("closed"); // static: no cycle running

    rig.setState("listening");
    expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector('[data-part="ring"]')).toBeTruthy(); // still shown, just static
    const animated = Array.from(host.querySelectorAll("[style]")).filter((e) =>
      (e.getAttribute("style") ?? "").includes("animation"),
    );
    expect(animated).toEqual([]);
  });

  it("speak() resolves immediately with zero timers", async () => {
    rig = createRig(host, { reducedMotion: true });
    await rig.speak("a.mp3", [{ t: 0, viseme: "O" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(rig.getState()).toBe("idle");
  });
});

describe("dispose", () => {
  it("removes the DOM and clears every timer", () => {
    rig = createRig(host);
    rig.setState("speaking"); // blink timeout + viseme interval
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rig.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.children.length).toBe(0);
    rig = null;
  });

  it("during an in-flight speak resolves the pending promise and leaks nothing", async () => {
    rig = createRig(host, { createAudio: () => null });
    let resolved = false;
    const p = rig.speak("a.mp3", [{ t: 0, viseme: "O" }, { t: 5000, viseme: "closed" }]).then(() => {
      resolved = true;
    });
    rig.dispose();
    await p;
    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rig = null;
  });
});

describe("injectable clock", () => {
  it("schedules on the injected clock instead of the globals", () => {
    const handles = new Map<number, () => void>();
    let nextId = 1;
    let setTimeoutCalls = 0;
    const clock: Partial<RigClock> = {
      setTimeout: (fn: () => void): unknown => {
        setTimeoutCalls++;
        const id = nextId++;
        handles.set(id, fn);
        return id;
      },
      clearTimeout: (h: unknown): void => {
        handles.delete(h as number);
      },
      setInterval: (fn: () => void): unknown => {
        const id = nextId++;
        handles.set(id, fn);
        return id;
      },
      clearInterval: (h: unknown): void => {
        handles.delete(h as number);
      },
      now: (): number => 0,
    };

    rig = createRig(host, {}, clock);
    expect(setTimeoutCalls).toBe(1); // the blink went to the injected clock
    expect(vi.getTimerCount()).toBe(0); // nothing on the (faked) global clock

    rig.setState("speaking");
    expect(handles.size).toBe(2); // blink timeout + viseme interval
    expect(vi.getTimerCount()).toBe(0);

    rig.dispose();
    expect(handles.size).toBe(0);
    rig = null;
  });
});
