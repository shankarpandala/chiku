/**
 * Kid palette — the explicit, checked-in source of truth for the kid-surface
 * colors. The design export (design/Chiku Prototype.dc.html) is canon;
 * scripts/ingest-design.ts ASSERTS every hex below still appears there
 * (case-insensitive) so palette drift upstream fails the ingest loudly.
 *
 * Role comments come from the prototype's palette card ("Design language"
 * screen) and observed usage in the same file.
 */

export interface KidToken {
  /** CSS custom-property name, e.g. "--kid-cream". */
  readonly name: string;
  /** Six-digit lowercase hex, e.g. "#fdf6ec". */
  readonly hex: string;
  /** One-line role from the design. */
  readonly role: string;
}

export const KID_TOKENS: readonly KidToken[] = [
  { name: "--kid-cream", hex: "#fdf6ec", role: "Cream — kid ground: warm, low-glare, safe under a TV's brightness" },
  { name: "--kid-sand", hex: "#f5e7d0", role: "Sand — raised kid surface: icon wells, tiles and cards on cream" },
  { name: "--kid-ink", hex: "#2c2a35", role: "Ink — type and the mouth; shared with the Modernist parent area" },
  { name: "--kid-chiku", hex: "#a293c4", role: "Chiku violet — the character; never a UI surface, so Chiku is always the figure" },
  { name: "--kid-chiku-dark", hex: "#7d6da3", role: "Chiku violet (dark) — trunk shading and the violet 'Chiku is talking' pill" },
  { name: "--kid-marigold", hex: "#f0a33c", role: "Marigold — one primary action per screen; also the D-pad focus ring" },
  { name: "--kid-teal", hex: "#2f8f86", role: "Listening teal — RESERVED: only ever means 'Chiku is hearing you'" },
  { name: "--kid-rose", hex: "#e9848c", role: "Rose — ending and leaving: warm, not alarming" },
  { name: "--kid-leaf", hex: "#6aa84f", role: "Leaf — growth green for scenery and gentle 'yes' moments" },
];
