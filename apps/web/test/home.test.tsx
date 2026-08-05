import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/app";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function clickStateButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no state button "${label}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Home", () => {
  it("mounts the rig SVG idling", () => {
    act(() => root.render(<App />));
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.querySelector('[data-emote="idle"]')).not.toBeNull();
    expect(container.querySelector('[data-part="ring"]')).toBeNull();
  });

  it("drives the rig through the dev state switcher", () => {
    act(() => root.render(<App />));
    clickStateButton("listening");
    expect(container.querySelector('[data-emote="listening"]')).not.toBeNull();
    expect(container.querySelector('[data-part="ring"]')).not.toBeNull();
    clickStateButton("goodbye");
    expect(container.querySelector('[data-emote="goodbye"]')).not.toBeNull();
  });

  it("shows the title in both scripts", () => {
    act(() => root.render(<App />));
    const title = container.querySelector(".home-title");
    expect(title?.textContent).toContain("Chiku");
    expect(title?.textContent).toContain("చికు");
  });
});
