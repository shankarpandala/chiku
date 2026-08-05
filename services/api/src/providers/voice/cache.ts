import type { SpeakRequest, SpeakResponse } from "@chiku/schema";
import type { Voice } from "./types";

/**
 * Cache-first Voice wrapper (D4): ~90% of speech is pre-rendered static
 * files; live TTS only for dynamic replies. Wraps a real Voice
 * (ChatterboxVoice for te, GcloudVoice for en) and consults the cache first.
 */
export class CachedVoice implements Voice {
  constructor(private readonly inner: Voice) {}

  async speak(req: SpeakRequest): Promise<SpeakResponse> {
    // TODO(M2): cache-first lookup — key = hash(text + voice) (§7), check
    // pre-rendered/cached audio under MEDIA_DIR and return
    // { audioUrl, marks } on hit (cached ≈ 0 ms, §8); on miss delegate to
    // this.inner.speak(req), persist the result, then return it.
    void this.inner;
    void req;
    throw new Error(
      "CachedVoice: not implemented until M2 — see docs/chiku-architecture.md §7",
    );
  }
}
