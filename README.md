# Chiku

**The show that hears you.** An interactive show for children aged 3–8 (India-first,
Telugu + Indian English): Chiku the elephant calf plays authored episodes that pause at
checkpoints where he asks a question, genuinely listens, and responds. North-star
metric: talk time, not watch time.

Monorepo (pnpm). See `docs/chiku-architecture.md` for the architecture handoff and
`CLAUDE.md` for the working agreement.

| Path | What |
| --- | --- |
| `apps/live` | **Chiku Live** — the realtime surface: Chiku sees you and you answer with your body (camera never leaves the device) |
| `apps/web` | The episode player — authored episodes, checkpoints, TV stage + phone mic (tag `v0.1-episodes`) |
| `apps/prototype` | The v0.1 design prototype (frozen reference; `pnpm dev:prototype`) |
| `packages/schema` | zod contracts — Episode, RoomState, API IO |
| `packages/rig` | Framework-agnostic character rig (state machine, visemes, blink) |
| `packages/tokens` | Generated design tokens + self-hosted fonts |
| `services/api` | Hono API — `/understand`, `/speak`, `/episodes` (keys live only here) |
| `content/episodes` | Episode data |
| `design/` | Claude Design exports (canonical, never hand-edited) |

## Run it

```sh
corepack pnpm install
corepack pnpm ingest      # design/ -> packages/tokens/generated/
corepack pnpm dev         # episode player on :5173
corepack pnpm dev:live    # Chiku Live on :5175 (first run: pnpm --filter @chiku/live vendor:vision)
```

Quality gate: `corepack pnpm typecheck && corepack pnpm test`.
