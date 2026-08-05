# Chiku — Architecture & Implementation Handoff (v0.1)

Companion to `chiku-design-brief.md` and the Claude Design exports. This document is written for Claude Code to execute. Read fully before writing code. Build milestone by milestone; stop for review after each.

> ## Amendments (v0.1.1, 2026-08-05 — ratified by SP)
>
> 1. **Local-first (supersedes D7/D8 for now).** No cloud deploy: no Firebase Hosting, no
>    VPS/Docker/Caddy. Everything runs on the developer machine. The API is still the only
>    place keys may live. Deployment returns to scope later, as a separate milestone.
> 2. **The Claude Design export is canon (supersedes §5's layer-id list).** The export
>    (`design/ChikuFace.dc.html`) is a templated component, not per-layer SVG files. The
>    binding contract is its prop API: visemes `closed A E O U F L smile` (not `UW`/`FV`);
>    emotes `idle listening happy encouraging goodbye thinking`. There is no `eyes/closed`
>    layer — blinking is an animation owned by the rig. Rig states `speaking`/`celebrate`
>    (§6) map to `encouraging` + viseme cycling and `happy` (~1.2 s) per the character sheet.
>    `scripts/ingest-design.ts` validates this contract with zero aliasing.
> 3. **No `tokens.json` exists in the export.** Ingest reads `design/_ds/*/ _ds_manifest.json`
>    + `styles.css` (grown-up tokens) and an explicit checked-in kid-palette config that is
>    *asserted* against the export for drift. Generated artifacts go to
>    `packages/tokens/generated/`, never into `design/`.
> 4. **Fonts are self-hosted** (Baloo 2, Baloo Tammudu 2, Archivo — OFL) — no Google Fonts
>    CDN at runtime, for privacy and offline.
> 5. **The v0.1 design prototype is kept at `apps/prototype`** (plain JS, excluded from
>    typecheck/test/CI) as a runnable interaction spec.
> 6. **M0 acceptance (adjusted):** monorepo + CI (typecheck+test), ingest passing against the
>    real exports, and a *local* dev server rendering the idle Chiku rig with design tokens.

> ## Amendment (v0.2, 2026-08-06 — vendor compliance, VERIFIED)
>
> **Gemini may not be used on any Chiku surface.** The Gemini API Additional Terms
> (effective 2026-03-23) state: *"You also will not use the Services as part of a
> website, application, or other service … that is directed towards or is likely to
> be accessed by individuals under the age of 18."* Chiku is for ages 3–8, so this
> is a terms violation, not a privacy trade-off. Use Restrictions further limit the
> API to *"professional or business purposes, not for consumer use."*
> Source: https://ai.google.dev/gemini-api/terms (verified 2026-08-06).
>
> Consequences:
> - **D3 is void.** The `Brain` interface stays; the Gemini implementation is gated
>   behind an explicit acknowledgement env and is defensible only for adult-operated
>   QA on synthetic input (`services/api/src/providers/brain/index.ts`).
> - **The §14 "Gemini free tier → Vertex" escape hatch does not obviously work** —
>   Vertex's own age clause was NOT independently confirmed. Verify before relying on it.
> - Any future hosted LLM must be from a vendor that permits minor-directed products
>   (OpenAI and Anthropic both publish guidance for serving minors) — with a paid,
>   zero-retention tier, or no hosted LLM at all.
> - **§9.8 (new invariant): no vendor may be introduced on a kid surface without a
>   written check of its terms for an under-18 clause.** Record the check in the PR.

## 1. What we're building (prototype scope)

A single responsive web PWA where an animated character (Chiku) plays authored episodes and short live "calls," pausing at checkpoints to genuinely listen to a child (ages 3–8, Telugu + Indian English) and respond. Three surfaces from one codebase: web, mobile PWA, and TV via a **Stage & Mic** pairing pattern (TV renders the character; a paired phone is the microphone and remote).

Non-goals for the prototype: accounts, payments, content CMS, native app store builds, open-ended chat.

## 2. Key decisions (ADR summary)

| # | Decision | Choice | Rationale / rejected alternative |
|---|----------|--------|----------------------------------|
| D1 | Speech-to-text | Browser Web Speech API on the phone/solo device | On-device-ish, free, zero raw audio leaves the client. Rejected cloud STT streaming (cost, privacy, latency). |
| D2 | Answer matching | Client-side fuzzy match first; LLM only on miss | <150 ms perceived response for known answers; protects free-tier request budget. |
| D3 | Brain | Gemini Flash / Flash-Lite via AI Studio free tier, called **only from the API service** | Key never ships to clients; provider behind a `Brain` interface so Vertex/self-hosted swap in later. |
| D4 | TTS | Cache-first: pre-rendered audio for all fixed lines; live TTS only for dynamic replies via `Voice` interface (chatterbox-telugu for `te`, Google Cloud TTS free quota for `en`) | ~90% of speech becomes static files; Telugu voice is self-hosted on the M5 Pro (Tailscale), cost ₹0. |
| D5 | Avatar | Layered SVG rig animated client-side (state machine + viseme scheduler) | No video streaming cost; works at TV and phone sizes; design exports map 1:1 to rig states. |
| D6 | Realtime sync (TV pairing) | Firebase Realtime Database (Spark plan) with anonymous auth | Managed low-latency websockets, free, `onDisconnect` cleanup. Rejected self-hosted WS for v0 (one less moving part). |
| D7 | API service | Hono (Node 20, TypeScript) — *amended: runs locally for now; Docker/VPS deferred* | Holds all secrets; also serves cached TTS + episode media. |
| D8 | Hosting | *Amended: local-first, no hosting for now* (was Firebase Hosting Spark) | — |
| D9 | Data hygiene | Transcripts only, session-scoped; no raw audio stored or transmitted; no analytics SDKs | DPDP/COPPA posture from day one; free-tier training clause means no real-child data in dev. |

## 3. System overview

```mermaid
flowchart LR
  subgraph Client surfaces (one PWA)
    SOLO[Phone/Web solo mode]
    TV[TV Stage - browser or Android TV WebView]
    MIC[Phone Mic and Remote]
  end
  RTDB[(Firebase RTDB - pairing rooms, session state)]
  API[Hono API - holds keys]
  BRAIN[Gemini Flash free tier]
  TTS[chatterbox-telugu on M5 Pro / Google Cloud TTS]
  MEDIA[static - episode video, pre-rendered and cached audio]
  MIC <--> RTDB
  TV <--> RTDB
  SOLO --> API
  MIC --> API
  API --> BRAIN
  API --> TTS
  TV --> MEDIA
  SOLO --> MEDIA
```

Solo mode = Stage and Mic collapsed onto one device; identical code paths, room of one.

## 4. Repository layout (pnpm monorepo)

```
chiku/
  apps/web/                 # Vite + React 18 + TS strict — all surfaces
    src/surfaces/           # home/ player/ call/ stage/ mic/ parent/
    src/rig/                # React bindings for packages/rig
    src/speech/             # Web Speech wrapper + fuzzy matcher
    src/session/            # RTDB rooms, pairing, state machine
    src/i18n/               # te.json, en.json (all kid-facing strings)
  apps/prototype/           # frozen v0.1 design prototype (plain JS, excluded from CI)
  services/api/             # Hono — /understand /speak /episodes
    src/providers/brain/    # gemini.ts (now), vertex.ts (later)
    src/providers/voice/    # chatterbox.ts, gcloud.ts, cache.ts
  packages/schema/          # zod: Episode, RoomState, API contracts (single source of truth)
  packages/rig/             # framework-agnostic rig runtime (state machine, viseme scheduler)
  packages/tokens/          # GENERATED design tokens + self-hosted fonts
  content/episodes/ep001/   # episode.json, video segments, pre-rendered audio (te/en)
  design/                   # Claude Design exports (canonical, never hand-edited)
  scripts/ingest-design.ts  # design/ -> tokens.css; validate rig contract
  CLAUDE.md                 # working agreement (see §11)
```

## 5. Design-asset contract *(amended — see Amendments #2/#3)*

The rig consumes the Claude Design character export by its **prop API** (the export is a
templated component; there are no per-layer SVG ids). `scripts/ingest-design.ts` must
validate these exist and fail loudly if not:

```
visemes: closed A E O U F L smile        (mouth paths in the export's MOUTHS dictionary)
emotes:  idle listening happy encouraging goodbye thinking
extras:  ring bars showBody crop         (boolean/enum props)
trunks:  down wave lift
```

Grown-up tokens come from `design/_ds/*/_ds_manifest.json` + `styles.css`; the kid palette
from the checked-in ingest config, asserted against the export. Components never hardcode
colors/type; they consume tokens. Do not hand-edit files in `design/` — they are
regenerated from Claude Design.

## 6. Core runtime: the rig

`packages/rig` exposes:

```ts
type RigState = "idle" | "listening" | "speaking" | "celebrate" | "goodbye";
rig.setState(s: RigState)
rig.speak(audioUrl: string, marks?: VisemeMark[])  // marks: [{t: ms, viseme: "A"|...}]
```

- With `marks`: schedule mouth layers on an audio-clock timeline.
- Without `marks`: WebAudio `AnalyserNode` amplitude → jaw-open interpolation (fallback).
- Blink scheduler: 3–6 s jitter, suppressed during `celebrate`.
- All states degrade to a static pose if animation is unavailable (TV browsers vary).

## 7. Data contracts (implement in `packages/schema` with zod)

**Episode**

```jsonc
{
  "id": "ep001", "title": {"te": "…", "en": "…"}, "langs": ["te", "en"],
  "segments": [
    { "type": "video", "src": "seg1.mp4" },
    { "type": "checkpoint", "id": "cp1",
      "ask": { "audio": {"te": "cp1_ask_te.mp3", "en": "cp1_ask_en.mp3"}, "marks": "cp1_marks.json" },
      "listenMs": 6000,
      "expect": [
        { "id": "green", "match": ["green", "paccha", "pachcha", "hara"],
          "praise": { "audio": {"te": "praise2_te.mp3", "en": "praise2_en.mp3"} } }
      ],
      "onMiss": { "retryAudio": "cp1_retry", "maxRetries": 1, "fallbackAudio": "lets_say_together" },
      "escalate": true   // allowed to call /understand on miss
    }
  ]
}
```

Note the `match` arrays deliberately include **Latin transliterations of Telugu answers** — Web Speech `te-IN` support is inconsistent across devices, so `en-IN` recognition of transliterated Telugu words is the fallback path. Language handling must treat this as normal, not an edge case.

**RTDB room** (`rooms/{code}` — 4-char code; TV creates room and shows QR of `/mic#CODE`)

```jsonc
{
  "createdAt": 0,
  "stage": { "connected": true }, "mic": { "connected": true },
  "state": {
    "mode": "player" | "call", "episodeId": "ep001", "segIdx": 2,
    "phase": "playing" | "asking" | "listening" | "responding" | "celebrating",
    "lastUtterance": { "text": "", "conf": 0.0, "ts": 0 },
    "playAudio": { "url": "", "marks": "", "nonce": 0 }
  },
  "control": { "pause": false, "end": false, "volume": 0.8 }
}
```

Rules: mic device writes `lastUtterance` and `control`; stage owns `state.phase` transitions and plays `playAudio` when `nonce` changes; `onDisconnect` removes presence; rooms auto-expire (TTL cleanup on create of new rooms). Transcripts live only under the room and die with it unless the parent explicitly saves a session summary.

**API (Hono, CORS locked to app origin, per-session rate limits)**

```
POST /understand  { checkpointId, utterance, lang, expectIds[] }
               -> { matchId | null, reply?: { text }, action: "praise" | "retry" | "redirect" }
POST /speak       { text, lang, voice } -> { audioUrl, marks: VisemeMark[] }   // cache-first (hash of text+voice)
GET  /episodes    -> Episode index        GET /media/*  -> static video + audio
```

`/understand` prompt contract: Gemini Flash-Lite, JSON output, temperature 0. It may ONLY (a) map the utterance to one of `expectIds`, (b) return a short in-character retry line, or (c) return `redirect` for anything off-limits (the character warmly steers back to the activity — never engages). It never free-chats, never asks personal questions. Keep the system prompt in one reviewed file: `services/api/src/prompts/understand.ts`.

## 8. The interaction loop (latency budget)

1. Checkpoint reached → stage plays `ask` audio + visemes → `phase: listening`, mic UI live.
2. Web Speech final result on mic device (~0–300 ms after utterance end).
3. Local fuzzy match (Dice coefficient ≥ 0.75 against `match[]`) — **hit ⇒ play pre-rendered praise. Target utterance-end → Chiku speaking: ≤ 400 ms.**
4. Miss + `escalate` ⇒ `POST /understand` (≤ 700 ms) → praise/retry line; dynamic text ⇒ `POST /speak` (cached ≈ 0; uncached ≤ 1.2 s). **Miss path target: ≤ 2 s.**
5. Silence past `listenMs` ⇒ one retry, then fallback ("let's say it together!") and continue. Never dead-air, never blame the child.
6. Every checkpoint logs `{responded, matchedLocally, conf, e2eMs}` to `metrics/` (aggregates only, no transcript).

## 9. Hard invariants (non-negotiable, enforce in code review)

1. No raw audio is stored or transmitted — ever. STT happens on-device; only text transits.
2. Model/API keys exist only in `services/api` env; the web app has zero secrets.
3. No third-party analytics/ads SDKs. Metrics go to our own RTDB path, aggregate-only.
4. Kid surfaces collect no PII; sessions are anonymous device sessions. Parent gate = local PIN (hold-to-enter), stored on device.
5. Hard session cap (default 20 min) enforced on both stage and mic; the sun-to-moon meter from the design is wired to it. Chiku ends sessions warmly (`goodbye` state) — no "stay longer" prompts anywhere.
6. Dev and CI never send real children's voice data to free-tier endpoints; test fixtures are adult/synthetic audio (see §10). Family testing routes through paid/self-hosted providers only.
7. All kid-facing strings live in `i18n/` (te + en) — none hardcoded.

## 10. Testing

- `packages/rig`: unit tests for viseme scheduling against fixture marks.
- Matcher: table-driven tests incl. transliteration variants and near-misses.
- Latency harness: scripted fake-STT events measuring step 3/4 budgets; fail CI if p50 targets slip.
- Fixtures: generate "child-ish" test audio by pitch-shifting TTS (dev only); never record real kids for fixtures.
- Playwright smoke: solo episode playthrough; two-context test for stage+mic pairing over RTDB emulator.
- Use Firebase emulators locally (`firebase emulators:start`) so dev needs no cloud project.

## 11. CLAUDE.md seed (created at repo root)

TypeScript strict everywhere; zod-validate every boundary (episode files, RTDB reads, API IO). No new dependencies without a one-line justification in the PR description. Vendor calls only via `Brain`/`Voice` interfaces. Never commit secrets; keep `.env.example` current. Don't edit `design/` by hand. Respect §9 invariants in every change. Run `pnpm typecheck && pnpm test` before declaring any milestone done, and stop after each milestone for human review.

## 12. Milestones (build order, with acceptance criteria)

**M0 — Scaffold** *(amended: local-first)*. Monorepo, CI (typecheck+test), `ingest-design.ts` passing against real exports. ✅ A local dev server renders the Chiku rig idling with design tokens applied.

**M1 — The loop (solo web).** Rig `speak()` with marks + amplitude fallback; Web Speech wrapper; local matcher; one hardcoded checkpoint. ✅ Ask "What color is this?", say "green" (and "paccha"), hear praise ≤ 400 ms; latency printed to console.

**M2 — Checkpoint engine + ep001.** Episode JSON interpreter; `content/episodes/ep001` with 4 checkpoints, pre-rendered te+en audio; `/understand` miss path live; parent view shows session transcript. ✅ Full episode playthrough with a retry and an escalation, on phone and desktop.

**M3 — Surfaces.** PWA manifest/install; TV stage layout with D-pad focus nav + QR pairing via RTDB (emulator locally); phone mic/remote with tap-answer chips; parent dashboard (summary, time-limit slider, language toggle); session cap wired. ✅ Episode driven on a TV browser with the phone as mic across a real network; Lighthouse PWA passes; pulling out of the room mid-episode recovers gracefully.

**Post-M3 (parking lot, do not build now):** deployment (hosting + API container), Android TV/Capacitor wrappers, Call-Chiku live mode via Gemini Live API, child-tuned ASR experiments, Vertex migration, episode CMS.

## 13. Environment

```
# services/api/.env.example
GEMINI_API_KEY=            # AI Studio free tier (dev only — see §9.6)
GCLOUD_TTS_KEY=            # optional, en voices
CHATTERBOX_URL=            # http://<tailscale-ip>:<port> on the M5 Pro
MEDIA_DIR=                 # local media directory
ALLOWED_ORIGIN=http://localhost:5173

# apps/web/.env.example
VITE_API_BASE=http://localhost:8787
```

## 14. What we'll revisit as this grows

Deployment (Firebase Hosting / VPS or alternatives); RTDB → self-hosted WS if room latency or Spark limits bite; Gemini free tier → Vertex (removes the training-data clause and rate caps); Web Speech → child-tuned Whisper fine-tune behind the same speech interface; static episode files → CMS; solo-mode Call feature once the checkpoint loop proves latency and safety.
