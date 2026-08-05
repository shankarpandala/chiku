// The M1 hardcoded checkpoint (milestone doc §12): green, from ep001 cp1.
// Audio is dev-fixture synthetic speech (macOS `say`, en_IN voice) per §9.6 —
// real episode media (te + en, pre-rendered) lands in M2 under content/.
//
// The ask line carries hand-authored marks (audio-clock path); praise has
// none on purpose, exercising the WebAudio amplitude fallback in the browser.

import type { LoopCheckpoint } from "./machine";

export const CP1: LoopCheckpoint = {
  id: "cp1",
  listenMs: 6000,
  maxRetries: 1,
  expect: [
    {
      id: "green",
      // Latin transliterations of Telugu answers are normal members (§7).
      match: ["green", "paccha", "pachcha", "pacha", "పచ్చ", "ఆకుపచ్చ", "hara"],
    },
  ],
  lines: {
    ask: {
      url: "/audio/dev/cp1_ask_en.m4a", // "What colour is this?" ~1.05s
      marks: [
        { t: 0, viseme: "U" }, // Wh-
        { t: 140, viseme: "O" }, // -at
        { t: 300, viseme: "A" }, // co-
        { t: 450, viseme: "L" }, // -lour
        { t: 620, viseme: "E" }, // is
        { t: 780, viseme: "E" }, // this
        { t: 1000, viseme: "closed" },
      ],
    },
    praise: { url: "/audio/dev/cp1_praise_green_en.m4a" }, // amplitude-driven mouth
    retry: { url: "/audio/dev/cp1_retry_en.m4a" },
    together: { url: "/audio/dev/cp1_together_en.m4a" },
  },
};

/** The earned word shown while celebrating (design: te · transliteration · en). */
export const CP1_EARNED = { te: "పచ్చ", translit: "pach-cha", en: "green" };
