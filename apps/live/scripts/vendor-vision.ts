/**
 * Vendor the MediaPipe runtime + models into public/vision/ so the app NEVER
 * hot-links a CDN (§9.3: no third-party calls from a kid surface, and the PWA
 * must work offline).
 *
 * Run: corepack pnpm --filter @chiku/live vendor:vision
 *
 * The WASM ships inside the npm package; only the .task model bundles have to
 * be downloaded, and only once — they are gitignored, so this script is part of
 * the setup path (see apps/live/README.md).
 *
 * NOTE (verified 2026-08-06): @mediapipe/tasks-vision embeds a telemetry client
 * that POSTs to https://odml.pa.googleapis.com/v1/log on a 60s interval and on
 * every task close. There is no opt-out flag. Input frames are NOT sent — Google
 * documents that inference is on-device — but the metrics beacon still violates
 * §9.3 on a kid surface. The app blocks it with `connect-src 'self'` in its CSP,
 * which the library tolerates (it swallows the error and stops its interval).
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat, copyFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const OUT = join(APP, "public", "vision");
const PKG = join(APP, "node_modules", "@mediapipe", "tasks-vision");

/** Model bundles, from Google's public model garden. Apache-2.0. */
const MODELS: ReadonlyArray<{ file: string; url: string; minBytes: number }> = [
  {
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    minBytes: 3_000_000,
  },
  {
    file: "gesture_recognizer.task",
    url: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    minBytes: 7_000_000,
  },
];

/** Runtime files copied out of the installed package (never fetched). */
const WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

async function exists(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await mkdir(join(OUT, "wasm"), { recursive: true });

  const pkgWasm = join(PKG, "wasm");
  const available = await readdir(pkgWasm).catch(() => [] as string[]);
  if (available.length === 0) {
    throw new Error(`MediaPipe wasm not found at ${pkgWasm} — run pnpm install first`);
  }
  for (const f of WASM_FILES) {
    if (!available.includes(f)) throw new Error(`expected ${f} in ${pkgWasm}`);
    await copyFile(join(pkgWasm, f), join(OUT, "wasm", f));
    console.log(`✓ wasm  ${f}`);
  }

  for (const m of MODELS) {
    const dest = join(OUT, m.file);
    const have = await exists(dest);
    if (have !== null && have >= m.minBytes) {
      console.log(`· model ${m.file} already present (${(have / 1e6).toFixed(1)} MB)`);
      continue;
    }
    console.log(`… fetching ${m.file}`);
    const res = await fetch(m.url);
    if (!res.ok || res.body === null) throw new Error(`${m.file}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    const size = await exists(dest);
    if (size === null || size < m.minBytes) {
      throw new Error(`${m.file}: got ${size ?? 0} bytes, expected >= ${m.minBytes}`);
    }
    console.log(`✓ model ${m.file} (${(size / 1e6).toFixed(1)} MB)`);
  }

  console.log("\n✓ vision assets vendored to apps/live/public/vision — no CDN at runtime");
}

main().catch((err: unknown) => {
  console.error("✗ vendor-vision failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
