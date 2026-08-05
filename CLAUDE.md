# Chiku — working agreement

Chiku is an interactive show for children (3–8, Telugu + Indian English): an animated
elephant calf plays authored episodes, pauses at checkpoints, genuinely listens, and
responds. The full spec is `docs/chiku-architecture.md` — read it before structural work.

## Rules (non-negotiable)

- TypeScript strict everywhere; zod-validate every boundary (episode files, RTDB reads, API IO).
- No new dependencies without a one-line justification in the PR description.
- Vendor calls only via the `Brain`/`Voice` interfaces in `services/api/src/providers/`.
- Never commit secrets; keep `.env.example` current. The web app has zero secrets —
  no `VITE_*` var may hold a key or token.
- Don't edit `design/` by hand — it holds Claude Design exports, regenerated upstream.
  Generated artifacts (tokens.css, fonts.css) live in `packages/tokens/generated/` and
  are produced by `pnpm ingest`.
- §9 invariants of the architecture doc bind every change: no raw audio stored or
  transmitted; no analytics SDKs; no PII on kid surfaces; hard session cap; all
  kid-facing strings in i18n (te + en); no real-child data to free-tier endpoints.
- Run `pnpm typecheck && pnpm test` before declaring any milestone done, and stop
  after each milestone for human review.

## Local dev on this machine

- `pnpm` is not on PATH (no sudo for the corepack symlink) — use `corepack pnpm <cmd>`.
  The version is pinned via `packageManager` in the root package.json.
- Local-first: there is no cloud deploy. Everything runs on this machine.
- `corepack pnpm install` at the root; `corepack pnpm dev` starts the web app,
  `corepack pnpm dev:api` the API, `corepack pnpm dev:prototype` the design prototype.

## Layout

- `apps/web` — the product PWA (all surfaces). TS strict.
- `apps/prototype` — the frozen design prototype (plain JS). Excluded from
  typecheck/test/CI; treat as a read-only interaction spec.
- `packages/schema` — zod contracts (Episode, RoomState, API IO). Single source of truth.
- `packages/rig` — framework-agnostic character rig runtime.
- `packages/tokens` — generated design tokens + self-hosted fonts (never hand-edit
  `generated/`).
- `services/api` — Hono API; the only place provider keys may exist.
- `content/episodes/` — episode data + media.
- `design/` — Claude Design exports (canonical; never hand-edit).
- `scripts/ingest-design.ts` — design/ → tokens/validation. Run as `pnpm ingest`.

## Design-contract ruling (2026-08-05)

The Claude Design export is canon. Visemes: `closed A E O U F L smile` (not UW/FV).
Emotes: `idle listening happy encouraging goodbye thinking`. There is no eyes/closed
layer — blinking is an animation the rig owns. Rig states `speaking`/`celebrate` map to
`encouraging`+viseme-cycling and `happy` (~1.2 s) per the character sheet.
