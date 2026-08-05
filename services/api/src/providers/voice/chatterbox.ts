import type { SpeakRequest, SpeakResponse } from "@chiku/schema";
import type { Voice } from "./types";

/**
 * chatterbox-telugu, self-hosted on the M5 Pro over Tailscale (D4).
 * Reached via CHATTERBOX_URL (§13). Stub until M2.
 */
export class ChatterboxVoice implements Voice {
  speak(_req: SpeakRequest): Promise<SpeakResponse> {
    throw new Error(
      "ChatterboxVoice: not implemented until M2 — see docs/chiku-architecture.md §7",
    );
  }
}
