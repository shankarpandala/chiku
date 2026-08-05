import type { SpeakRequest, SpeakResponse } from "@chiku/schema";
import type { Voice } from "./types";

/**
 * Google Cloud TTS (free quota) for `en` voices (D4), keyed by
 * GCLOUD_TTS_KEY (§13). Stub until M2.
 */
export class GcloudVoice implements Voice {
  speak(_req: SpeakRequest): Promise<SpeakResponse> {
    throw new Error(
      "GcloudVoice: not implemented until M2 — see docs/chiku-architecture.md §7",
    );
  }
}
