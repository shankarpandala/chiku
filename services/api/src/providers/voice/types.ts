import type { SpeakRequest, SpeakResponse } from "@chiku/schema";

/**
 * The only doorway to any TTS vendor (CLAUDE.md rule: vendor calls only via
 * the Brain/Voice interfaces). Implementations: chatterbox.ts (te,
 * self-hosted), gcloud.ts (en), cache.ts (cache-first wrapper) — see
 * docs/chiku-architecture.md D4 and §7.
 */
export interface Voice {
  speak(req: SpeakRequest): Promise<SpeakResponse>;
}
