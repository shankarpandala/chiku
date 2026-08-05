import type { UnderstandRequest, UnderstandResponse } from "@chiku/schema";

/**
 * The only doorway to any LLM vendor (CLAUDE.md rule: vendor calls only via
 * the Brain/Voice interfaces). Implementations: gemini.ts (now, M2),
 * vertex.ts (later) — see docs/chiku-architecture.md §7 and D3.
 */
export interface Brain {
  understand(req: UnderstandRequest): Promise<UnderstandResponse>;
}
