import { describe, expect, it } from "vitest";
import { translate, type I18nKey } from "../src/i18n";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

describe("i18n", () => {
  it("covers every key in both languages", () => {
    expect(Object.keys(te).sort()).toEqual(Object.keys(en).sort());
  });

  it("translates per language", () => {
    expect(translate("en", "remote.holdToTalk")).toBe("Hold to talk");
    expect(translate("te", "remote.holdToTalk")).toBe("నొక్కి మాట్లాడు");
  });

  it("falls back to English for a hole in the te dictionary", () => {
    // The type system forbids holes; simulate a runtime one (e.g. stale build).
    const teDict = te as Record<string, string>;
    const key = "app.title" as I18nKey;
    const saved = teDict[key]!;
    delete teDict[key];
    try {
      expect(translate("te", key)).toBe(en[key]);
    } finally {
      teDict[key] = saved;
    }
  });
});
