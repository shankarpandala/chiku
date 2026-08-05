// TV Stage surface (M3): pairing card (code + real QR route), mic-presence
// pill from room snapshots, and geometric D-pad focus nav. The room transport
// and QR renderer are faked — the §7 contract shapes are exercised for real.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RoomState } from "@chiku/schema";
import { LangProvider } from "../src/i18n";
import { Stage } from "../src/surfaces/stage/Stage";

const h = vi.hoisted(() => ({
  roomSubs: new Set<(room: unknown) => void>(),
  sendSpy: vi.fn(),
  closeSpy: vi.fn(),
  joinRoomMock: vi.fn(),
  createRoomMock: vi.fn(async () => "ABCD"),
  toDataURLMock: vi.fn(async (_text: string, _opts?: unknown) => "data:image/png;base64,QQ=="),
}));

vi.mock("../src/session/room", () => {
  h.joinRoomMock.mockImplementation((code: string, role: string) => ({
    code,
    role,
    send: h.sendSpy,
    onRoom: (cb: (room: unknown) => void) => {
      h.roomSubs.add(cb);
      return () => h.roomSubs.delete(cb);
    },
    onStatus: (cb: (s: string) => void) => {
      cb("open");
      return () => undefined;
    },
    close: h.closeSpy,
  }));
  return { createRoom: h.createRoomMock, joinRoom: h.joinRoomMock };
});

vi.mock("qrcode", () => ({
  default: { toDataURL: h.toDataURLMock },
  toDataURL: h.toDataURLMock,
}));

// The stage needs the episode index; everything else on this module is only
// pulled in by the (unmounted) Player, so it just has to exist.
vi.mock("../src/episodes/client", () => ({
  API_BASE: "http://localhost:8787",
  fetchEpisodeIndex: vi.fn(async () => [
    { id: "ep001", title: { te: "రంగులు", en: "Colours" }, langs: ["te", "en"] },
    { id: "ep002", title: { te: "సంఖ్యలు", en: "Numbers" }, langs: ["te", "en"] },
  ]),
  fetchEpisode: vi.fn(async () => Promise.reject(new Error("not used in stage tests"))),
  fetchMarks: vi.fn(async () => Promise.reject(new Error("not used in stage tests"))),
  mediaUrl: (episodeId: string, file: string) => `/media/${episodeId}/${file}`,
  understand: vi.fn(async () => Promise.reject(new Error("not used in stage tests"))),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.roomSubs.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderStage(onExit: () => void = () => undefined): Promise<void> {
  await act(async () => {
    root.render(
      <LangProvider>
        <Stage onExit={onExit} />
      </LangProvider>,
    );
  });
  // Second turn: createRoom → session → QR + presence effects settle.
  await act(async () => {
    await Promise.resolve();
  });
}

function snapshot(micConnected: boolean): RoomState {
  return {
    createdAt: 0,
    stage: { connected: true },
    mic: { connected: micConnected },
    state: {
      mode: "player",
      episodeId: "ep001",
      segIdx: 0,
      phase: "playing",
      lastUtterance: { text: "", conf: 0, ts: 0 },
      playAudio: { url: "", marks: "", nonce: 0 },
    },
    control: { pause: false, end: false, volume: 0.8 },
  };
}

function emitRoom(room: RoomState): void {
  act(() => {
    for (const cb of [...h.roomSubs]) cb(room);
  });
}

function setRect(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("Stage", () => {
  it("creates a room, joins as stage, and renders the code + a scannable QR", async () => {
    await renderStage();

    expect(h.createRoomMock).toHaveBeenCalled();
    expect(h.joinRoomMock).toHaveBeenCalledWith("ABCD", "stage");

    const code = container.querySelector('[data-testid="stage-code"]');
    expect(code?.textContent).toBe("ABCD");

    const img = container.querySelector<HTMLImageElement>("img.stage-qr");
    expect(img).not.toBeNull();
    expect(img?.src).toBe("data:image/png;base64,QQ==");
    const encoded = h.toDataURLMock.mock.calls.map((c) => c[0]);
    expect(encoded.some((url) => url.endsWith("#/mic/ABCD"))).toBe(true);

    // Pairing copy is present; the TV itself never shows mic UI.
    expect(container.textContent).toContain("Scan with a grown-up's phone");
  });

  it("shows the paired pill (marigold, not teal) once a snapshot has mic.connected", async () => {
    await renderStage();

    expect(container.textContent).not.toContain("Phone connected!");
    emitRoom(snapshot(true));

    const pill = container.querySelector(".stage-paired");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("Phone connected!");
    expect(pill?.className).toContain("pill-marigold");

    emitRoom(snapshot(false));
    expect(container.querySelector(".stage-paired")).toBeNull();
  });

  it("moves D-pad focus geometrically between [data-focusable] cards", async () => {
    await renderStage();

    const cards = [...container.querySelectorAll<HTMLElement>(".stage-grid [data-focusable]")];
    expect(cards.length).toBe(2);
    const [first, second] = cards;
    if (first === undefined || second === undefined) throw new Error("missing cards");

    // happy-dom has no layout — give the two cards real geometry.
    setRect(first, 0, 0, 100, 100);
    setRect(second, 200, 0, 100, 100);

    act(() => first.focus());
    expect(document.activeElement).toBe(first);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(second);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
  });
});
