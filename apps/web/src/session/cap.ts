// Hard session cap (§9.5): default 20 minutes, parent-adjustable 5–45. The
// limit is device-local (localStorage — no PII, just a number); the running
// session clock is in-memory. Both stage and solo player consult this and end
// warmly via the engine's SESSION_END. No "stay longer" prompts, anywhere.

const LIMIT_KEY = "chiku.limitMin";
export const DEFAULT_LIMIT_MIN = 20;
export const MIN_LIMIT_MIN = 5;
export const MAX_LIMIT_MIN = 45;

export function getLimitMinutes(): number {
  try {
    const raw = window.localStorage.getItem(LIMIT_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= MIN_LIMIT_MIN && n <= MAX_LIMIT_MIN) return n;
  } catch {
    // storage unavailable (private mode) — fall through to the default
  }
  return DEFAULT_LIMIT_MIN;
}

export function setLimitMinutes(min: number): void {
  const clamped = Math.min(MAX_LIMIT_MIN, Math.max(MIN_LIMIT_MIN, Math.round(min)));
  try {
    window.localStorage.setItem(LIMIT_KEY, String(clamped));
  } catch {
    // ignore — the default applies
  }
}

let sessionStartedAt: number | null = null;

/** Called when kid playtime begins; idempotent within a session. */
export function markSessionStart(now: number = Date.now()): void {
  if (sessionStartedAt === null) sessionStartedAt = now;
}

export function resetSessionClock(): void {
  sessionStartedAt = null;
}

/** 0 → fresh session, 1 → cap reached. This drives the SunMoon arc. */
export function sessionProgress(now: number = Date.now()): number {
  if (sessionStartedAt === null) return 0;
  const capMs = getLimitMinutes() * 60_000;
  return Math.min(1, (now - sessionStartedAt) / capMs);
}

export function sessionExpired(now: number = Date.now()): boolean {
  return sessionProgress(now) >= 1;
}
