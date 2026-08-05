import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_GROWNUP_TOKENS,
  FONT_KID_DECL,
  FONT_KID_TE_DECL,
  crossCheckManifest,
  extractCustomPropNames,
  extractObjectLiteralKeys,
  extractRootBlock,
  findMissingKidHexes,
  generateTokensCss,
  manifestTokenNames,
  validateCharacterContract,
} from "./ingest-design";
import { KID_TOKENS } from "./kid-tokens";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DS_DIR = join(REPO_ROOT, "design/_ds/modernist-cac67243-34a3-4e5b-bbca-b4b455dfa3f4");

const stylesCss = readFileSync(join(DS_DIR, "styles.css"), "utf8");
const manifestJson = readFileSync(join(DS_DIR, "_ds_manifest.json"), "utf8");
const prototypeHtml = readFileSync(join(REPO_ROOT, "design/Chiku Prototype.dc.html"), "utf8");
const faceHtml = readFileSync(join(REPO_ROOT, "design/ChikuFace.dc.html"), "utf8");

describe("grown-up tokens (styles.css :root)", () => {
  it("extracts the :root block verbatim (a literal substring of styles.css)", () => {
    const inner = extractRootBlock(stylesCss);
    expect(stylesCss).toContain(`:root {${inner}}`);
  });

  it("contains every pinned grown-up token", () => {
    const names = extractCustomPropNames(extractRootBlock(stylesCss));
    for (const pinned of EXPECTED_GROWNUP_TOKENS) {
      expect(names).toContain(pinned);
    }
  });

  it("cross-checks clean against the manifest tokens array", () => {
    const names = extractCustomPropNames(extractRootBlock(stylesCss));
    const drift = crossCheckManifest(names, manifestTokenNames(manifestJson));
    expect(drift.onlyInCss).toEqual([]);
    expect(drift.onlyInManifest).toEqual([]);
  });

  it("reports drift when the manifest gains a token the CSS lacks", () => {
    const names = extractCustomPropNames(extractRootBlock(stylesCss));
    const drift = crossCheckManifest(names, [...manifestTokenNames(manifestJson), "--color-phantom"]);
    expect(drift.onlyInManifest).toEqual(["--color-phantom"]);
  });

  it("throws when there is no :root block", () => {
    expect(() => extractRootBlock("body { color: red }")).toThrow(/:root/);
  });
});

describe("kid palette drift check (Chiku Prototype.dc.html)", () => {
  it("finds every kid hex in the real prototype export", () => {
    expect(findMissingKidHexes(prototypeHtml, KID_TOKENS)).toEqual([]);
  });

  it("names the token when a kid hex is changed upstream", () => {
    // Simulate the designer retuning the listening teal: every occurrence
    // (any case) disappears from the export.
    const mutated = prototypeHtml.replace(/#2f8f86/gi, "#123456");
    expect(findMissingKidHexes(mutated, KID_TOKENS)).toEqual(["--kid-teal"]);
  });

  it("matches case-insensitively (uppercase hex in the export still counts)", () => {
    const html = "<div style='background:#FDF6EC'></div>";
    const cream = KID_TOKENS.filter((t) => t.name === "--kid-cream");
    expect(findMissingKidHexes(html, cream)).toEqual([]);
  });
});

describe("character export contract (ChikuFace.dc.html)", () => {
  it("passes against the real export", () => {
    expect(validateCharacterContract(faceHtml)).toEqual([]);
  });

  it("fails precisely when a viseme is removed from the enum", () => {
    const mutated = faceHtml.replace(",&quot;smile&quot;", "");
    expect(mutated).not.toBe(faceHtml); // mutation applied
    const errors = validateCharacterContract(mutated);
    expect(errors).toContain('data-props: viseme enum: missing "smile"');
    // The MOUTHS table still has all 8 keys, so only the enum should fail.
    expect(errors).toHaveLength(1);
  });

  it("fails on an aliased viseme name (zero aliasing)", () => {
    const mutated = faceHtml.replace("&quot;O&quot;,&quot;U&quot;", "&quot;O&quot;,&quot;UW&quot;");
    expect(mutated).not.toBe(faceHtml);
    const errors = validateCharacterContract(mutated);
    expect(errors).toContain('data-props: viseme enum: missing "U"');
    expect(errors.some((e) => e.includes('unexpected "UW"'))).toBe(true);
  });

  it("fails precisely when a TRUNKS key is missing", () => {
    const mutated = faceHtml.replace(/^\s*wave:.*\n/m, "");
    expect(mutated).not.toBe(faceHtml);
    const errors = validateCharacterContract(mutated);
    expect(errors).toContain('dc-script: TRUNKS keys: missing "wave"');
    expect(errors).toHaveLength(1);
  });

  it("fails precisely when a MOUTHS key is missing", () => {
    const mutated = faceHtml.replace(/^\s*smile:.*\n/m, "");
    expect(mutated).not.toBe(faceHtml);
    const errors = validateCharacterContract(mutated);
    expect(errors).toContain('dc-script: MOUTHS keys: missing "smile"');
    expect(errors).toHaveLength(1);
  });

  it("fails when a boolean prop disappears", () => {
    const mutated = faceHtml.replace("&quot;bars&quot;:", "&quot;barz&quot;:");
    expect(mutated).not.toBe(faceHtml);
    const errors = validateCharacterContract(mutated);
    expect(errors).toContain('data-props: prop "bars" is missing');
  });

  it("extracts MOUTHS/TRUNKS keys from the dc-script", () => {
    const script = faceHtml.match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(extractObjectLiteralKeys(script, "MOUTHS")).toEqual([
      "closed",
      "A",
      "E",
      "O",
      "U",
      "F",
      "L",
      "smile",
    ]);
    expect(extractObjectLiteralKeys(script, "TRUNKS")).toEqual(["down", "wave", "lift"]);
  });
});

describe("generated tokens.css", () => {
  it("regenerates byte-identical to the committed packages/tokens/generated/tokens.css", () => {
    const committed = readFileSync(join(REPO_ROOT, "packages/tokens/generated/tokens.css"), "utf8");
    const regenerated = generateTokensCss(extractRootBlock(stylesCss), KID_TOKENS);
    expect(regenerated).toBe(committed);
  });

  it("carries the header, grown-up tokens verbatim, kid tokens, and font tokens", () => {
    const css = generateTokensCss(extractRootBlock(stylesCss), KID_TOKENS);
    expect(css.startsWith("/* GENERATED by scripts/ingest-design.ts — do not edit */")).toBe(true);
    expect(css).toContain("--color-bg: #f3f2f2;");
    expect(css).toContain("--color-divider: color-mix(in srgb, #201e1d 40%, transparent);");
    for (const t of KID_TOKENS) {
      expect(css).toContain(`${t.name}: ${t.hex};`);
    }
    expect(css).toContain(FONT_KID_DECL);
    expect(css).toContain(FONT_KID_TE_DECL);
    // Exactly one :root block.
    expect(css.match(/:root/g)).toHaveLength(1);
  });
});
