import { useEffect, useRef, useState } from "react";
import { useI18n, type Lang } from "../../i18n";
import { getSession, sessionStats } from "../../session/transcript";
import {
  getLimitMinutes,
  setLimitMinutes,
  sessionProgress,
  MIN_LIMIT_MIN,
  MAX_LIMIT_MIN,
} from "../../session/cap";
import { SunMoon } from "../../components/SunMoon";

// The parent room is deliberately the OTHER visual language (Modernist:
// Archivo, square corners) — the switch itself signals whose room this is.
// Grown-up strings are intentionally English-only chrome (i18n §9.7 covers
// kid-facing strings); the language TOGGLE is the parent-facing control.

const GATE_HOLD_MS = 2000;

export function ParentView({ onBack }: { onBack: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <ParentGate onOpen={() => setOpen(true)} onBack={onBack} />;
  return <ParentDashboard onBack={onBack} />;
}

/** Press-and-hold gate (design: fill-from-bottom feedback, release resets). */
function ParentGate({ onOpen, onBack }: { onOpen: () => void; onBack: () => void }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = (): void => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    setProgress(0);
  };

  const start = (): void => {
    if (timer.current !== null) return;
    const t0 = performance.now();
    timer.current = setInterval(() => {
      const p = (performance.now() - t0) / GATE_HOLD_MS;
      if (p >= 1) {
        stop();
        onOpen();
      } else {
        setProgress(p);
      }
    }, 50);
  };

  useEffect(() => stop, []);

  return (
    <main className="parent-gate">
      <button type="button" className="loop-back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <button
        type="button"
        className="gate-circle"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        aria-label="Hold for two seconds to open the grown-up area"
      >
        <span className="gate-fill" style={{ height: `${Math.round(progress * 100)}%` }} aria-hidden="true" />
        <span className="gate-label">Hold for grown-ups</span>
      </button>
      <p className="gate-note">Press and hold for 2 seconds — out of a child's patience, never their way out.</p>
    </main>
  );
}

function ParentDashboard({ onBack }: { onBack: () => void }) {
  const { lang, setLang } = useI18n();
  const session = getSession();
  const stats = session !== null ? sessionStats(session) : null;
  // The real cap store (§9.5) is the source of truth; re-read after every
  // write so the label always shows the clamped, persisted value.
  const [limit, setLimit] = useState(() => getLimitMinutes());

  const onLimitChange = (value: number): void => {
    setLimitMinutes(value);
    setLimit(getLimitMinutes());
  };

  return (
    <main className="parent">
      <header className="parent-header">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>Grown-ups</h1>
      </header>

      <section className="parent-stats">
        <StatTile label="Turns spoken" value={stats?.turns ?? 0} />
        <StatTile label="Words heard" value={stats?.wordsHeard ?? 0} />
        <StatTile label="Answers matched" value={stats?.matched ?? 0} />
      </section>

      <section className="parent-limit">
        <h2>Daily limit</h2>
        <SunMoon t={sessionProgress()} className="parent-sunmoon" />
        <div className="parent-limit-row">
          <input
            type="range"
            min={MIN_LIMIT_MIN}
            max={MAX_LIMIT_MIN}
            step={5}
            value={limit}
            onChange={(e) => onLimitChange(Number(e.currentTarget.value))}
            aria-label="Daily limit in minutes"
            data-testid="limit-slider"
          />
          <span className="parent-limit-value" data-testid="limit-value" aria-live="polite">
            {limit} minutes
          </span>
        </div>
        <p className="parent-note">
          The sun above shows where today's session is right now; the sun-to-moon meter on kid
          screens follows this limit. When the sun sets, Chiku says goodbye — no extensions.
        </p>
      </section>

      <section className="parent-lang">
        <h2>Language</h2>
        <div className="parent-seg" role="radiogroup" aria-label="Language">
          {(["en", "te"] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={lang === l}
              className={lang === l ? "is-active" : ""}
              onClick={() => setLang(l)}
            >
              {l === "en" ? "English" : "తెలుగు"}
            </button>
          ))}
        </div>
        <p className="parent-note">Both languages always show on kid screens; this picks which leads — and which voice Chiku uses.</p>
      </section>

      <section className="parent-transcript">
        <h2>This session</h2>
        {session === null || session.entries.length === 0 ? (
          <p className="parent-note">No checkpoint exchanges yet this session.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Checkpoint</th>
                <th>Heard</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {session.entries.map((e, i) => (
                <tr key={i}>
                  <td>{e.checkpointId}</td>
                  <td>{e.heard ?? "—"}</td>
                  <td>
                    <span className={`parent-tag parent-tag-${e.outcome}`}>{e.outcome}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="parent-note">Lives in this tab only. Nothing is uploaded, nothing is stored.</p>
      </section>
    </main>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="parent-tile">
      <div className="parent-tile-value">{value}</div>
      <div className="parent-tile-label">{label}</div>
    </div>
  );
}
