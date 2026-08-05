import { UnderstandResponseSchema, type UnderstandRequest, type UnderstandResponse } from "@chiku/schema";
import { UNDERSTAND_SYSTEM_PROMPT } from "../../prompts/understand";
import type { Brain } from "./types";

/**
 * Gemini Flash-Lite via the Generative Language REST API (D3). The key lives
 * only in this service's env (§9.2); JSON output, temperature 0 per §7.
 * §9.6 note: the AI Studio free tier is DEV ONLY — never real-child data.
 */
export interface GeminiBrainOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 1200; // §8: the whole miss path budget is ≤2s

export class GeminiBrain implements Brain {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiBrainOptions) {
    this.model = opts.model ?? process.env["GEMINI_MODEL"] ?? DEFAULT_MODEL;
    const envTimeout = Number(process.env["BRAIN_TIMEOUT_MS"]);
    this.timeoutMs =
      opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async understand(req: UnderstandRequest): Promise<UnderstandResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.opts.apiKey,
        },
        signal: ctl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: UNDERSTAND_SYSTEM_PROMPT }] },
          contents: [
            {
              role: "user",
              parts: [
                {
                  // Only what the contract needs — the utterance text, never
                  // any identifier of the child (there is none to send).
                  text: JSON.stringify({
                    checkpointId: req.checkpointId,
                    utterance: req.utterance,
                    lang: req.lang,
                    expectIds: req.expectIds,
                  }),
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text === undefined) throw new Error("gemini: empty candidate");
      return UnderstandResponseSchema.parse(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  }
}
