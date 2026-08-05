import { describe, expect, it } from "vitest";
import { diceCoefficient, matchUtterance, normalize } from "../src/speech/matcher";

const CP1_EXPECT = [
  { id: "green", match: ["green", "paccha", "pachcha", "pacha", "పచ్చ", "ఆకుపచ్చ", "hara"] },
  { id: "leaf", match: ["leaf", "aaku", "ఆకు"] },
];

describe("normalize", () => {
  it("lowercases, strips punctuation, keeps Telugu script intact", () => {
    expect(normalize("  It's GREEN!! ")).toBe("its green");
    expect(normalize("పచ్చ!")).toBe("పచ్చ");
  });
});

describe("diceCoefficient", () => {
  it("is 1 for identical, 0 for disjoint", () => {
    expect(diceCoefficient("green", "green")).toBe(1);
    expect(diceCoefficient("green", "blue")).toBe(0);
  });

  it("single characters only match exactly (no bigrams)", () => {
    expect(diceCoefficient("3", "3")).toBe(1);
    expect(diceCoefficient("3", "three")).toBe(0);
  });
});

// §10: table-driven, incl. transliteration variants and near-misses.
describe("matchUtterance", () => {
  const hits: Array<[string, string]> = [
    ["green", "green"],
    ["GREEN!", "green"],
    ["it's green", "green"], // token match inside a sentence
    ["i think it is green", "green"],
    ["paccha", "green"], // Latin transliteration — normal path, not an edge case
    ["pachcha", "green"],
    ["pacha", "green"],
    ["పచ్చ", "green"], // Telugu script from te-IN recognition
    ["hara", "green"], // Hindi answer accepted by design
    ["aaku", "leaf"],
    ["greeen", "green"], // recognizer stutter, dice 0.86
  ];
  it.each(hits)("hit: %s → %s", (utterance, id) => {
    const result = matchUtterance(utterance, CP1_EXPECT);
    expect(result?.id).toBe(id);
    expect(result!.score).toBeGreaterThanOrEqual(0.75);
  });

  const misses: string[] = [
    "queen", // near-miss on bigrams (ee, en) — dice 0.5, below threshold
    "blue",
    "the sky", // wrong answer in a sentence
    "cream", // shares 'ea' only
    "", // silence
    "...", // punctuation only
  ];
  it.each(misses)("miss: %s", (utterance) => {
    expect(matchUtterance(utterance, CP1_EXPECT)).toBeNull();
  });

  it("prefers the best-scoring candidate across all match entries", () => {
    const r = matchUtterance("aaku paccha", CP1_EXPECT);
    // Both words hit different candidates at score 1; the first-found max wins —
    // assert it matched *something* with a perfect score and a stable shape.
    expect(r).not.toBeNull();
    expect(r!.score).toBe(1);
  });
});
