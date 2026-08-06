// Warm the vision runtime BEFORE the camera light comes on.
//
// THE PROBLEM THIS FIXES. `engine.start()` acquires getUserMedia and only then
// fetches the MediaPipe runtime and the two model bundles — around 23MB. On a
// mid-range Indian 4G connection that is a minute or more during which the
// camera light is ON, the preview is empty, and the only thing that changed on
// screen is a button label. The camera promise on the previous screen says
// "only while you play"; a minute of lit camera before the game starts makes
// that sentence a lie in exactly the way a parent can see.
//
// So: pull the bytes down first, with the camera dark, and ask for the camera
// only once they are here.
//
// HOW. The engine has no public warm-up hook, and this module is not allowed
// to grow one (vision/ belongs to another change). But `FilesetResolver` and
// `createFromOptions` fetch these URLs with the ordinary HTTP stack, so
// fetching them ourselves first puts them in the HTTP cache — and, once the
// service worker is installed, in its immutable model cache — and the engine's
// own fetch then resolves locally. The surface still feature-detects a real
// `engine.warm()` and prefers it if one ever lands.
//
// The paths are duplicated from vision/engine.ts rather than imported: the
// surface tests mock that module wholesale, and a mocked constant is
// `undefined`, which would silently warm nothing. `test/surface-reality.test.tsx`
// asserts the two lists agree against the REAL module via importActual.

/** Mirrors VISION_WASM_PATH / FACE_MODEL_PATH / HAND_MODEL_PATH in vision/engine.ts. */
export const VISION_WASM_PATH = "/vision/wasm";
export const FACE_MODEL_PATH = "/vision/face_landmarker.task";
export const HAND_MODEL_PATH = "/vision/gesture_recognizer.task";

/**
 * The SIMD build is ~11MB and the non-SIMD build another ~10.5MB. MediaPipe
 * loads exactly one of them, so warming both would double the wait on the
 * connection least able to afford it. We detect which one this browser will
 * pick and warm only that pair.
 */
export const SIMD_RUNTIME = [
  `${VISION_WASM_PATH}/vision_wasm_internal.js`,
  `${VISION_WASM_PATH}/vision_wasm_internal.wasm`,
] as const;

export const NOSIMD_RUNTIME = [
  `${VISION_WASM_PATH}/vision_wasm_nosimd_internal.js`,
  `${VISION_WASM_PATH}/vision_wasm_nosimd_internal.wasm`,
] as const;

export const MODEL_BUNDLES = [FACE_MODEL_PATH, HAND_MODEL_PATH] as const;

/**
 * The canonical 26-byte SIMD probe module: a function returning a v128. If the
 * engine cannot validate it, MediaPipe will fall back to the nosimd runtime.
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
  15, 253, 98, 11,
]);

export function hasWasmSimd(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** Everything the first `engine.start()` will need, and nothing it will not. */
export function visionAssets(simd: boolean = hasWasmSimd()): readonly string[] {
  return [...(simd ? SIMD_RUNTIME : NOSIMD_RUNTIME), ...MODEL_BUNDLES];
}

export interface WarmOptions {
  /** Test seam. Defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Abort the whole warm-up — the surface aborts on unmount. */
  readonly signal?: AbortSignal;
  /** Override the asset list (tests, and self-hosted layouts). */
  readonly assets?: readonly string[];
}

/**
 * Fetch every vision asset into the HTTP cache. Rejects if ANY of them fails,
 * because a half-warmed cache still means a lit camera and a stalled screen —
 * the caller's job is to show a retry, not to pretend.
 */
export async function warmVision(opts: WarmOptions = {}): Promise<void> {
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) throw new Error("no fetch on this platform");
  const assets = opts.assets ?? visionAssets();

  await Promise.all(
    assets.map(async (url) => {
      const init: RequestInit = opts.signal
        ? { cache: "force-cache", signal: opts.signal }
        : { cache: "force-cache" };
      const res = await doFetch(url, init);
      if (!res.ok) throw new Error(`warm-up failed: ${url} → ${res.status}`);
      // The body MUST be drained or the response never reaches the cache.
      // Blob over arrayBuffer: engines back large blobs with disk, and holding
      // 20MB of ArrayBuffer on a cheap Android is its own failure.
      if (typeof res.blob === "function") await res.blob();
      else if (typeof res.arrayBuffer === "function") await res.arrayBuffer();
    }),
  );
}
