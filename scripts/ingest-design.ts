/**
 * Design ingest — design/ → packages/tokens/generated/tokens.css + validation.
 *
 * Run as `corepack pnpm ingest` (i.e. `tsx scripts/ingest-design.ts`).
 *
 * Sections (each prints one ✓ line on success; any failure exits non-zero):
 *   1. Grown-up tokens — extract the :root custom-property block VERBATIM from
 *      the Modernist styles.css (source of truth; the manifest's tokens array
 *      has a buggy "kind" field, e.g. --color-text mislabeled "font"). Names
 *      are cross-checked against _ds_manifest.json — drift only WARNS.
 *   2. Kid palette — scripts/kid-tokens.ts is the checked-in source; every hex
 *      must still appear (case-insensitive) in design/Chiku Prototype.dc.html.
 *      Drift detection, not scraping: a missing hex is a hard failure naming
 *      the token.
 *   3. Character contract — design/ChikuFace.dc.html must declare the pinned
 *      emote/viseme enums exactly (zero aliasing), the ring/bars/showBody/crop
 *      props, and the MOUTHS/TRUNKS tables in its dc-script.
 *   4. Emit packages/tokens/generated/tokens.css.
 *
 * Parsing/validation are exported as pure functions over string inputs so the
 * root vitest run (scripts/ingest-design.test.ts) can exercise them against
 * the real files and against mutated copies.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KID_TOKENS, type KidToken } from "./kid-tokens";

// ── Pinned contracts ────────────────────────────────────────────────────────

/** Canonical emotes (design-contract ruling 2026-08-05). */
export const EMOTES = ["idle", "listening", "happy", "encouraging", "goodbye", "thinking"] as const;

/** Canonical visemes (design-contract ruling 2026-08-05 — not UW/FV). */
export const VISEMES = ["closed", "A", "E", "O", "U", "F", "L", "smile"] as const;

/** Trunk poses the dc-script must define. */
export const TRUNK_KEYS = ["down", "wave", "lift"] as const;

/** Grown-up tokens consumers rely on; all must exist in the Modernist :root. */
export const EXPECTED_GROWNUP_TOKENS: readonly string[] = [
  "--color-bg",
  "--color-surface",
  "--color-text",
  "--color-accent",
  "--color-accent-2",
  "--color-divider",
  ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => `--color-neutral-${n}`),
  ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => `--color-accent-${n}`),
  ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => `--color-accent-2-${n}`),
  "--font-heading",
  "--font-heading-weight",
  "--font-body",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-6",
  "--space-8",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
];

/** Kid font stacks (pinned; fonts.css itself is owned elsewhere). */
export const FONT_KID_DECL = `--font-kid: "Baloo 2", system-ui, sans-serif;`;
export const FONT_KID_TE_DECL = `--font-kid-te: "Baloo Tammudu 2", "Baloo 2", system-ui, sans-serif;`;

// ── Section 1: grown-up tokens from styles.css ──────────────────────────────

/**
 * Extract the inner content of the first `:root { ... }` block, VERBATIM
 * (comments and formatting included; braces excluded). Throws if absent.
 */
export function extractRootBlock(css: string): string {
  const start = css.search(/:root\s*\{/);
  if (start === -1) {
    throw new Error("styles.css: no `:root {` block found");
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("styles.css: unterminated `:root {` block");
}

/** Names of the custom properties declared in a rule block. */
export function extractCustomPropNames(rootBlockInner: string): string[] {
  const names: string[] = [];
  for (const m of rootBlockInner.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
    const name = m[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Parse the manifest's tokens array into a list of names. */
export function manifestTokenNames(manifestJson: string): string[] {
  const parsed: unknown = JSON.parse(manifestJson);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("_ds_manifest.json: root is not an object");
  }
  const tokens = (parsed as Record<string, unknown>)["tokens"];
  if (!Array.isArray(tokens)) {
    throw new Error("_ds_manifest.json: no tokens array");
  }
  const names: string[] = [];
  for (const t of tokens) {
    if (typeof t === "object" && t !== null) {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/** Name drift between the CSS :root (truth) and the manifest (warn only). */
export function crossCheckManifest(
  cssNames: readonly string[],
  manifestNames: readonly string[],
): { onlyInCss: string[]; onlyInManifest: string[] } {
  return {
    onlyInCss: cssNames.filter((n) => !manifestNames.includes(n)),
    onlyInManifest: manifestNames.filter((n) => !cssNames.includes(n)),
  };
}

// ── Section 2: kid palette drift check ──────────────────────────────────────

/**
 * Names of kid tokens whose hex does NOT appear (case-insensitive) in the
 * prototype HTML. Non-empty ⇒ hard failure.
 */
export function findMissingKidHexes(prototypeHtml: string, tokens: readonly KidToken[]): string[] {
  const haystack = prototypeHtml.toLowerCase();
  const missing: string[] = [];
  for (const t of tokens) {
    if (!/^#[0-9a-f]{6}$/i.test(t.hex)) {
      missing.push(`${t.name} (malformed hex "${t.hex}" in scripts/kid-tokens.ts)`);
    } else if (!haystack.includes(t.hex.toLowerCase())) {
      missing.push(t.name);
    }
  }
  return missing;
}

// ── Section 3: character export contract (ChikuFace.dc.html) ────────────────

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exact-set comparison; returns precise error strings (empty = match). */
function compareSets(actual: readonly string[], expected: readonly string[], what: string): string[] {
  const errors: string[] = [];
  for (const e of expected) {
    if (!actual.includes(e)) errors.push(`${what}: missing "${e}"`);
  }
  for (const a of actual) {
    if (!expected.includes(a)) {
      errors.push(`${what}: unexpected "${a}" (zero aliasing — only the canonical names are allowed)`);
    }
  }
  return errors;
}

/** Top-level keys of `const <objName> = { ... }` in the dc-script source. */
export function extractObjectLiteralKeys(scriptSource: string, objName: string): string[] | null {
  const m = scriptSource.match(new RegExp(`const\\s+${objName}\\s*=\\s*\\{`));
  if (!m || m.index === undefined) return null;
  const open = scriptSource.indexOf("{", m.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < scriptSource.length; i++) {
    if (scriptSource[i] === "{") depth++;
    else if (scriptSource[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  const body = scriptSource.slice(open + 1, close);
  const keys: string[] = [];
  for (const km of body.matchAll(/(?:^|[,{]\s*|\n\s*)([A-Za-z_$][\w$]*)\s*:/g)) {
    const key = km[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/**
 * Validate ChikuFace.dc.html against the pinned character export contract.
 * Returns precise error messages; empty array = contract holds.
 */
export function validateCharacterContract(faceHtml: string): string[] {
  const errors: string[] = [];

  // data-props
  const propsAttr = faceHtml.match(/data-props="([^"]*)"/);
  const rawProps = propsAttr?.[1];
  if (rawProps === undefined) {
    errors.push("ChikuFace.dc.html: no data-props attribute found on the dc-script tag");
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeHtmlEntities(rawProps));
    } catch (e) {
      errors.push(`ChikuFace.dc.html: data-props is not valid JSON after entity-decoding (${String(e)})`);
    }
    if (isRecord(parsed)) {
      const checkEnum = (prop: string, expected: readonly string[]): void => {
        const def = parsed[prop];
        if (!isRecord(def)) {
          errors.push(`data-props: prop "${prop}" is missing`);
          return;
        }
        if (def["editor"] !== "enum") {
          errors.push(`data-props: prop "${prop}" must be an enum (editor="enum"), got editor=${JSON.stringify(def["editor"])}`);
          return;
        }
        const options = def["options"];
        if (!Array.isArray(options) || !options.every((o): o is string => typeof o === "string")) {
          errors.push(`data-props: prop "${prop}" has no string options array`);
          return;
        }
        errors.push(...compareSets(options, expected, `data-props: ${prop} enum`));
      };
      const checkBoolean = (prop: string): void => {
        const def = parsed[prop];
        if (!isRecord(def)) {
          errors.push(`data-props: prop "${prop}" is missing`);
        } else if (def["editor"] !== "boolean") {
          errors.push(`data-props: prop "${prop}" must be a boolean (editor="boolean"), got editor=${JSON.stringify(def["editor"])}`);
        }
      };

      checkEnum("emote", EMOTES);
      checkEnum("viseme", VISEMES);
      checkBoolean("ring");
      checkBoolean("bars");
      checkBoolean("showBody");
      checkEnum("crop", ["full", "head"]);
    } else if (parsed !== undefined) {
      errors.push("ChikuFace.dc.html: data-props JSON is not an object");
    }
  }

  // dc-script: MOUTHS and TRUNKS tables
  const script = faceHtml.match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/);
  const scriptSource = script?.[1];
  if (scriptSource === undefined) {
    errors.push("ChikuFace.dc.html: no data-dc-script <script> block found");
  } else {
    const mouthKeys = extractObjectLiteralKeys(scriptSource, "MOUTHS");
    if (mouthKeys === null) {
      errors.push("dc-script: no `const MOUTHS = { ... }` object found");
    } else {
      errors.push(...compareSets(mouthKeys, VISEMES, "dc-script: MOUTHS keys"));
    }
    const trunkKeys = extractObjectLiteralKeys(scriptSource, "TRUNKS");
    if (trunkKeys === null) {
      errors.push("dc-script: no `const TRUNKS = { ... }` object found");
    } else {
      errors.push(...compareSets(trunkKeys, TRUNK_KEYS, "dc-script: TRUNKS keys"));
    }
  }

  return errors;
}

// ── Section 4: emit tokens.css ──────────────────────────────────────────────

export function generateTokensCss(grownUpRootInner: string, kidTokens: readonly KidToken[]): string {
  const grownUp = grownUpRootInner.replace(/^\n/, "").replace(/\s+$/, "");
  const kid = kidTokens.map((t) => `  /* ${t.role} */\n  ${t.name}: ${t.hex};`).join("\n");
  return [
    "/* GENERATED by scripts/ingest-design.ts — do not edit */",
    "/* Grown-up tokens: verbatim from design/_ds/modernist-cac67243-34a3-4e5b-bbca-b4b455dfa3f4/styles.css */",
    "/* Kid palette: scripts/kid-tokens.ts, drift-checked against design/Chiku Prototype.dc.html */",
    "",
    ":root {",
    grownUp,
    "",
    "  /* — Kid palette — */",
    kid,
    "",
    "  /* — Kid font stacks (self-hosted; see @chiku/tokens/fonts.css) — */",
    `  ${FONT_KID_DECL}`,
    `  ${FONT_KID_TE_DECL}`,
    "}",
    "",
  ].join("\n");
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DS_DIR = join(REPO_ROOT, "design/_ds/modernist-cac67243-34a3-4e5b-bbca-b4b455dfa3f4");
const OUT_FILE = join(REPO_ROOT, "packages/tokens/generated/tokens.css");

function main(): void {
  const stylesCss = readFileSync(join(DS_DIR, "styles.css"), "utf8");
  const manifestJson = readFileSync(join(DS_DIR, "_ds_manifest.json"), "utf8");
  const prototypeHtml = readFileSync(join(REPO_ROOT, "design/Chiku Prototype.dc.html"), "utf8");
  const faceHtml = readFileSync(join(REPO_ROOT, "design/ChikuFace.dc.html"), "utf8");

  const errors: string[] = [];

  // 1 — grown-up tokens
  let rootInner = "";
  try {
    rootInner = extractRootBlock(stylesCss);
    const names = extractCustomPropNames(rootInner);
    const missingPinned = EXPECTED_GROWNUP_TOKENS.filter((n) => !names.includes(n));
    for (const n of missingPinned) {
      errors.push(`styles.css :root is missing pinned grown-up token ${n}`);
    }
    const drift = crossCheckManifest(names, manifestTokenNames(manifestJson));
    for (const n of drift.onlyInCss) {
      console.warn(`⚠ manifest drift: ${n} is in styles.css :root but not in _ds_manifest.json tokens`);
    }
    for (const n of drift.onlyInManifest) {
      console.warn(`⚠ manifest drift: ${n} is in _ds_manifest.json tokens but not in styles.css :root`);
    }
    if (missingPinned.length === 0) {
      const driftCount = drift.onlyInCss.length + drift.onlyInManifest.length;
      console.log(
        `✓ grown-up tokens: ${names.length} custom properties extracted verbatim from styles.css` +
          (driftCount === 0 ? " (manifest cross-check: no drift)" : ` (${driftCount} manifest drift warnings)`),
      );
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // 2 — kid palette drift check
  const missingKid = findMissingKidHexes(prototypeHtml, KID_TOKENS);
  for (const name of missingKid) {
    errors.push(`kid palette drift: hex for ${name} not found in design/Chiku Prototype.dc.html`);
  }
  if (missingKid.length === 0) {
    console.log(`✓ kid palette: all ${KID_TOKENS.length} hexes found in design/Chiku Prototype.dc.html`);
  }

  // 3 — character export contract
  const contractErrors = validateCharacterContract(faceHtml);
  errors.push(...contractErrors);
  if (contractErrors.length === 0) {
    console.log(
      `✓ character contract: emote×${EMOTES.length}, viseme×${VISEMES.length}, ` +
        `props ring/bars/showBody/crop, MOUTHS×${VISEMES.length}, TRUNKS×${TRUNK_KEYS.length} — ChikuFace.dc.html matches`,
    );
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`✗ ${err}`);
    console.error(`\ningest failed: ${errors.length} error(s); ${OUT_FILE} not written`);
    process.exit(1);
  }

  // 4 — emit
  const css = generateTokensCss(rootInner, KID_TOKENS);
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, css, "utf8");
  console.log(`✓ wrote packages/tokens/generated/tokens.css (${Buffer.byteLength(css)} bytes)`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main();
}
