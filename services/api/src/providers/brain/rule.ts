import type { UnderstandRequest, UnderstandResponse } from "@chiku/schema";
import { loadEpisode } from "../../episodes";
import type { Brain } from "./types";

/**
 * Deterministic dev brain — the local stand-in behind the same Brain doorway
 * as Gemini (D3). DEV ONLY: selected when no GEMINI_API_KEY is configured, so
 * development never routes anything to a free-tier endpoint (§9.6).
 *
 * It may do exactly what the §7 prompt contract allows: map the utterance to
 * an expectId (praise), offer a short in-character retry, or redirect
 * off-limits topics back to the activity.
 */
export class RuleBrain implements Brain {
  constructor(private readonly mediaDir: string) {}

  async understand(req: UnderstandRequest): Promise<UnderstandResponse> {
    const utterance = normalize(req.utterance);

    if (OFF_LIMITS.some((p) => p.test(utterance))) {
      return {
        matchId: null,
        action: "redirect",
        reply: { text: "Let's get back to our game! Look with me!" },
      };
    }

    const episode = await loadEpisode(this.mediaDir, req.episodeId);
    const cp = episode?.segments.find((s) => s.type === "checkpoint" && s.id === req.checkpointId);
    if (episode === null || cp === undefined || cp.type !== "checkpoint") {
      throw new Error(`RuleBrain: unknown checkpoint ${req.episodeId}/${req.checkpointId}`);
    }

    const probes = [utterance, ...utterance.split(" ")];
    for (const expect of cp.expect) {
      if (!req.expectIds.includes(expect.id)) continue;
      const targets = [...expect.match, ...(SYNONYMS[expect.id] ?? [])].map(normalize);
      for (const target of targets) {
        for (const probe of probes) {
          if (dice(probe, target) >= 0.7) {
            return { matchId: expect.id, action: "praise" };
          }
        }
      }
    }

    const first = req.expectIds[0] ?? "the answer";
    return {
      matchId: null,
      action: "retry",
      reply: { text: `Good try! Is it ${first}? Say it with me!` },
    };
  }
}

/** A slightly wider net than the client matcher — that's the brain's job. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  green: ["emerald", "leaf colour", "leaf color", "grass colour", "hari", "hara rang"],
  leaf: ["leaves", "aku", "leaf"],
  three: ["3", "moodu", "mudu", "muudu", "teen", "moddu"],
  red: ["erra", "erupu", "yerupu", "lal", "laal", "scarlet"],
  tomato: ["tamota", "tamatar", "thakkali"],
  yellow: ["pasupu", "peela", "haldi", "banana colour", "banana color"],
  banana: ["arati", "aratipandu", "kela"],
};

/** Personal / off-activity probes → warm redirect, never engagement (§7). */
const OFF_LIMITS: readonly RegExp[] = [
  /your name|my name is|what is your/,
  /where (do you|i) live|address|phone|school name/,
  /talk to me|be my friend|tell me a story|sing/,
  /mummy|daddy|amma|nanna/, // family probes get a warm redirect, not a chat
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, na] of ga) {
    const nb = gb.get(g);
    if (nb !== undefined) overlap += Math.min(na, nb);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}
