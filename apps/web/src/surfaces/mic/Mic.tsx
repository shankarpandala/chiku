// Phone Mic & Remote surface (M3) — design ref: apps/prototype/src/screens/
// PhoneRemote.jsx. §7 room rules: this surface writes ONLY utterances and
// control — the stage alone owns `state`. STT runs on this phone (§9.1/D1);
// only text ever leaves the device. Teal is reserved for "Chiku is hearing
// you": the held push-to-talk and the listening-phase pill, nothing else.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckpointSegment, Episode, ExpectedAnswer, RoomState } from "@chiku/schema";
import { useI18n } from "../../i18n";
import { fetchEpisode } from "../../episodes/client";
import { joinRoom, type RoomConnection, type RoomStatus } from "../../session/room";
import { getVolume } from "../../session/volume";
import { createWebSpeech, type SpeechEngine } from "../../speech/webspeech";
import "./mic.css";

interface MicProps {
  code: string;
  onExit: () => void;
  /** Injectable for tests; defaults to this device's real Web Speech engine. */
  engine?: SpeechEngine;
}

/** Web Speech confidence can be 0/NaN on some platforms — keep it in [0,1]. */
function clampConf(conf: number): number {
  if (!Number.isFinite(conf)) return 0;
  return Math.min(1, Math.max(0, conf));
}

const MIC_GLYPH = [
  "M12 3.5a3.4 3.4 0 013.4 3.4v4.8a3.4 3.4 0 01-6.8 0V6.9A3.4 3.4 0 0112 3.5z",
  "M5.8 11.2a6.2 6.2 0 0012.4 0",
  "M12 17.4V21",
  "M8.6 21h6.8",
];
const EAR_GLYPH = ["M6 18a8 8 0 010-12", "M11 15a4 4 0 010-6", "M15 4c4 3 4 13 0 16"];
const BAR_DELAYS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];

export function Mic({ code, onExit, engine }: MicProps) {
  const { t } = useI18n();
  const speech = useMemo(() => engine ?? createWebSpeech(), [engine]);

  // --- room connection (rejoinable: pulling out mid-episode must recover) ---
  const [attempt, setAttempt] = useState(0);
  const [room, setRoom] = useState<RoomConnection | null>(null);
  const [status, setStatus] = useState<RoomStatus>("connecting");
  const [snapshot, setSnapshot] = useState<RoomState | null>(null);
  const roomRef = useRef<RoomConnection | null>(null);
  roomRef.current = room;

  useEffect(() => {
    const conn = joinRoom(code, "mic");
    setRoom(conn);
    const offRoom = conn.onRoom((r) => setSnapshot(r));
    const offStatus = conn.onStatus((s) => setStatus(s));
    return () => {
      offRoom();
      offStatus();
      conn.close();
    };
  }, [code, attempt]);

  const rejoin = (): void => {
    setStatus("connecting");
    setAttempt((a) => a + 1);
  };

  // --- push-to-talk: HOLD, not toggle (§9.1: STT stays on the phone) ---
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  const [micBlocked, setMicBlocked] = useState(!speech.available);
  const micBlockedRef = useRef(!speech.available);

  useEffect(() => {
    const offResult = speech.onResult((r) => {
      if (!r.isFinal) return;
      roomRef.current?.send({
        type: "utterance",
        utterance: { text: r.text, conf: clampConf(r.conf), ts: Date.now() },
      });
    });
    const offEnd = speech.onEnd(() => {
      // Web Speech self-terminates after each utterance; while the child is
      // still holding, reopen the ear so the hold keeps meaning "my turn".
      if (holdingRef.current && !micBlockedRef.current) speech.start("en-IN");
    });
    const offError = speech.onError((message) => {
      if (message === "not-allowed" || message === "audio-capture" || message === "service-not-allowed") {
        micBlockedRef.current = true;
        setMicBlocked(true);
        holdingRef.current = false;
        setHolding(false);
      }
    });
    return () => {
      offResult();
      offEnd();
      offError();
      speech.stop();
    };
  }, [speech]);

  const holdStart = (): void => {
    if (micBlockedRef.current || holdingRef.current) return;
    holdingRef.current = true;
    setHolding(true);
    speech.start("en-IN");
  };
  const holdEnd = (): void => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    speech.stop();
  };

  // --- episode mirror: derive the current checkpoint for tap-answer chips ---
  const [episode, setEpisode] = useState<Episode | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const episodeId = snapshot?.state.episodeId;

  useEffect(() => {
    // "pending" is the hub's placeholder before the stage publishes state.
    if (episodeId === undefined || episodeId === "pending") return;
    if (fetchedFor.current === episodeId) return;
    fetchedFor.current = episodeId;
    let alive = true;
    fetchEpisode(episodeId)
      .then((ep) => {
        if (alive) setEpisode(ep);
      })
      .catch(() => {
        // Chips just don't render; push-to-talk still works.
        fetchedFor.current = null;
      });
    return () => {
      alive = false;
    };
  }, [episodeId]);

  // --- grown-up strip: end confirm (two-step, 3s window) + volume ---
  const [endSent, setEndSent] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vol, setVol] = useState(() => getVolume());

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const onEndTap = (): void => {
    if (!confirmEnd) {
      setConfirmEnd(true);
      confirmTimer.current = setTimeout(() => setConfirmEnd(false), 3000);
      return;
    }
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    roomRef.current?.send({ type: "control", control: { end: true } });
    setEndSent(true);
  };

  const onVolume = (v: number): void => {
    setVol(v);
    roomRef.current?.send({ type: "control", control: { volume: v } });
  };

  const sendChip = (answer: ExpectedAnswer): void => {
    roomRef.current?.send({
      type: "utterance",
      utterance: { text: answer.match[0] ?? answer.id, conf: 1, ts: Date.now() },
    });
  };

  // --- derived render state ---
  const ended = endSent || snapshot?.control.end === true;
  const paired = snapshot?.stage?.connected === true;
  const phase = snapshot?.state.phase;
  const checkpoint = currentCheckpoint(episode, snapshot);

  if (ended) {
    return (
      <main className="mic mic-center">
        <p className="mic-big">{t("mic.ended")}</p>
        <button type="button" className="loop-start" data-focusable="true" onClick={onExit}>
          {t("loop.back")}
        </button>
      </main>
    );
  }

  if (status === "closed") {
    // Gentle reconnect: the room dropped (network blip, phone slept) — offer
    // a rejoin, never an error wall (M3 acceptance: recover gracefully).
    return (
      <main className="mic mic-center">
        <p className="mic-big">{t("mic.waiting")}</p>
        <button type="button" className="loop-start" data-focusable="true" onClick={rejoin}>
          {t("loop.again")}
        </button>
        <button type="button" className="mic-ghost" onClick={onExit}>
          {t("loop.back")}
        </button>
      </main>
    );
  }

  const pill =
    phase === undefined
      ? null
      : phase === "listening"
        ? { text: t("remote.chikuHears"), cls: "pill-teal" }
        : phase === "celebrating"
          ? { text: t("loop.done"), cls: "pill-marigold" }
          : { text: t("loop.chikuTalking"), cls: "pill-violet" };

  return (
    <main className="mic">
      <header className="mic-header">
        <span className={`mic-dot${paired ? " is-on" : ""}`} aria-hidden="true" />
        <span className="mic-pair">{paired ? t("mic.pairedWith") : t("mic.waiting")}</span>
      </header>

      <section className={`mic-talk${holding ? " is-holding" : ""}`}>
        <button
          type="button"
          className={`mic-ptt${holding ? " is-holding" : ""}`}
          data-focusable="true"
          disabled={micBlocked}
          aria-label={holding ? t("mic.release") : t("remote.holdToTalk")}
          onPointerDown={holdStart}
          onPointerUp={holdEnd}
          onPointerLeave={holdEnd}
          onPointerCancel={holdEnd}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="mic-ptt-ring" aria-hidden="true" />
          <Glyph paths={holding ? EAR_GLYPH : MIC_GLYPH} />
          <span className="mic-ptt-label">{holding ? t("mic.release") : t("remote.holdToTalk")}</span>
        </button>
        <div className="mic-bars" aria-hidden="true">
          {BAR_DELAYS.map((d) => (
            <span key={d} className="mic-bar" style={{ animationDelay: `${d}s` }} />
          ))}
        </div>
        {micBlocked && <p className="mic-off">{t("loop.micOff")}</p>}
      </section>

      {pill !== null && <div className={`loop-pill ${pill.cls}`}>{pill.text}</div>}

      {phase === "listening" && checkpoint !== null && (
        <section className="mic-chips">
          <p className="mic-chips-label">{t("mic.tapAnswer")}</p>
          <div className="mic-chip-grid">
            {checkpoint.expect.map((answer) => (
              <button
                key={answer.id}
                type="button"
                className="mic-chip"
                data-focusable="true"
                onClick={() => sendChip(answer)}
              >
                <ChipVisual expectId={answer.id} />
                <span className="mic-chip-label">{answer.id}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Grown-up strip — Modernist chrome (Archivo, square corners) on
          purpose, so a child skims past it. English literals are fine here. */}
      <footer className="mic-grownup">
        <p className="mic-grownup-label">Grown-up controls</p>
        <div className="mic-grownup-row">
          <button
            type="button"
            className={`mic-end${confirmEnd ? " is-confirm" : ""}`}
            onClick={onEndTap}
          >
            {confirmEnd ? "End? Tap again" : "End"}
          </button>
          <label className="mic-volume">
            Volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={vol}
              aria-label="Volume"
              onChange={(e) => onVolume(Number(e.target.value))}
            />
          </label>
          <span className="mic-room">Room {code}</span>
        </div>
      </footer>
    </main>
  );
}

/** The checkpoint the room is at — only meaningful while the ids line up. */
function currentCheckpoint(episode: Episode | null, snapshot: RoomState | null): CheckpointSegment | null {
  if (episode === null || snapshot === null) return null;
  if (episode.id !== snapshot.state.episodeId) return null;
  const seg = episode.segments[snapshot.state.segIdx];
  return seg !== undefined && seg.type === "checkpoint" ? seg : null;
}

/** Picture anchor per expected answer — mirrors the Player's AnchorVisual
 *  (pre-readers navigate by picture), without importing the Player. */
function ChipVisual({ expectId }: { expectId: string }) {
  const colors: Record<string, string> = {
    green: "#6aa84f",
    red: "#c94b39",
    yellow: "#f0a33c",
  };
  const color = colors[expectId];
  if (color !== undefined) {
    return <span className="mic-chip-swatch" style={{ background: color }} aria-hidden="true" />;
  }
  return (
    <span className="mic-chip-swatch mic-chip-count" aria-hidden="true">
      {expectId === "three" ? "● ● ●" : "?"}
    </span>
  );
}

function Glyph({ paths }: { paths: string[] }) {
  return (
    <svg
      className="mic-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
