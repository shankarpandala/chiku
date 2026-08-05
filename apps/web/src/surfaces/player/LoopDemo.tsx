import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Rig } from "@chiku/rig";
import { ChikuRig } from "../../rig/ChikuRig";
import { useI18n } from "../../i18n";
import { createWebSpeech, type SpeechEngine } from "../../speech/webspeech";
import { CP1, CP1_EARNED } from "../../loop/checkpoint";
import {
  initialLoopState,
  transition,
  type LoopEvent,
  type LoopState,
} from "../../loop/machine";

interface LoopDemoProps {
  onBack: () => void;
  /** Injectable for tests; defaults to the real Web Speech engine. */
  engine?: SpeechEngine;
}

/**
 * M1: one hardcoded checkpoint, solo web. Ask → listen → local match →
 * praise ≤ 400ms (latency logged to console per the milestone acceptance).
 */
export function LoopDemo({ onBack, engine }: LoopDemoProps) {
  const { t } = useI18n();
  const speech = useMemo(() => engine ?? createWebSpeech(), [engine]);

  const [loop, setLoop] = useState<LoopState>(initialLoopState);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [heard, setHeard] = useState<string>("");
  const [micBlocked, setMicBlocked] = useState(false);

  const rigRef = useRef<Rig | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakSeq = useRef(0);
  const micBlockedRef = useRef(false);

  const dispatch = useCallback(
    (event: LoopEvent): void => {
      const { next, effects } = transition(loopRef.current, event, CP1);
      loopRef.current = next;
      setLoop(next);

      const rig = rigRef.current;
      for (const effect of effects) {
        switch (effect.type) {
          case "PLAY": {
            const line = CP1.lines[effect.line];
            if (rig === null) break;
            if (effect.celebrate === true) rig.setState("celebrate");
            const seq = ++speakSeq.current;
            void rig.speak(line.url, line.marks).then(() => {
              // A speak interrupted by a newer one resolves too — only the
              // latest line may advance the machine.
              if (speakSeq.current === seq) dispatch({ type: "SPEAK_ENDED" });
            });
            break;
          }
          case "LISTEN_START": {
            rig?.setState("listening");
            speech.start("en-IN"); // en-IN hears transliterated Telugu too (§7)
            listenTimer.current = setTimeout(() => dispatch({ type: "LISTEN_TIMEOUT" }), CP1.listenMs);
            break;
          }
          case "LISTEN_STOP": {
            if (listenTimer.current !== null) {
              clearTimeout(listenTimer.current);
              listenTimer.current = null;
            }
            speech.stop();
            break;
          }
          case "MATCHED": {
            // §8 step 3 budget: utterance-end → Chiku speaking ≤ 400ms.
            const ms = performance.now() - effect.heardAtMs;
            setLatencyMs(ms);
            console.log(
              `[chiku] checkpoint=${CP1.id} matched=${effect.result.id} ` +
                `score=${effect.result.score.toFixed(2)} utterance-end→speak=${ms.toFixed(1)}ms (budget 400ms)`,
            );
            break;
          }
        }
      }
    },
    [speech],
  );

  useEffect(() => {
    const offResult = speech.onResult((r) => {
      if (!r.isFinal) return;
      setHeard(r.text);
      dispatch({ type: "HEARD", text: r.text, conf: r.conf, tsMs: r.tsMs });
    });
    // Web Speech ends itself after silence; while we're still in the listening
    // window, reopen the mic so the child can try again within listenMs.
    // Never against a dead mic — that would spin start→error→end forever.
    const offEnd = speech.onEnd(() => {
      if (loopRef.current.phase === "listening" && !micBlockedRef.current) speech.start("en-IN");
    });
    const offError = speech.onError((message) => {
      if (message === "not-allowed" || message === "audio-capture" || message === "service-not-allowed") {
        micBlockedRef.current = true;
        setMicBlocked(true);
      }
    });
    return () => {
      offResult();
      offEnd();
      offError();
      if (listenTimer.current !== null) clearTimeout(listenTimer.current);
      speech.stop();
    };
  }, [speech, dispatch]);

  const phase = loop.phase;
  const pill =
    phase === "listening"
      ? { text: t("remote.chikuHears"), cls: "pill-teal" }
      : phase === "asking" || phase === "retrying" || phase === "together"
        ? { text: t("loop.chikuTalking"), cls: "pill-violet" }
        : phase === "celebrating" || (phase === "done" && loop.won)
          ? { text: t("loop.done"), cls: "pill-marigold" }
          : null;

  return (
    <main className="loop">
      <button type="button" className="loop-back" onClick={onBack} aria-label={t("loop.back")}>
        ←
      </button>

      <div className="loop-stage">
        <ChikuRig onReady={(rig) => (rigRef.current = rig)} />
      </div>

      {pill !== null && <div className={`loop-pill ${pill.cls}`}>{pill.text}</div>}

      <section className="loop-card">
        <div className="loop-swatch" aria-hidden="true" />
        <p className="loop-question">
          <span>{t("loop.question")}</span>
        </p>
        {phase === "listening" && !micBlocked && <p className="loop-hint">{t("loop.hint")}</p>}
        {phase === "listening" && micBlocked && <p className="loop-hint">{t("loop.micOff")}</p>}
        {(phase === "celebrating" || phase === "done") && loop.won && (
          <p className="loop-earned">
            <span className="te">{CP1_EARNED.te}</span> · {CP1_EARNED.translit} · {CP1_EARNED.en}
          </p>
        )}
      </section>

      {(phase === "idle" || phase === "done") && (
        <button type="button" className="loop-start" onClick={() => dispatch({ type: "START" })}>
          {phase === "done" ? t("loop.again") : speech.available ? t("mic.turnOnEars") : t("home.play")}
        </button>
      )}

      {import.meta.env.DEV && (
        <DevSay
          heard={heard}
          latencyMs={latencyMs}
          onSay={(text) => dispatch({ type: "HEARD", text, conf: 0.95, tsMs: performance.now() })}
        />
      )}
    </main>
  );
}

/** Dev-only: type what the child would say — drives the same HEARD event. */
function DevSay({
  heard,
  latencyMs,
  onSay,
}: {
  heard: string;
  latencyMs: number | null;
  onSay: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="dev-say">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="dev: type the child's answer"
        aria-label="dev: type the child's answer"
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim() !== "") {
            onSay(text);
            setText("");
          }
        }}
      />
      <button
        type="button"
        onClick={() => {
          if (text.trim() !== "") {
            onSay(text);
            setText("");
          }
        }}
      >
        say
      </button>
      <span className="dev-say-meta">
        {heard !== "" ? `heard: "${heard}"` : ""}
        {latencyMs !== null ? ` · ${latencyMs.toFixed(0)}ms` : ""}
      </span>
    </div>
  );
}
