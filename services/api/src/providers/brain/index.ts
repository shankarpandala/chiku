import { GeminiBrain } from "./gemini";
import { RuleBrain } from "./rule";
import type { Brain } from "./types";

export type { Brain } from "./types";

/**
 * Pick the brain from the environment (D3):
 *   BRAIN=gemini | rule overrides; default gemini when a key exists, else the
 *   deterministic RuleBrain so dev never touches a vendor endpoint (§9.6).
 */
export function selectBrain(mediaDir: string, env: NodeJS.ProcessEnv = process.env): Brain {
  const choice = env["BRAIN"];
  const apiKey = env["GEMINI_API_KEY"];

  if (choice === "rule" || ((choice === undefined || choice === "") && (apiKey === undefined || apiKey === ""))) {
    console.warn("[chiku-api] RuleBrain selected (dev only — no vendor calls, no real-child data path)");
    return new RuleBrain(mediaDir);
  }
  if (apiKey === undefined || apiKey === "") {
    throw new Error("BRAIN=gemini requires GEMINI_API_KEY");
  }
  return new GeminiBrain({ apiKey });
}
