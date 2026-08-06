// @vitest-environment happy-dom
//
// THE SWEEP — the durable fix for the bug that has bitten this app three
// phases running: something is built, tested, green, and no child can reach it.
//
// Every phase so far has shipped at least one of these. Phase 3 wrote sixteen
// mercy-ladder lines in two languages, tone-checked them, and never referenced
// a single one. Phase 4 built the whole magic window and shipped it dark.
// Phase 5 found the worst of them: the effort praise — the celebration
// reserved for the child who found it hard and kept going — looked up
// `praise.light.1` while the copy that landed beside it was written
// `praise.light.one`, so every bucket silently fell back to three generic
// cheers and the loudest celebration went to the easiest win. Nothing failed.
// Nothing could fail: the copy existed, the code ran, and the only witness was
// a child who was never quite praised for the right thing.
//
// So this file does not test a feature. It tests the SEAMS:
//
//   1. Both dictionaries carry exactly the same keys, in real Telugu.
//   2. Every key in the dictionaries is reached from `src/` — literally, or by
//      a template that `src/` actually builds. A line nothing can say is not
//      copy, it is a comment with a translation budget.
//   3. Every key `src/` reaches exists in BOTH dictionaries. A missing Telugu
//      line is not a degraded experience on this surface; it is a silent
//      fallback to English on a surface whose promise is that the child's
//      language is not the second one.
//   4. Every exported component is rendered somewhere. A component nobody
//      mounts is Phase 4 all over again.
//   5. The praise buckets resolve to three DIFFERENT families of copy — the
//      one thing a key-coverage test cannot see, pinned by hand because it is
//      exactly the failure that motivated the rest of this file.

import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

// The surface is imported for its praise buckets alone; the real engine would
// drag MediaPipe into a unit test for nothing.
vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => ({
    status: "idle",
    start: async () => {},
    stop: () => {},
    setCalibration: () => {},
    onFrame: () => () => {},
    onStatus: () => () => {},
    dispose: () => {},
  }),
}));

import { PRAISE_BUCKETS } from "../src/surfaces/live/Live";

/* -------------------------------------------------------------------------- */
/* reading the app                                                             */
/* -------------------------------------------------------------------------- */

/** App root, from either the package dir or the repo root. */
function appRoot(): string {
  for (const dir of [process.cwd(), resolve(process.cwd(), "apps/live")]) {
    try {
      statSync(resolve(dir, "src/i18n/en.json"));
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`cannot find apps/live from ${process.cwd()}`);
}

const ROOT = appRoot();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SRC_FILES = walk(resolve(ROOT, "src"));
const SOURCE: ReadonlyMap<string, string> = new Map(
  SRC_FILES.map((f) => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]),
);
/** Everything the app is made of, plus the shell that carries its title. */
const BLOB = [...SOURCE.values(), readFileSync(resolve(ROOT, "index.html"), "utf8")].join("\n");

const enDict = en as Record<string, string | undefined>;
const teDict = te as Record<string, string | undefined>;
const KEYS = Object.keys(en);

/**
 * Key families the app builds at runtime, recovered from the template literals
 * in `src/` rather than listed here — a hand-kept list of exceptions is the
 * thing that rots. `` `praise.${tone}.${ordinal}` `` becomes
 * `^praise\.[^.]+\.[^.]+$`, which is exactly the family that lookup can reach.
 *
 * A template that begins with a placeholder, or has no literal text in it at
 * all, is ignored: it would match everything and this test would stop meaning
 * anything.
 */
function dynamicPatterns(): RegExp[] {
  const out: RegExp[] = [];
  for (const match of BLOB.matchAll(/`([^`\n]*\$\{[^`\n]*)`/g)) {
    const raw = match[1] ?? "";
    if (raw.startsWith("${") || !raw.includes(".")) continue;
    const literal = raw.split(/\$\{[^}]*\}/g);
    if (literal.every((part) => part === "")) continue;
    out.push(new RegExp(`^${literal.map((p) => escapeRe(p)).join("[^.]+")}$`));
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATTERNS = dynamicPatterns();

/** Is this key written down anywhere in the app, in any quoting style? */
function literallyReferenced(key: string): boolean {
  return BLOB.includes(`"${key}"`) || BLOB.includes(`'${key}'`) || BLOB.includes(`\`${key}\``);
}

function referenced(key: string): boolean {
  return literallyReferenced(key) || PATTERNS.some((re) => re.test(key));
}

/* -------------------------------------------------------------------------- */
/* 1. the two dictionaries are one dictionary                                  */
/* -------------------------------------------------------------------------- */

const TELUGU = /[ఀ-౿]/;

describe("both dictionaries carry the same app", () => {
  it("has exactly the same keys on both sides", () => {
    const missingTe = KEYS.filter((k) => teDict[k] === undefined);
    const extraTe = Object.keys(te).filter((k) => enDict[k] === undefined);
    expect(missingTe, `missing from te.json: ${missingTe.join(", ")}`).toEqual([]);
    expect(extraTe, `in te.json but not en.json: ${extraTe.join(", ")}`).toEqual([]);
  });

  it("is really written in Telugu, not English pasted twice", () => {
    for (const key of KEYS) {
      const e = (enDict[key] ?? "").trim();
      const t = (teDict[key] ?? "").trim();
      expect(e, `${key} is empty in en.json`).not.toBe("");
      expect(t, `${key} is empty in te.json`).not.toBe("");
      expect(t, `${key} in te.json is not Telugu script`).toMatch(TELUGU);
      expect(e, `${key} in en.json contains Telugu script`).not.toMatch(TELUGU);
      expect(t, `${key} is the same string in both languages`).not.toBe(e);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2 & 3. nothing dead, nothing missing                                        */
/* -------------------------------------------------------------------------- */

describe("every line of copy can actually be said", () => {
  it("has no key that nothing in src/ reaches", () => {
    // If this fails you have two honest options and one dishonest one. Wire the
    // key up, or delete it. Do not add it to an ignore list.
    const dead = KEYS.filter((key) => !referenced(key));
    expect(dead, `dictionary keys nothing references: ${dead.join(", ")}`).toEqual([]);
  });

  it("has no reference in src/ to a key the dictionaries do not carry", () => {
    // The typed call sites (`t`, `Bilingual`, `promptKey`…) are already checked
    // by the compiler, because I18nKey is `keyof typeof en`. This catches the
    // ones that are not typed: the `copyKey`/`optionalCopyKey` strings, which
    // exist precisely so a key can be looked up before it has been written.
    const looked = new Set<string>();
    for (const match of BLOB.matchAll(/(?:optionalCopyKey|copyKey)\(\s*"([^"$]+)"/g)) {
      const key = match[1];
      if (key !== undefined) looked.add(key);
    }
    const missing = [...looked].filter((k) => enDict[k] === undefined || teDict[k] === undefined);
    expect(missing, `looked up but not in both dictionaries: ${missing.join(", ")}`).toEqual([]);
  });

  it("finds the key families the app builds at runtime", () => {
    // A guard on the guard: if the template scan silently stopped working,
    // every dynamic family would look dead and the test above would fail
    // loudly — but if it started matching everything, this one fails instead.
    expect(PATTERNS.length).toBeGreaterThan(0);
    expect(PATTERNS.some((re) => re.test("praise.effort.one"))).toBe(true);
    expect(PATTERNS.every((re) => !re.test("welcome.greeting"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. nothing built and left unmounted                                         */
/* -------------------------------------------------------------------------- */

describe("every component is on screen somewhere", () => {
  it("renders every exported component from src/components", () => {
    const declared: Array<{ name: string; file: string }> = [];
    for (const [file, text] of SOURCE) {
      if (!file.startsWith("src/components/")) continue;
      for (const m of text.matchAll(/export\s+function\s+([A-Z][A-Za-z0-9]*)\s*\(/g)) {
        if (m[1] !== undefined) declared.push({ name: m[1], file });
      }
      for (const m of text.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*=\s*forwardRef/g)) {
        if (m[1] !== undefined) declared.push({ name: m[1], file });
      }
    }
    expect(declared.length).toBeGreaterThan(8);

    const unmounted = declared.filter(({ name, file }) =>
      [...SOURCE].every(([other, text]) => other === file || !text.includes(`<${name}`)),
    );
    expect(
      unmounted.map((c) => `${c.name} (${c.file})`),
      "components nobody renders",
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the praise buckets, by hand                                              */
/* -------------------------------------------------------------------------- */

describe("praise is chosen by effort, and the buckets are real", () => {
  it("resolves three DIFFERENT families of copy", () => {
    // The bug this file exists for. A key-coverage test cannot see it: the
    // template `praise.${tone}.${n}` matches the dictionary either way, and
    // the fallback is a valid list of real lines. Only asking the surface what
    // it would actually say catches a bucket that quietly resolved to nothing.
    const { light, warm, effort } = PRAISE_BUCKETS;
    for (const [tone, bucket] of Object.entries({ light, warm, effort })) {
      expect(bucket.length, `${tone} bucket is empty`).toBeGreaterThanOrEqual(3);
      for (const key of bucket) {
        expect(key.startsWith(`praise.${tone}.`), `${key} is not in the ${tone} bucket`).toBe(true);
      }
    }
    expect(new Set([...light, ...warm, ...effort]).size).toBe(
      light.length + warm.length + effort.length,
    );
  });

  it("keeps the generic cheers as the fallback, so a bucket can never be mute", () => {
    // The degradation is still required: a tone the dictionary does not carry
    // must leave Chiku plainer, never silent. Those three lines are therefore
    // still referenced from the surface, and the key-coverage test above is
    // what proves it — delete the fallback and they go dead.
    for (const key of ["praise.one", "praise.two", "praise.three"]) {
      expect(enDict[key], key).toBeTypeOf("string");
      expect(BLOB.includes(`"${key}"`), `${key} is no longer the fallback`).toBe(true);
    }
  });

  it("names the effort and never the child", () => {
    const person = /\bclever\b|\bsmart\b|\bgenius\b|\bbright\b|good (girl|boy)|\btalented\b/i;
    for (const key of PRAISE_BUCKETS.effort) {
      expect(enDict[key] ?? "", `${key} praises the child, not the effort`).not.toMatch(person);
    }
  });
});
