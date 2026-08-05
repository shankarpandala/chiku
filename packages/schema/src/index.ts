/**
 * @chiku/schema — single source of truth for every data boundary.
 *
 * Implements §7 of docs/chiku-architecture.md (v0.1.1). Everything that
 * crosses a boundary — episode files on disk, RTDB room snapshots, API
 * request/response bodies — is validated with these schemas. The inferred
 * TS type is exported alongside every schema.
 *
 * Design-contract note (CLAUDE.md ruling, 2026-08-05): the viseme set is
 * `closed A E O U F L smile` — exactly the Claude Design export's MOUTHS
 * dictionary. No UW/FV aliases.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Language & localized primitives
// ---------------------------------------------------------------------------

export const LangSchema = z.enum(["te", "en"]);
export type Lang = z.infer<typeof LangSchema>;

/** Kid-facing text always ships in both languages — no optional halves. */
export const LocalizedTextSchema = z
  .object({
    te: z.string().min(1),
    en: z.string().min(1),
  })
  .strict();
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/** Pre-rendered audio always ships in both languages (D4: cache-first TTS). */
export const LocalizedAudioSchema = z
  .object({
    te: z.string().min(1),
    en: z.string().min(1),
  })
  .strict();
export type LocalizedAudio = z.infer<typeof LocalizedAudioSchema>;

// ---------------------------------------------------------------------------
// Rig: visemes & timing marks (§5/§6)
// ---------------------------------------------------------------------------

export const VisemeSchema = z.enum([
  "closed",
  "A",
  "E",
  "O",
  "U",
  "F",
  "L",
  "smile",
]);
export type Viseme = z.infer<typeof VisemeSchema>;

/** One mouth keyframe on the audio clock. `t` is milliseconds from audio start. */
export const VisemeMarkSchema = z
  .object({
    t: z.number().int().nonnegative(),
    viseme: VisemeSchema,
  })
  .strict();
export type VisemeMark = z.infer<typeof VisemeMarkSchema>;

// ---------------------------------------------------------------------------
// Episode content (§7 "Episode") — authored files, so schemas are .strict():
// a typo in hand-authored JSON must fail loudly, not be silently stripped.
// ---------------------------------------------------------------------------

export const VideoSegmentSchema = z
  .object({
    type: z.literal("video"),
    src: z.string().min(1),
  })
  .strict();
export type VideoSegment = z.infer<typeof VideoSegmentSchema>;

/**
 * One acceptable answer at a checkpoint.
 *
 * `match` deliberately mixes Telugu script and Latin transliterations of
 * Telugu answers ("paccha", "moodu"): Web Speech `te-IN` support is
 * inconsistent across devices, so `en-IN` recognition of transliterated
 * Telugu is a NORMAL path, not an edge case (§7 note).
 */
export const ExpectedAnswerSchema = z
  .object({
    id: z.string().min(1),
    match: z.array(z.string().min(1)).min(1),
    praise: z
      .object({
        audio: LocalizedAudioSchema,
      })
      .strict(),
  })
  .strict();
export type ExpectedAnswer = z.infer<typeof ExpectedAnswerSchema>;

export const CheckpointSegmentSchema = z
  .object({
    type: z.literal("checkpoint"),
    id: z.string().min(1),
    ask: z
      .object({
        audio: LocalizedAudioSchema,
        /** Viseme-marks file for the ask line (optional until rendered). */
        marks: z.string().min(1).optional(),
      })
      .strict(),
    /** How long the mic stays open before the retry path kicks in. */
    listenMs: z.number().int().positive(),
    expect: z.array(ExpectedAnswerSchema).min(1),
    onMiss: z
      .object({
        /** Audio line id, resolved per-lang at play time (e.g. cp1_retry → cp1_retry_te.mp3). */
        retryAudio: z.string().min(1),
        maxRetries: z.number().int().nonnegative(),
        /** "Let's say it together!" — never dead-air, never blame the child (§8.5). */
        fallbackAudio: z.string().min(1),
      })
      .strict(),
    /** Whether a local-match miss may call POST /understand (§8.4). */
    escalate: z.boolean(),
  })
  .strict();
export type CheckpointSegment = z.infer<typeof CheckpointSegmentSchema>;

export const SegmentSchema = z.discriminatedUnion("type", [
  VideoSegmentSchema,
  CheckpointSegmentSchema,
]);
export type Segment = z.infer<typeof SegmentSchema>;

export const EpisodeSchema = z
  .object({
    id: z.string().min(1),
    title: LocalizedTextSchema,
    langs: z.array(LangSchema).min(1),
    segments: z.array(SegmentSchema).min(1),
  })
  .strict();
export type Episode = z.infer<typeof EpisodeSchema>;

// ---------------------------------------------------------------------------
// RTDB room state (§7 "RTDB room" — rooms/{code})
// ---------------------------------------------------------------------------

export const RoomModeSchema = z.enum(["player", "call"]);
export type RoomMode = z.infer<typeof RoomModeSchema>;

export const RoomPhaseSchema = z.enum([
  "playing",
  "asking",
  "listening",
  "responding",
  "celebrating",
]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const PresenceSchema = z.object({
  connected: z.boolean(),
});
export type Presence = z.infer<typeof PresenceSchema>;

/** Written by the mic device only. `conf` is the Web Speech confidence [0,1]. */
export const LastUtteranceSchema = z.object({
  text: z.string(),
  conf: z.number().min(0).max(1),
  ts: z.number().int().nonnegative(),
});
export type LastUtterance = z.infer<typeof LastUtteranceSchema>;

/** Stage plays this when `nonce` changes. `marks` is a marks-file URL, "" when none. */
export const PlayAudioSchema = z.object({
  url: z.string(),
  marks: z.string(),
  nonce: z.number().int().nonnegative(),
});
export type PlayAudio = z.infer<typeof PlayAudioSchema>;

/**
 * rooms/{code}. RTDB reads are validated with this before use.
 * `stage`/`mic` are optional because `onDisconnect` removes the presence
 * node — a snapshot taken while a device is away legitimately lacks it.
 * Objects are non-strict (strip): tolerate additive RTDB keys from newer
 * writers instead of hard-failing older clients.
 */
export const RoomStateSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  stage: PresenceSchema.optional(),
  mic: PresenceSchema.optional(),
  state: z.object({
    mode: RoomModeSchema,
    episodeId: z.string().min(1),
    segIdx: z.number().int().nonnegative(),
    phase: RoomPhaseSchema,
    lastUtterance: LastUtteranceSchema,
    playAudio: PlayAudioSchema,
  }),
  control: z.object({
    pause: z.boolean(),
    end: z.boolean(),
    volume: z.number().min(0).max(1),
  }),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

// ---------------------------------------------------------------------------
// API IO (§7 "API") — Hono service contracts
// ---------------------------------------------------------------------------

export const UnderstandRequestSchema = z.object({
  checkpointId: z.string().min(1),
  utterance: z.string(),
  lang: LangSchema,
  expectIds: z.array(z.string().min(1)),
});
export type UnderstandRequest = z.infer<typeof UnderstandRequestSchema>;

/**
 * The brain may ONLY praise a mapped answer, offer an in-character retry,
 * or redirect off-limits topics back to the activity (§7 prompt contract).
 */
export const UnderstandActionSchema = z.enum(["praise", "retry", "redirect"]);
export type UnderstandAction = z.infer<typeof UnderstandActionSchema>;

export const UnderstandResponseSchema = z.object({
  /** One of the request's expectIds, or null when nothing matched. */
  matchId: z.string().nullable(),
  /** Short in-character line for retry/redirect (spoken via /speak). */
  reply: z.object({ text: z.string().min(1) }).optional(),
  action: UnderstandActionSchema,
});
export type UnderstandResponse = z.infer<typeof UnderstandResponseSchema>;

export const SpeakRequestSchema = z.object({
  text: z.string().min(1),
  lang: LangSchema,
  voice: z.string().min(1),
});
export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;

export const SpeakResponseSchema = z.object({
  audioUrl: z.string().min(1),
  marks: z.array(VisemeMarkSchema),
});
export type SpeakResponse = z.infer<typeof SpeakResponseSchema>;

/** GET /episodes — lightweight index, not the full episode payloads. */
export const EpisodeIndexEntrySchema = z.object({
  id: z.string().min(1),
  title: LocalizedTextSchema,
  langs: z.array(LangSchema).min(1),
});
export type EpisodeIndexEntry = z.infer<typeof EpisodeIndexEntrySchema>;

export const EpisodeIndexSchema = z.array(EpisodeIndexEntrySchema);
export type EpisodeIndex = z.infer<typeof EpisodeIndexSchema>;
