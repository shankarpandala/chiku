/**
 * Dev media generator — pre-rendered te+en audio + naive viseme marks for ep001.
 *
 * Run as `corepack pnpm exec tsx scripts/gen-dev-media.ts`.
 *
 * DEV FIXTURES ONLY. Audio is synthesized with the macOS `say` voices
 * Geeta (te_IN) and Aman (en_IN) and AAC-encoded with `afconvert` — a
 * stand-in for the real Voice providers (D4: chatterbox-telugu / GCloud TTS).
 * The Telugu lines are kid-facing copy written by a non-native speaker and
 * MUST be reviewed by a native Telugu speaker before any family testing.
 *
 * Outputs (all idempotent — every run overwrites):
 *   content/episodes/ep001/media/<base>_<lang>.m4a         (every line)
 *   content/episodes/ep001/media/<base>_<lang>.marks.json  (ask lines only)
 *
 * Marks are naive: one viseme per word from its dominant vowel, distributed
 * evenly across the measured clip duration, closing at ~95%. Real marks come
 * later from forced alignment / the Voice provider; the rig's amplitude
 * fallback covers anything without marks (§6).
 *
 * The script ends by asserting content/episodes/ep001/episode.json (parsed
 * with the real zod schema) references exactly the files generated here —
 * ask/praise audio, per-language marks, and onMiss refs resolved per-lang.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EpisodeSchema,
  VisemeMarkSchema,
  type Lang,
  type Viseme,
  type VisemeMark,
} from "../packages/schema/src/index";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EPISODE_DIR = join(ROOT, "content", "episodes", "ep001");
const MEDIA_DIR = join(EPISODE_DIR, "media");
const EPISODE_JSON = join(EPISODE_DIR, "episode.json");

const VOICES: Record<Lang, string> = {
  te: "Geeta", // te_IN
  en: "Aman", // en_IN
};

// ---------------------------------------------------------------------------
// Line inventory. `base` is the filename base: <base>_<lang>.m4a.
// Ask lines additionally get <base>_<lang>.marks.json.
// ---------------------------------------------------------------------------

interface Line {
  readonly base: string;
  readonly kind: "ask" | "praise" | "retry" | "fallback";
  readonly text: Readonly<Record<Lang, string>>;
}

const LINES: readonly Line[] = [
  // cp1 — green (leaf)
  {
    base: "cp1_ask",
    kind: "ask",
    text: { te: "ఇది ఏ రంగు?", en: "What colour is this?" },
  },
  {
    base: "cp1_praise_green",
    kind: "praise",
    text: { te: "అవును! పచ్చ! భలే!", en: "Yes! Green! Well done!" },
  },
  {
    base: "cp1_praise_leaf",
    kind: "praise",
    text: {
      te: "అవును, ఆకు! ఆకు పచ్చగా ఉంటుంది! భలే!",
      en: "Yes, a leaf! The leaf is green! Super!",
    },
  },
  {
    base: "cp1_retry",
    kind: "retry",
    text: {
      te: "ఇది పచ్చ రంగు! చెప్పు — పచ్చ! ఇది ఏ రంగు?",
      en: "Pach-cha means green! What colour is this?",
    },
  },

  // cp2 — three
  {
    base: "cp2_ask",
    kind: "ask",
    text: { te: "ఎన్ని ఉన్నాయి? లెక్కపెడదాం!", en: "How many are there? Let's count!" },
  },
  {
    base: "cp2_praise_three",
    kind: "praise",
    text: {
      te: "అవును! మూడు! ఒకటి, రెండు, మూడు! భలే!",
      en: "Yes! Three! One, two, three! Well done!",
    },
  },
  {
    base: "cp2_retry",
    kind: "retry",
    text: {
      te: "ఒకటి, రెండు, మూడు — మూడు! ఎన్ని ఉన్నాయి?",
      en: "One, two, three — moodu means three! How many are there?",
    },
  },

  // cp3 — red (tomato)
  {
    base: "cp3_ask",
    kind: "ask",
    text: { te: "మరి ఇది ఏ రంగు?", en: "And this one? What colour is this?" },
  },
  {
    base: "cp3_praise_red",
    kind: "praise",
    text: { te: "అవును! ఎరుపు! భలే!", en: "Yes! Red! Well done!" },
  },
  {
    base: "cp3_praise_tomato",
    kind: "praise",
    text: {
      te: "అవును, టమాటా! టమాటా ఎర్రగా ఉంటుంది! భలే!",
      en: "Yes, a tomato! The tomato is red! Super!",
    },
  },
  {
    base: "cp3_retry",
    kind: "retry",
    text: {
      te: "ఇది ఎరుపు రంగు! చెప్పు — ఎరుపు! ఇది ఏ రంగు?",
      en: "Erupu means red! What colour is this?",
    },
  },

  // cp4 — yellow (banana)
  {
    base: "cp4_ask",
    kind: "ask",
    text: { te: "చూడు! ఇది ఏ రంగు?", en: "Look! What colour is this?" },
  },
  {
    base: "cp4_praise_yellow",
    kind: "praise",
    text: { te: "అవును! పసుపు! భలే!", en: "Yes! Yellow! Well done!" },
  },
  {
    base: "cp4_praise_banana",
    kind: "praise",
    text: {
      te: "అవును, అరటిపండు! అరటిపండు పసుపు రంగు! భలే!",
      en: "Yes, a banana! The banana is yellow! Super!",
    },
  },
  {
    base: "cp4_retry",
    kind: "retry",
    text: {
      te: "ఇది పసుపు రంగు! చెప్పు — పసుపు! ఇది ఏ రంగు?",
      en: "Pasupu means yellow! What colour is this?",
    },
  },

  // fallbacks (never dead-air, never blame the child — §8.5). Each models the
  // checkpoint's own answer, so colour checkpoints get their own line.
  {
    base: "lets_say_together",
    kind: "fallback",
    text: {
      te: "మనం కలిసి చెబుదాం — పచ్చ!",
      en: "Let's say it together — pach-cha! Green!",
    },
  },
  {
    base: "lets_count_together",
    kind: "fallback",
    text: {
      te: "మనం కలిసి లెక్కపెడదాం — ఒకటి, రెండు, మూడు!",
      en: "Let's count together — one, two, three!",
    },
  },
  {
    base: "cp3_together",
    kind: "fallback",
    text: {
      te: "మనం కలిసి చెబుదాం — ఎరుపు!",
      en: "Let's say it together — erupu! Red!",
    },
  },
  {
    base: "cp4_together",
    kind: "fallback",
    text: {
      te: "మనం కలిసి చెబుదాం — పసుపు!",
      en: "Let's say it together — pasupu! Yellow!",
    },
  },
];

const LANGS: readonly Lang[] = ["te", "en"];

// ---------------------------------------------------------------------------
// Naive viseme assignment (word → dominant vowel → viseme)
// ---------------------------------------------------------------------------

const TELUGU_CHAR = /[ఀ-౿]/;

/** Telugu vowel signs (matras) + base అ → viseme buckets. Fallback A. */
const TELUGU_VOWEL_MAP: Readonly<Record<string, Viseme>> = {
  "ా": "A", // ా
  "ి": "E", // ి
  "ీ": "E", // ీ
  "ె": "E", // ె
  "ే": "E", // ే
  "ొ": "O", // ొ
  "ో": "O", // ో
  "ు": "U", // ు
  "ూ": "U", // ూ
  "అ": "A", // అ
};

const LATIN_VOWEL_MAP: Readonly<Record<string, Viseme>> = {
  a: "A",
  e: "E",
  i: "E",
  o: "O",
  u: "U",
};

const VOWEL_VISEMES: readonly Viseme[] = ["A", "E", "O", "U"];

export function visemeForWord(word: string): Viseme {
  const counts: Record<string, number> = { A: 0, E: 0, O: 0, U: 0 };
  const map = TELUGU_CHAR.test(word) ? TELUGU_VOWEL_MAP : LATIN_VOWEL_MAP;
  for (const ch of word.toLowerCase()) {
    const v = map[ch];
    if (v !== undefined) counts[v] = (counts[v] ?? 0) + 1;
  }
  let best: Viseme | undefined;
  let bestCount = 0;
  for (const v of VOWEL_VISEMES) {
    const c = counts[v] ?? 0;
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  if (best !== undefined) return best;
  // No vowel signal: consonant hints, then the default open mouth.
  const lower = word.toLowerCase();
  if (/[fv]/.test(lower)) return "F";
  if (/l/.test(lower)) return "L";
  return "A";
}

/** Split kid-facing copy into words, dropping punctuation (keeps Telugu matras). */
export function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, ""))
    .filter((w) => w.length > 0);
}

/** Evenly spread one mark per word across the clip; close at ~95% duration. */
export function naiveMarks(text: string, durationMs: number): VisemeMark[] {
  const words = splitWords(text);
  if (words.length === 0) throw new Error(`no words in line: ${JSON.stringify(text)}`);
  const endT = Math.max(1, Math.round(durationMs * 0.95));
  const marks: VisemeMark[] = words.map((word, i) => ({
    t: Math.round((i * endT) / words.length),
    viseme: visemeForWord(word),
  }));
  marks.push({ t: endT, viseme: "closed" });
  // Validate against the real contract before anything writes to disk.
  return marks.map((m) => VisemeMarkSchema.parse(m));
}

// ---------------------------------------------------------------------------
// Synthesis: say → aiff → afconvert → m4a; afinfo → duration
// ---------------------------------------------------------------------------

function synthesize(text: string, lang: Lang, m4aPath: string, tmpDir: string): void {
  const aiff = join(tmpDir, "line.aiff");
  rmSync(aiff, { force: true });
  execFileSync("say", ["-v", VOICES[lang], "-o", aiff, "--", text]);
  rmSync(m4aPath, { force: true }); // idempotent overwrite
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", aiff, m4aPath]);
  rmSync(aiff, { force: true });
}

function measureDurationMs(m4aPath: string): number {
  const out = execFileSync("afinfo", [m4aPath], { encoding: "utf8" });
  const match = out.match(/estimated duration:\s*([\d.]+)\s*sec/);
  if (!match || match[1] === undefined) {
    throw new Error(`afinfo gave no estimated duration for ${m4aPath}`);
  }
  const ms = Math.round(Number.parseFloat(match[1]) * 1000);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`bad duration ${match[1]} for ${m4aPath}`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// episode.json consistency check
// ---------------------------------------------------------------------------

function assertEpisodeRefs(generated: ReadonlySet<string>): void {
  const episode = EpisodeSchema.parse(JSON.parse(readFileSync(EPISODE_JSON, "utf8")));
  const missing: string[] = [];
  const need = (file: string, where: string): void => {
    if (!generated.has(file)) missing.push(`${where} → ${file}`);
  };
  for (const seg of episode.segments) {
    if (seg.type !== "checkpoint") continue;
    for (const lang of LANGS) {
      need(seg.ask.audio[lang], `${seg.id}.ask.audio.${lang}`);
      if (seg.ask.marks) need(seg.ask.marks[lang], `${seg.id}.ask.marks.${lang}`);
      need(`${seg.onMiss.retryAudio}_${lang}.m4a`, `${seg.id}.onMiss.retryAudio (${lang})`);
      need(`${seg.onMiss.fallbackAudio}_${lang}.m4a`, `${seg.id}.onMiss.fallbackAudio (${lang})`);
      for (const ans of seg.expect) {
        need(ans.praise.audio[lang], `${seg.id}.expect.${ans.id}.praise.${lang}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`episode.json references files this run did not generate:\n  ${missing.join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Row {
  readonly file: string;
  readonly durationMs: number;
  readonly bytes: number;
  readonly marks: number | null;
}

function main(): void {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const tmpDir = mkdtempSync(join(tmpdir(), "chiku-gen-media-"));
  const rows: Row[] = [];
  const generated = new Set<string>();

  try {
    for (const line of LINES) {
      for (const lang of LANGS) {
        const audioFile = `${line.base}_${lang}.m4a`;
        const m4aPath = join(MEDIA_DIR, audioFile);
        synthesize(line.text[lang], lang, m4aPath, tmpDir);
        const durationMs = measureDurationMs(m4aPath);
        const bytes = statSync(m4aPath).size;
        generated.add(audioFile);

        let markCount: number | null = null;
        if (line.kind === "ask") {
          const marks = naiveMarks(line.text[lang], durationMs);
          if (marks.length < 3) {
            throw new Error(`suspiciously few marks (${marks.length}) for ${audioFile}`);
          }
          const marksFile = `${line.base}_${lang}.marks.json`;
          writeFileSync(join(MEDIA_DIR, marksFile), `${JSON.stringify(marks, null, 2)}\n`);
          generated.add(marksFile);
          markCount = marks.length;
        }
        rows.push({ file: audioFile, durationMs, bytes, marks: markCount });
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  assertEpisodeRefs(generated);

  const w = Math.max(...rows.map((r) => r.file.length));
  console.log(`\n${"file".padEnd(w)}  ${"dur".padStart(7)}  ${"size".padStart(8)}  marks`);
  for (const r of rows) {
    const marks = r.marks === null ? "—" : String(r.marks);
    console.log(
      `${r.file.padEnd(w)}  ${(r.durationMs / 1000).toFixed(2).padStart(6)}s  ${String(r.bytes).padStart(7)}B  ${marks}`,
    );
  }
  console.log(
    `\n✓ ${rows.length} audio files + ${rows.filter((r) => r.marks !== null).length} marks files → ${MEDIA_DIR}`,
  );
  console.log("✓ episode.json references resolve against generated media");
  console.log("⚠ dev fixtures: Telugu copy needs native-speaker review before family testing");
}

main();
