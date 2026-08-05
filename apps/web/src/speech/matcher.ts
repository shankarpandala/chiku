// Local answer matcher — step 3 of the §8 interaction loop. A hit here must
// stay well inside the ≤400ms utterance-end → praise budget, so everything is
// synchronous string work. Latin transliterations of Telugu answers are normal
// match entries, not a special case (§7).

export interface MatchCandidate {
  id: string;
  match: string[];
}

export interface MatchResult {
  id: string;
  score: number;
  /** Which match[] entry won (for logging/metrics — never transcripts). */
  matched: string;
}

/** §8: Dice coefficient ≥ 0.75 against match[]. */
export const MATCH_THRESHOLD = 0.75;

/**
 * Lowercase, strip punctuation, collapse whitespace. Unicode-aware so Telugu
 * script survives (\p{L}\p{M} keep letters + combining marks, \p{N} digits).
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice similarity over character bigrams (0..1). */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0; // no bigrams — only exact matches count
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, na] of ga) {
    const nb = gb.get(g);
    if (nb !== undefined) overlap += Math.min(na, nb);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * Best candidate for an utterance, or null below threshold. A child answers in
 * sentences ("it's green!"), so each whitespace token is scored as well as the
 * whole utterance, and the best score anywhere wins.
 */
export function matchUtterance(
  utterance: string,
  candidates: readonly MatchCandidate[],
  threshold: number = MATCH_THRESHOLD,
): MatchResult | null {
  const clean = normalize(utterance);
  if (clean.length === 0) return null;
  const probes = [clean, ...clean.split(" ")];

  let best: MatchResult | null = null;
  for (const candidate of candidates) {
    for (const raw of candidate.match) {
      const target = normalize(raw);
      if (target.length === 0) continue;
      for (const probe of probes) {
        const score = diceCoefficient(probe, target);
        if (score >= threshold && (best === null || score > best.score)) {
          best = { id: candidate.id, score, matched: raw };
        }
      }
    }
  }
  return best;
}
