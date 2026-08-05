import { GeminiBrain } from "./gemini";
import { RuleBrain } from "./rule";
import type { Brain } from "./types";

export type { Brain } from "./types";

/**
 * ⚠️ COMPLIANCE GATE (verified 2026-08-06 against the live terms) ⚠️
 *
 * The Gemini API Additional Terms (effective 2026-03-23) say, verbatim:
 *
 *   "You also will not use the Services as part of a website, application, or
 *    other service (collectively, "API Clients") that is directed towards or is
 *    likely to be accessed by individuals under the age of 18."
 *   — https://ai.google.dev/gemini-api/terms  ("Age Requirements")
 *
 * and, under Use Restrictions:
 *
 *   "Use of Google AI Studio and Gemini API is for developers building with
 *    Google AI models for professional or business purposes, not for consumer use."
 *
 * Chiku is a show for children aged 3–8. It is definitionally "directed towards
 * individuals under the age of 18", so routing a kid surface through Gemini is
 * a terms violation — regardless of tier, and regardless of §9's privacy stance.
 * This supersedes decision D3 and the §14 "migrate to Vertex" escape hatch in
 * docs/chiku-architecture.md (Vertex's own age clause was NOT independently
 * confirmed; do not assume it differs without checking).
 *
 * The provider code is kept — the interface work is sound and a compliant vendor
 * drops in behind it — but it cannot be selected by accident. Turning it on
 * requires deliberately setting BRAIN=gemini AND acknowledging the restriction,
 * and even then it is only defensible for adult-operated QA on synthetic input.
 */
const ACK_ENV = "I_ACKNOWLEDGE_GEMINI_IS_NOT_FOR_UNDER_18_SURFACES";

export function selectBrain(mediaDir: string, env: NodeJS.ProcessEnv = process.env): Brain {
  const choice = env["BRAIN"];

  if (choice === "gemini") {
    if (env[ACK_ENV] !== "true") {
      throw new Error(
        "BRAIN=gemini is blocked: Google's Gemini API terms forbid use in services " +
          "directed at under-18s, and Chiku is for ages 3-8. See the comment in " +
          "services/api/src/providers/brain/index.ts. For adult-operated QA on " +
          `synthetic input only, set ${ACK_ENV}=true.`,
      );
    }
    const apiKey = env["GEMINI_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error("BRAIN=gemini requires GEMINI_API_KEY");
    }
    console.warn(
      "[chiku-api] ⚠️  GeminiBrain enabled with the under-18 acknowledgement set. " +
        "This must never serve a child. Synthetic/adult QA input only.",
    );
    return new GeminiBrain({ apiKey });
  }

  // Everything else — including a bare GEMINI_API_KEY in the environment, which
  // used to auto-select Gemini — lands here. The dev brain is deterministic,
  // local, and sends nothing anywhere.
  return new RuleBrain(mediaDir);
}
