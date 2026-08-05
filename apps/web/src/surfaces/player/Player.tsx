import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Episode, RoomPhase } from "@chiku/schema";
import { VisemeMarksFileSchema } from "@chiku/schema";
import type { Rig, VisemeMark } from "@chiku/rig";
import { ChikuRig } from "../../rig/ChikuRig";
import { SunMoon } from "../../components/SunMoon";
import { useI18n } from "../../i18n";
import { createWebSpeech, type SpeechEngine } from "../../speech/webspeech";
import { fetchEpisode, fetchMarks, mediaUrl, understand } from "../../episodes/client";
import {
  engineTransition,
  initialEngineState,
  type EnginePhase,
  type EngineEvent,
  type EngineState,
} from "../../player/engine";
import { markSessionStart, sessionExpired, sessionProgress } from "../../session/cap";
import type { RoomConnection } from "../../session/room";
import { recordEntry, startSession } from "../../session/transcript";
import { createVolumeAudio, setVolume } from "../../session/volume";

/** Placeholder video length until real segments land (content is M2+ media). */
const VIDEO_PLACEHOLDER_MS = 4000;

/** Engine phase → the §7 room phase vocabulary the mic device renders from. */
const ROOM_PHASE: Record<EnginePhase, RoomPhase> = {
  idle: "playing",
  video: "playing",
  asking: "asking",
  listening: "listening",
  thinking: "responding",
  celebrating: "celebrating",
  retrying: "asking",
  together: "asking",
  complete: "playing",
};

interface PlayerProps {
  episodeId: string;
  onExit: () => void;
  engine?: SpeechEngine;
  /** Stage mode: publish state to and honor control from this room (§7). */
  room?: RoomConnection;
  /** 10-foot styling (TV stage). */
  tv?: boolean;
}

export function Player({ episodeId, onExit, engine, room, tv = false }: PlayerProps) {
  const { t, lang } = useI18n();
  const speech = useMemo(() => engine ?? createWebSpeech(), [engine]);

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<EngineState>(initialEngineState);
  const [heard, setHeard] = useState("");
  const [micBlocked, setMicBlocked] = useState(false);
  const [lastMatch, setLastMatch] = useState<string | null>(null);
  const [dayT, setDayT] = useState(0); // SunMoon position (session cap §9.5)

  const rigRef = useRef<Rig | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const episodeRef = useRef<Episode | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakSeq = useRef(0);
  const micBlockedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetchEpisode(episodeId)
      .then((ep) => {
        if (!alive) return;
        episodeRef.current = ep;
        setEpisode(ep);
        startSession(episodeId);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [episodeId]);

  const dispatch = useCallback(
    (event: EngineEvent): void => {
      const ep = episodeRef.current;
      if (ep === null) return;
      const { next, effects } = engineTransition(stateRef.current, event, ep, langRef.current);
      stateRef.current = next;
      setState(next);

      // Stage mode: the stage owns state.phase — publish every transition (§7).
      // The hub preserves lastUtterance (the mic's write) on state merges.
      room?.send({
        type: "state",
        state: {
          mode: "player",
          episodeId: ep.id,
          segIdx: Math.max(0, next.segIdx),
          phase: ROOM_PHASE[next.phase],
          lastUtterance: { text: "", conf: 0, ts: 0 },
          playAudio: { url: "", marks: "", nonce: 0 },
        },
      });

      const rig = rigRef.current;
      for (const effect of effects) {
        switch (effect.type) {
          case "PLAY_VIDEO": {
            rig?.setState("idle");
            videoTimer.current = setTimeout(() => dispatch({ type: "VIDEO_DONE" }), VIDEO_PLACEHOLDER_MS);
            break;
          }
          case "PLAY_LINE": {
            if (rig === null) break;
            if (effect.celebrate === true) rig.setState("celebrate");
            const seq = ++speakSeq.current;
            const speakWith = (marks?: VisemeMark[]): void => {
              void rig.speak(mediaUrl(ep.id, effect.audio), marks).then(() => {
                if (speakSeq.current === seq) dispatch({ type: "SPEAK_ENDED" });
              });
            };
            if (effect.marks !== undefined) {
              // Marks are best-effort: a fetch failure just means amplitude mouth.
              fetchMarks(ep.id, effect.marks)
                .then((raw) => speakWith(VisemeMarksFileSchema.parse(raw)))
                .catch(() => speakWith());
            } else {
              speakWith();
            }
            break;
          }
          case "LISTEN_START": {
            rig?.setState("listening");
            speech.start("en-IN");
            listenTimer.current = setTimeout(() => dispatch({ type: "LISTEN_TIMEOUT" }), effect.listenMs);
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
          case "ESCALATE": {
            // §8 step 4: brain round-trip, hard-capped so the miss path stays ≤2s.
            const cp = ep.segments[stateRef.current.segIdx];
            if (cp === undefined || cp.type !== "checkpoint") break;
            const t0 = performance.now();
            understand({
              episodeId: ep.id,
              checkpointId: cp.id,
              utterance: effect.utterance,
              lang: langRef.current,
              expectIds: cp.expect.map((e) => e.id),
            })
              .then((response) => {
                console.log(
                  `[chiku] understand cp=${cp.id} action=${response.action} rtt=${(performance.now() - t0).toFixed(0)}ms`,
                );
                dispatch({ type: "UNDERSTOOD", response, utterance: effect.utterance, heardAtMs: effect.heardAtMs });
              })
              .catch(() => {
                console.warn(`[chiku] understand failed after ${(performance.now() - t0).toFixed(0)}ms — local retry`);
                dispatch({ type: "UNDERSTAND_FAILED" });
              });
            break;
          }
          case "MATCHED": {
            const ms = performance.now() - effect.heardAtMs;
            const budget = effect.via === "local" ? 400 : 2000;
            console.log(
              `[chiku] matched=${effect.matchId} via=${effect.via} utterance-end→speak=${ms.toFixed(1)}ms (budget ${budget}ms)`,
            );
            setLastMatch(effect.matchId);
            break;
          }
          case "TRANSCRIPT": {
            recordEntry(effect.entry);
            break;
          }
          case "EPISODE_COMPLETE": {
            rig?.setState("goodbye");
            break;
          }
        }
      }
    },
    [speech, room],
  );

  useEffect(() => {
    const offResult = speech.onResult((r) => {
      if (!r.isFinal) return;
      setHeard(r.text);
      dispatch({ type: "HEARD", text: r.text, conf: r.conf, tsMs: r.tsMs });
    });
    const offEnd = speech.onEnd(() => {
      if (stateRef.current.phase === "listening" && !micBlockedRef.current) speech.start("en-IN");
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
      if (videoTimer.current !== null) clearTimeout(videoTimer.current);
      speech.stop();
    };
  }, [speech, dispatch]);

  // Hard session cap (§9.5): the SunMoon arc is the only time signal a child
  // sees; at the cap the engine ends warmly via SESSION_END. Ticks 1/s.
  useEffect(() => {
    const tick = setInterval(() => {
      setDayT(sessionProgress());
      if (sessionExpired() && stateRef.current.phase !== "complete" && stateRef.current.phase !== "idle") {
        dispatch({ type: "SESSION_END" });
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [dispatch]);

  // Grown-up controls from the paired mic (§7: mic writes `control`).
  const endedByControl = useRef(false);
  useEffect(() => {
    if (room === undefined) return;
    return room.onRoom((snapshot) => {
      if (snapshot.control.end && !endedByControl.current) {
        endedByControl.current = true;
        dispatch({ type: "SESSION_END" });
      }
      setVolume(snapshot.control.volume);
    });
  }, [room, dispatch]);

  if (loadError) {
    return (
      <main className="loop">
        <p className="loop-question">{t("player.offline")}</p>
        <button type="button" className="loop-start" onClick={onExit}>
          {t("loop.back")}
        </button>
      </main>
    );
  }

  const phase = state.phase;
  const seg = episode?.segments[state.segIdx];
  const currentCp = seg !== undefined && seg.type === "checkpoint" ? seg : null;

  const pill =
    phase === "listening"
      ? { text: t("remote.chikuHears"), cls: "pill-teal" }
      : phase === "thinking"
        ? { text: t("player.thinking"), cls: "pill-violet" }
        : phase === "asking" || phase === "retrying" || phase === "together"
          ? { text: t("loop.chikuTalking"), cls: "pill-violet" }
          : phase === "celebrating"
            ? { text: t("loop.done"), cls: "pill-marigold" }
            : null;

  return (
    <main className={`loop${tv ? " tv" : ""}`}>
      {!tv && (
        <button type="button" className="loop-back" onClick={onExit} aria-label={t("loop.back")}>
          ←
        </button>
      )}

      <SunMoon t={dayT} className="loop-sunmoon" />

      {phase === "video" && seg !== undefined && seg.type === "video" && (
        <section className="player-video" data-testid="video-placeholder">
          <p className="player-video-label">{t("player.watch")}</p>
          <p className="player-video-src">{seg.src}</p>
        </section>
      )}

      <div className="loop-stage">
        <ChikuRig
          onReady={(rig) => (rigRef.current = rig)}
          rigOptions={{ createAudio: createVolumeAudio }}
        />
      </div>

      {pill !== null && <div className={`loop-pill ${pill.cls}`}>{pill.text}</div>}

      {currentCp !== null && (
        <section className="loop-card">
          {/* The ask is spoken (zero reading required); this anchors it visually. */}
          <AnchorVisual expectId={currentCp.expect[0]?.id ?? ""} />
          {phase === "listening" && !micBlocked && <p className="loop-hint">{t("loop.hint")}</p>}
          {phase === "listening" && micBlocked && <p className="loop-hint">{t("loop.micOff")}</p>}
          {phase === "celebrating" && state.won && lastMatch !== null && (
            <p className="loop-earned">{lastMatch}</p>
          )}
        </section>
      )}

      {phase === "idle" && episode !== null && (
        <button
          type="button"
          className="loop-start"
          data-focusable="true"
          onClick={() => {
            markSessionStart();
            dispatch({ type: "START" });
          }}
        >
          {speech.available ? t("mic.turnOnEars") : t("home.play")}
        </button>
      )}

      {phase === "complete" && (
        <>
          <p className="loop-question">{t("player.theEnd")}</p>
          <button type="button" className="loop-start" onClick={onExit}>
            {t("loop.back")}
          </button>
        </>
      )}

      {import.meta.env.DEV && (
        <div className="dev-say">
          <DevSayInput heard={heard} onSay={(text) => dispatch({ type: "HEARD", text, conf: 0.95, tsMs: performance.now() })} />
          {phase === "video" && (
            <button type="button" onClick={() => dispatch({ type: "VIDEO_DONE" })}>
              skip video
            </button>
          )}
        </div>
      )}
    </main>
  );
}

/** Picture anchor per checkpoint — pre-readers navigate by picture (design). */
function AnchorVisual({ expectId }: { expectId: string }) {
  const colors: Record<string, string> = {
    green: "#6aa84f",
    red: "#c94b39",
    yellow: "#f0a33c",
  };
  const color = colors[expectId];
  if (color !== undefined) {
    return <div className="loop-swatch" style={{ background: color }} aria-hidden="true" />;
  }
  return (
    <div className="loop-swatch loop-swatch-count" aria-hidden="true">
      {expectId === "three" ? "● ● ●" : "?"}
    </div>
  );
}

function DevSayInput({ heard, onSay }: { heard: string; onSay: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (text.trim() !== "") {
      onSay(text);
      setText("");
    }
  };
  return (
    <>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="dev: type the child's answer"
        aria-label="dev: type the child's answer"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button type="button" onClick={submit}>
        say
      </button>
      <span className="dev-say-meta">{heard !== "" ? `heard: "${heard}"` : ""}</span>
    </>
  );
}
