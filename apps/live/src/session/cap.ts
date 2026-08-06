// The hard session cap (§9.5), for Chiku Live.
//
// apps/web already implements this invariant (apps/web/src/session/cap.ts).
// This is a deliberate PORT rather than a shared import: the two apps are
// separate builds on separate origins, they do not share a localStorage, and a
// cross-app import would couple the live surface to the episode player's
// lifecycle for the sake of forty lines.
//
// What §9.5 actually requires, and what this file is answerable for:
//   * a default of 20 minutes, adjustable by a GROWN-UP between 5 and 45;
//   * play time, not wall-clock time — a session that is backgrounded while a
//     parent takes a phone call must not burn the child's twenty minutes;
//   * when it is reached, the show ENDS. Warmly, via the goodbye phase, with
//     no "stay longer" button, no countdown pressure and nothing that reads as
//     a telling-off. A cap the child can argue with is not a cap.
//
// The limit is stored as a single integer. That is not PII and there is
// nothing else here to store.

const LIMIT_KEY = "chiku.live.limitMin";

export const DEFAULT_LIMIT_MIN = 20;
export const MIN_LIMIT_MIN = 5;
export const MAX_LIMIT_MIN = 45;
/** Grown-up adjustment granularity. Minutes, not seconds — this is not a dial. */
export const LIMIT_STEP_MIN = 5;

/** How often the surface re-reads the clock. Coarse on purpose: see SunArc. */
export const SESSION_TICK_MS = 5000;

export function clampLimit(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_LIMIT_MIN;
  return Math.min(MAX_LIMIT_MIN, Math.max(MIN_LIMIT_MIN, Math.round(min)));
}

export function getLimitMinutes(): number {
  try {
    const raw = window.localStorage.getItem(LIMIT_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(n) && n >= MIN_LIMIT_MIN && n <= MAX_LIMIT_MIN) return n;
  } catch {
    // Storage unavailable (private mode, blocked cookies) — the default stands.
    // Never throw here: a cap that fails open is the one failure mode §9.5
    // does not tolerate, and the default IS the cap.
  }
  return DEFAULT_LIMIT_MIN;
}

export function setLimitMinutes(min: number): void {
  const clamped = clampLimit(min);
  try {
    window.localStorage.setItem(LIMIT_KEY, String(clamped));
  } catch {
    // Not persisted; the in-memory value passed back to the caller still applies
    // for this session, and the default applies on the next one.
  }
}

/**
 * Cumulative PLAY time for one visit.
 *
 * An instance rather than module state (which is what apps/web uses) because
 * the live surface mounts and unmounts inside a test file dozens of times, and
 * a module-level `let` makes every one of those tests depend on the order of
 * the ones before it.
 *
 * `start()` is idempotent while running and resumes after `pause()`, so the
 * surface can call it on every prompt without thinking about it.
 */
export class SessionClock {
  readonly #now: () => number;
  /** Milliseconds banked from completed run segments. */
  #banked = 0;
  /** When the current run segment began, or null while paused. */
  #since: number | null = null;
  #everStarted = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Begin or resume counting. Safe to call repeatedly. */
  start(): void {
    if (this.#since !== null) return;
    this.#since = this.#now();
    this.#everStarted = true;
  }

  /** Stop counting without losing what has been counted. */
  pause(): void {
    if (this.#since === null) return;
    this.#banked += Math.max(0, this.#now() - this.#since);
    this.#since = null;
  }

  reset(): void {
    this.#banked = 0;
    this.#since = null;
    this.#everStarted = false;
  }

  get started(): boolean {
    return this.#everStarted;
  }

  get running(): boolean {
    return this.#since !== null;
  }

  elapsedMs(): number {
    const live = this.#since === null ? 0 : Math.max(0, this.#now() - this.#since);
    return this.#banked + live;
  }

  /** 0 → fresh, 1 → the cap has been reached. Drives the sun-to-moon arc. */
  progress(limitMin: number = getLimitMinutes()): number {
    const capMs = clampLimit(limitMin) * 60_000;
    if (capMs <= 0) return 1;
    return Math.min(1, this.elapsedMs() / capMs);
  }

  expired(limitMin: number = getLimitMinutes()): boolean {
    return this.progress(limitMin) >= 1;
  }

  remainingMs(limitMin: number = getLimitMinutes()): number {
    return Math.max(0, clampLimit(limitMin) * 60_000 - this.elapsedMs());
  }
}
