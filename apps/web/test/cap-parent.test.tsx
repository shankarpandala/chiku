import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEFAULT_LIMIT_MIN,
  getLimitMinutes,
  setLimitMinutes,
  markSessionStart,
  resetSessionClock,
  sessionProgress,
  sessionExpired,
} from "../src/session/cap";
import { LangProvider } from "../src/i18n";
import { ParentView } from "../src/surfaces/parent/ParentView";

const LIMIT_KEY = "chiku.limitMin";

beforeEach(() => {
  window.localStorage.clear();
  resetSessionClock();
});

afterEach(() => {
  window.localStorage.clear();
  resetSessionClock();
});

describe("session cap store", () => {
  it("defaults to 20 minutes with empty storage", () => {
    expect(getLimitMinutes()).toBe(DEFAULT_LIMIT_MIN);
    expect(getLimitMinutes()).toBe(20);
  });

  it("clamps writes to 5..45", () => {
    setLimitMinutes(2);
    expect(getLimitMinutes()).toBe(5);
    setLimitMinutes(99);
    expect(getLimitMinutes()).toBe(45);
    setLimitMinutes(-10);
    expect(getLimitMinutes()).toBe(5);
  });

  it("persists via localStorage and reads back", () => {
    setLimitMinutes(35);
    expect(window.localStorage.getItem(LIMIT_KEY)).toBe("35");
    expect(getLimitMinutes()).toBe(35);
  });

  it("ignores garbage or out-of-range stored values", () => {
    window.localStorage.setItem(LIMIT_KEY, "not-a-number");
    expect(getLimitMinutes()).toBe(DEFAULT_LIMIT_MIN);
    window.localStorage.setItem(LIMIT_KEY, "999");
    expect(getLimitMinutes()).toBe(DEFAULT_LIMIT_MIN);
  });

  it("computes sessionProgress against the cap with an injected clock", () => {
    setLimitMinutes(20);
    expect(sessionProgress(123)).toBe(0); // no session started yet
    markSessionStart(0);
    expect(sessionProgress(0)).toBe(0);
    expect(sessionProgress(10 * 60_000)).toBeCloseTo(0.5, 10);
    expect(sessionProgress(15 * 60_000)).toBeCloseTo(0.75, 10);
    expect(sessionProgress(40 * 60_000)).toBe(1); // clamped past the cap
  });

  it("expires exactly at the cap", () => {
    setLimitMinutes(20);
    markSessionStart(0);
    expect(sessionExpired(20 * 60_000 - 1)).toBe(false);
    expect(sessionExpired(20 * 60_000)).toBe(true);
    expect(sessionExpired(21 * 60_000)).toBe(true);
  });
});

describe("ParentView daily limit", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The gate reads performance.now() inside a 50 ms setInterval — fake
    // exactly those so React's own scheduling (setTimeout, microtasks) is real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderParent(): void {
    act(() => {
      root.render(
        <LangProvider>
          <ParentView onBack={() => {}} />
        </LangProvider>,
      );
    });
  }

  /** Press-and-hold the grown-up gate for 2 s of fake time. */
  function openGate(): void {
    const gate = container.querySelector<HTMLButtonElement>(".gate-circle");
    if (!gate) throw new Error("gate button not rendered");
    act(() => {
      gate.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(2100);
    });
  }

  /** Drive the range input like a drag: bypass React's value tracker, then fire input. */
  function slideTo(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
    if (!setter) throw new Error("no native value setter on the range input");
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("stays gated until a full 2 s hold", () => {
    renderParent();
    expect(container.querySelector(".gate-circle")).not.toBeNull();
    const gate = container.querySelector<HTMLButtonElement>(".gate-circle");
    act(() => {
      gate?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(1000); // only halfway there
    });
    expect(container.querySelector('[data-testid="limit-slider"]')).toBeNull();
  });

  it("renders the slider with the stored limit after the gate opens", () => {
    window.localStorage.setItem(LIMIT_KEY, "30");
    renderParent();
    openGate();
    const slider = container.querySelector<HTMLInputElement>('[data-testid="limit-slider"]');
    expect(slider).not.toBeNull();
    expect(slider?.value).toBe("30");
    expect(slider?.min).toBe("5");
    expect(slider?.max).toBe("45");
    expect(slider?.step).toBe("5");
    expect(container.querySelector('[data-testid="limit-value"]')?.textContent).toContain("30 minutes");
    // Parents see where the sun is for the running session.
    expect(container.querySelector('[data-testid="sunmoon"]')).not.toBeNull();
  });

  it("dragging the slider updates the real cap store and the live label", () => {
    renderParent();
    openGate();
    const slider = container.querySelector<HTMLInputElement>('[data-testid="limit-slider"]');
    if (!slider) throw new Error("limit slider not rendered");
    expect(slider.value).toBe("20"); // default
    slideTo(slider, "40");
    expect(getLimitMinutes()).toBe(40);
    expect(window.localStorage.getItem(LIMIT_KEY)).toBe("40");
    expect(slider.value).toBe("40");
    expect(container.querySelector('[data-testid="limit-value"]')?.textContent).toContain("40 minutes");
    slideTo(slider, "5");
    expect(getLimitMinutes()).toBe(5);
    expect(container.querySelector('[data-testid="limit-value"]')?.textContent).toContain("5 minutes");
  });
});
