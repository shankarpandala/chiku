import type { UnderstandRequest, UnderstandResponse } from "@chiku/schema";
import type { Brain } from "./types";

/**
 * Gemini Flash-Lite brain (AI Studio free tier, dev only — §9.6).
 * Stub until M2: the /understand contract is wired, the brain is not.
 * When implemented it must use src/prompts/understand.ts (the single
 * reviewed prompt location), JSON output, temperature 0.
 */
export class GeminiBrain implements Brain {
  understand(_req: UnderstandRequest): Promise<UnderstandResponse> {
    throw new Error(
      "GeminiBrain: not implemented until M2 — see docs/chiku-architecture.md §7",
    );
  }
}
