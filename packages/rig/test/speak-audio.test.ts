import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRig, type AmplitudeSource, type Rig, type RigAudio, type VisemeMark } from "../src/index";

class FakeAudio implements RigAudio {
  currentTime = 0; // seconds
  playCalls = 0;
  pauseCalls = 0;
  playRejects = false;
  private listeners: Record<"ended" | "error", Array<() => void>> = { ended: [], error: [] };

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playRejects ? Promise.reject(new Error("blocked")) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
  }
  addEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners[type].push(listener);
  }
  removeEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }
  dispatch(type: "ended" | "error"): void {
    for (const l of [...this.listeners[type]]) l();
  }
  get listenerCount(): number {
    return this.listeners.ended.length + this.listeners.error.length;
  }
}

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
});

const visemeAttr = (): string | null | undefined =>
  host.querySelector(".chiku-rig")?.getAttribute("data-viseme");
const emoteAttr = (): string | null | undefined =>
  host.querySelector(".chiku-rig")?.getAttribute("data-emote");

const MARKS: VisemeMark[] = [
  { t: 0, viseme: "O" },
  { t: 300, viseme: "A" },
  { t: 600, viseme: "closed" },
];

describe("speak() on the audio clock", () => {
  it("plays the url and applies marks from audio.currentTime, not wall time", async () => {
    const audio = new FakeAudio();
    rig = createRig(host, { createAudio: () => audio });

    let resolved = false;
    const p = rig.speak("praise.m4a", MARKS).then(() => {
      resolved = true;
    });
    expect(audio.playCalls).toBe(1);

    // Audio stalls at 0s: wall-clock time passes but marks stay at t=0.
    await vi.advanceTimersByTimeAsync(1000);
    expect(visemeAttr()).toBe("O");

    // Audio jumps ahead — the next poll applies every due mark in order.
    audio.currentTime = 0.35;
    await vi.advanceTimersByTimeAsync(50);
    expect(visemeAttr()).toBe("A");

    audio.currentTime = 0.7;
    await vi.advanceTimersByTimeAsync(50);
    expect(visemeAttr()).toBe("closed");
    expect(resolved).toBe(false); // completion comes from 'ended', never a timer

    audio.dispatch("ended");
    await p;
    expect(resolved).toBe(true);
    expect(rig!.getState()).toBe("idle");
    expect(audio.listenerCount).toBe(0); // detached on finish
  });

  it("keeps the celebrate emote while praise marks drive the mouth", async () => {
    const audio = new FakeAudio();
    rig = createRig(host, { createAudio: () => audio });

    rig.setState("celebrate");
    const p = rig.speak("praise.m4a", MARKS);
    expect(emoteAttr()).toBe("happy"); // not handed over to encouraging

    audio.currentTime = 0.35;
    await vi.advanceTimersByTimeAsync(50);
    expect(visemeAttr()).toBe("A");

    audio.dispatch("ended");
    await p;
    expect(rig!.getState()).toBe("idle");
  });

  it("without marks drives the mouth from the amplitude sampler and disposes it", async () => {
    const audio = new FakeAudio();
    let level = 0.2;
    const dispose = vi.fn();
    const amp: AmplitudeSource = { sample: () => level, dispose };
    rig = createRig(host, { createAudio: () => audio, createAmplitude: () => amp });

    const p = rig.speak("praise.m4a");
    await vi.advanceTimersByTimeAsync(60);
    expect(visemeAttr()).toBe("O"); // loud

    level = 0.05;
    await vi.advanceTimersByTimeAsync(60);
    expect(visemeAttr()).toBe("E"); // quiet

    level = 0.001;
    await vi.advanceTimersByTimeAsync(60);
    expect(visemeAttr()).toBe("closed"); // silence

    audio.dispatch("ended");
    await p;
    expect(dispose).toHaveBeenCalledOnce();
    expect(rig!.getState()).toBe("idle");
  });

  it("falls back to timer-scheduled marks when playback is blocked (never dead-air)", async () => {
    const audio = new FakeAudio();
    audio.playRejects = true;
    rig = createRig(host, { createAudio: () => audio });

    let resolved = false;
    const p = rig.speak("praise.m4a", MARKS).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0); // let the play() rejection propagate
    await vi.advanceTimersByTimeAsync(300);
    expect(visemeAttr()).toBe("A"); // marks now ride wall time

    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(resolved).toBe(true);
    expect(rig!.getState()).toBe("idle");
  });

  it("interrupting via setState pauses the audio and resolves the promise", async () => {
    const audio = new FakeAudio();
    rig = createRig(host, { createAudio: () => audio });

    let resolved = false;
    const p = rig.speak("praise.m4a", MARKS).then(() => {
      resolved = true;
    });
    rig.setState("listening");
    await p;
    expect(resolved).toBe(true);
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(audio.listenerCount).toBe(0);
    expect(rig!.getState()).toBe("listening");
  });
});
