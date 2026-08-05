// Framework-free SVG DOM construction from data + (emote, viseme, opts).
// Everything here is a pure function of its inputs; timers live in rig.ts.

import {
  ARC_EYE_PATHS,
  EMOTES,
  HAIR_PATHS,
  HEAD_PATH,
  MOUTHS,
  PALETTE,
  TRUNKS,
  type EmoteParams,
  type TrunkPose,
} from "./data";
import type { Emote, Viseme } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export const RIG_CLASS = "chiku-rig";

export interface SceneInput {
  emote: Emote;
  /** null → the emote's default viseme. */
  viseme: Viseme | null;
  /** Rig-owned blink flash (never a CSS animation). */
  eyesClosed: boolean;
  crop: "full" | "head";
  showBody: boolean;
  reducedMotion: boolean;
}

/**
 * The rig's own stylesheet: chiku* keyframes + container layout, scoped by the
 * rig class. chikuBlink from the export is intentionally absent — the rig owns
 * blinking with a timer so it can be suppressed (arc-eye states, reducedMotion).
 */
export function buildStyle(doc: Document): HTMLStyleElement {
  const style = doc.createElement("style");
  style.setAttribute("data-chiku-style", "");
  style.textContent = [
    `.${RIG_CLASS}{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}`,
    `.${RIG_CLASS} svg{width:100%;height:100%;max-height:100vh;overflow:visible;display:block}`,
    `.${RIG_CLASS} [data-part="bars"]{position:absolute;bottom:-4%;left:50%;transform:translateX(-50%);display:flex;gap:7px;align-items:flex-end;height:40px}`,
    `.${RIG_CLASS} [data-part="bars"]>div{width:9px;height:100%;background:${PALETTE.teal};border-radius:5px}`,
    "@keyframes chikuRing{0%{transform:scale(1);opacity:.85}50%{transform:scale(1.045);opacity:.35}100%{transform:scale(1);opacity:.85}}",
    "@keyframes chikuSpin{to{transform:rotate(360deg)}}",
    "@keyframes chikuBar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}",
    `@media (prefers-reduced-motion:reduce){.${RIG_CLASS} *{animation:none !important}}`,
  ].join("\n");
  return style;
}

function svgEl(doc: Document, tag: string, attrs: Record<string, string> = {}): SVGElement {
  const e = doc.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function buildRing(doc: Document, reducedMotion: boolean): SVGElement {
  const g = svgEl(doc, "g", { "data-part": "ring" });
  const outer = svgEl(doc, "circle", {
    cx: "120",
    cy: "112",
    r: "128",
    fill: "none",
    stroke: PALETTE.teal,
    "stroke-width": "4",
    "stroke-dasharray": "14 12",
  });
  const inner = svgEl(doc, "circle", {
    cx: "120",
    cy: "112",
    r: "112",
    fill: "none",
    stroke: PALETTE.teal,
    "stroke-width": "9",
    opacity: ".26",
  });
  if (!reducedMotion) {
    outer.setAttribute("style", "animation:chikuSpin 9s linear infinite;transform-origin:120px 112px");
    inner.setAttribute("style", "animation:chikuRing 1.6s ease-in-out infinite;transform-origin:120px 112px");
  }
  g.append(outer, inner);
  return g;
}

function buildBody(doc: Document): SVGElement {
  const g = svgEl(doc, "g", { "data-part": "body" });
  g.append(
    svgEl(doc, "rect", { x: "82", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
    svgEl(doc, "rect", { x: "128", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
    svgEl(doc, "ellipse", { cx: "97", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
    svgEl(doc, "ellipse", { cx: "143", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
    svgEl(doc, "ellipse", { cx: "120", cy: "252", rx: "68", ry: "64", fill: PALETTE.body }),
    svgEl(doc, "ellipse", { cx: "120", cy: "268", rx: "41", ry: "40", fill: PALETTE.bodyLight }),
  );
  return g;
}

function buildEar(doc: Document, side: "earL" | "earR", transform: string): SVGElement {
  const left = side === "earL";
  const g = svgEl(doc, "g", {
    "data-part": side,
    transform,
    style: `transform-origin:${left ? "76px" : "164px"} 104px`,
  });
  g.append(
    svgEl(doc, "ellipse", { cx: left ? "34" : "206", cy: "98", rx: "46", ry: "53", fill: PALETTE.bodyShade }),
    svgEl(doc, "ellipse", { cx: left ? "24" : "216", cy: "99", rx: "25", ry: "31", fill: PALETTE.innerEar }),
  );
  return g;
}

function buildOpenEyes(doc: Document, p: EmoteParams, closed: boolean): SVGElement {
  const attrs: Record<string, string> = { "data-eyes": closed ? "closed" : "open" };
  if (closed) attrs["style"] = "transform:scaleY(.08);transform-origin:120px 96px";
  const g = svgEl(doc, "g", attrs);
  const r = String(p.eyeR);
  g.append(
    svgEl(doc, "ellipse", { cx: "88", cy: "96", rx: r, ry: r, fill: PALETTE.cream }),
    svgEl(doc, "ellipse", { cx: "156", cy: "96", rx: r, ry: r, fill: PALETTE.cream }),
    svgEl(doc, "circle", { cx: String(p.pupilLX), cy: String(p.pupilY), r: "10", fill: PALETTE.ink }),
    svgEl(doc, "circle", { cx: String(p.pupilRX), cy: String(p.pupilY), r: "10", fill: PALETTE.ink }),
    svgEl(doc, "circle", { cx: String(p.glintLX), cy: String(p.glintY), r: "3.6", fill: PALETTE.cream }),
    svgEl(doc, "circle", { cx: String(p.glintRX), cy: String(p.glintY), r: "3.6", fill: PALETTE.cream }),
  );
  return g;
}

function buildHappyEyes(doc: Document): SVGElement {
  const g = svgEl(doc, "g", {
    "data-eyes": "happy",
    fill: "none",
    stroke: PALETTE.ink,
    "stroke-width": "7",
    "stroke-linecap": "round",
  });
  g.append(svgEl(doc, "path", { d: ARC_EYE_PATHS[0] }), svgEl(doc, "path", { d: ARC_EYE_PATHS[1] }));
  return g;
}

function buildTrunk(doc: Document, pose: TrunkPose): SVGElement {
  const [t1, t2, t3] = TRUNKS[pose];
  const g = svgEl(doc, "g", { "data-part": "trunk", "data-trunk": pose });
  const seg = (d: string, stroke: string, width: string): SVGElement =>
    svgEl(doc, "path", { d, fill: "none", stroke, "stroke-width": width, "stroke-linecap": "round" });
  g.append(
    seg(t3, PALETTE.trunkOuter, "27"),
    seg(t2, PALETTE.trunkOuter, "37"),
    seg(t1, PALETTE.trunkOuter, "47"),
    seg(t3, PALETTE.trunkInner, "21"),
    seg(t2, PALETTE.trunkInner, "31"),
    seg(t1, PALETTE.trunkInner, "41"),
    svgEl(doc, "path", {
      d: t1,
      fill: "none",
      stroke: PALETTE.trunkOuter,
      "stroke-width": "41",
      "stroke-linecap": "butt",
      opacity: ".2",
      "stroke-dasharray": "3 15",
      "stroke-dashoffset": "16",
    }),
  );
  return g;
}

function buildBars(doc: Document, reducedMotion: boolean): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-part", "bars");
  for (const delay of ["0s", ".15s", ".3s", ".45s", ".6s"]) {
    const bar = doc.createElement("div");
    if (!reducedMotion) {
      bar.setAttribute("style", `animation:chikuBar .9s ease-in-out infinite;animation-delay:${delay}`);
    }
    wrap.appendChild(bar);
  }
  return wrap;
}

/**
 * Replace the scene inside `root` (the rig's own container). The injected
 * <style data-chiku-style> child is kept; everything else is rebuilt.
 */
export function renderInto(root: HTMLElement, input: SceneInput): void {
  const doc = root.ownerDocument;
  const p = EMOTES[input.emote];
  const viseme: Viseme = input.viseme ?? p.defaultViseme;

  root.setAttribute("data-emote", input.emote);
  root.setAttribute("data-viseme", viseme);

  for (const child of Array.from(root.children)) {
    if (!child.hasAttribute("data-chiku-style")) child.remove();
  }

  const box =
    input.crop === "head" ? "8 6 224 212" : input.showBody ? "0 0 240 356" : "0 0 240 248";
  const svg = svgEl(doc, "svg", { viewBox: box, "aria-hidden": "true" });

  if (p.ring) svg.appendChild(buildRing(doc, input.reducedMotion));

  const fig = svgEl(doc, "g", {
    "data-part": "figure",
    transform: p.tilt,
    style: "transform-origin:120px 170px",
  });

  if (input.showBody) fig.appendChild(buildBody(doc));

  fig.append(buildEar(doc, "earL", p.earL), buildEar(doc, "earR", p.earR));

  fig.append(
    svgEl(doc, "path", { d: HEAD_PATH, fill: PALETTE.body }),
    svgEl(doc, "path", {
      d: HAIR_PATHS[0],
      fill: "none",
      stroke: PALETTE.bodyShade,
      "stroke-width": "7",
      "stroke-linecap": "round",
    }),
    svgEl(doc, "path", {
      d: HAIR_PATHS[1],
      fill: "none",
      stroke: PALETTE.bodyShade,
      "stroke-width": "7",
      "stroke-linecap": "round",
    }),
  );

  if (p.blush) {
    const blush = svgEl(doc, "g", { "data-part": "blush", opacity: ".5" });
    blush.append(
      svgEl(doc, "ellipse", { cx: "66", cy: "142", rx: "17", ry: "9", fill: PALETTE.blush }),
      svgEl(doc, "ellipse", { cx: "178", cy: "142", rx: "17", ry: "9", fill: PALETTE.blush }),
    );
    fig.appendChild(blush);
  }

  fig.appendChild(p.eyes === "happy" ? buildHappyEyes(doc) : buildOpenEyes(doc, p, input.eyesClosed));

  const brows = svgEl(doc, "g", {
    "data-part": "brows",
    fill: "none",
    stroke: PALETTE.ink,
    "stroke-width": "6",
    "stroke-linecap": "round",
    opacity: ".9",
  });
  brows.append(svgEl(doc, "path", { d: p.browL }), svgEl(doc, "path", { d: p.browR }));
  fig.appendChild(brows);

  const mouth = svgEl(doc, "g", { "data-part": "mouth", "data-viseme": viseme, transform: "translate(4,0)" });
  mouth.appendChild(svgEl(doc, "path", { d: MOUTHS[viseme], fill: PALETTE.ink }));
  if (viseme === "L") {
    mouth.appendChild(svgEl(doc, "ellipse", { cx: "124", cy: "184", rx: "13", ry: "9", fill: PALETTE.blush }));
  }
  fig.appendChild(mouth);

  fig.appendChild(buildTrunk(doc, p.trunk));

  svg.appendChild(fig);
  root.appendChild(svg);

  if (p.bars) root.appendChild(buildBars(doc, input.reducedMotion));
}
