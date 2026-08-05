// TV Stage surface (M3) — the 10-foot layout. The TV renders the character
// and the episode; a paired phone is the microphone and remote (§3 "Stage &
// Mic"). The TV itself NEVER listens — there is no mic-permission UI here by
// design, and the pairing card says so all session.
//
// Flow: createRoom() → join as "stage" → show the 4-char code + a scannable
// QR of #/mic/CODE (bottom-left, persistent). Episodes come from the API
// index; picking one hands the room + a RemoteSpeechEngine to the Player,
// which publishes room state and honors control.end / volume (§7).

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { EpisodeIndex } from "@chiku/schema";
import { useI18n } from "../../i18n";
import { createRoom, joinRoom, type RoomConnection } from "../../session/room";
import { createRemoteSpeech } from "../../speech/remote";
import type { SpeechEngine } from "../../speech/webspeech";
import { fetchEpisodeIndex } from "../../episodes/client";
import { Player } from "../player/Player";
import { useDpadNav } from "./useDpadNav";
import "./stage.css";

interface StageProps {
  onExit: () => void;
}

/** Room + the remote mic engine live together: both exist iff pairing is up. */
interface StageSession {
  code: string;
  conn: RoomConnection;
  engine: SpeechEngine;
}

export function Stage({ onExit }: StageProps) {
  const { t, lang, other, tIn } = useI18n();

  const [session, setSession] = useState<StageSession | null>(null);
  const [offline, setOffline] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [micConnected, setMicConnected] = useState(false);
  const [episodes, setEpisodes] = useState<EpisodeIndex | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  // Arrow keys + Enter over [data-focusable] — TV remotes send arrow keys.
  useDpadNav();

  // Create the pairing room once; the connection lives for the whole visit.
  useEffect(() => {
    let alive = true;
    let conn: RoomConnection | null = null;
    createRoom()
      .then((code) => {
        if (!alive) return;
        conn = joinRoom(code, "stage");
        setSession({ code, conn, engine: createRemoteSpeech(conn) });
      })
      .catch(() => {
        if (alive) setOffline(true); // §: never a dead screen
      });
    return () => {
      alive = false;
      conn?.close();
    };
  }, []);

  // A real, scannable QR of the mic route. The code alone still pairs if
  // QR generation ever fails, so that failure is deliberately non-fatal.
  useEffect(() => {
    if (session === null) return;
    let alive = true;
    const micUrl = `${window.location.origin}${window.location.pathname}#/mic/${session.code}`;
    QRCode.toDataURL(micUrl, { margin: 1, width: 264 })
      .then((dataUrl) => {
        if (alive) setQr(dataUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session]);

  // Mic presence from room snapshots (§7: presence node vanishes on disconnect).
  useEffect(() => {
    if (session === null) return;
    return session.conn.onRoom((room) => {
      setMicConnected(room.mic?.connected === true);
    });
  }, [session]);

  useEffect(() => {
    let alive = true;
    fetchEpisodeIndex()
      .then((idx) => {
        if (alive) setEpisodes(idx);
      })
      .catch(() => {
        if (alive) setOffline(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (offline) {
    return (
      <div className="stage">
        <main className="stage-offline">
          <p className="stage-offline-note">{t("player.offline")}</p>
          <button type="button" className="loop-start" data-focusable="true" onClick={onExit}>
            {t("loop.back")}
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="stage">
      {playing !== null && session !== null ? (
        <Player
          episodeId={playing}
          tv
          room={session.conn}
          engine={session.engine}
          onExit={() => setPlaying(null)}
        />
      ) : (
        <main className="stage-home">
          <h1 className="stage-title">
            <span className={lang === "te" ? "te" : ""}>{tIn(lang, "stage.pickEpisode")}</span>
            <span className={`stage-title-sub ${other === "te" ? "te" : ""}`} aria-hidden="true">
              {tIn(other, "stage.pickEpisode")}
            </span>
          </h1>
          {episodes !== null && (
            <div className="stage-grid">
              {episodes.map((ep) => (
                <button
                  key={ep.id}
                  type="button"
                  className="home-episode-card stage-episode-card"
                  data-focusable="true"
                  onClick={() => setPlaying(ep.id)}
                >
                  <span className="home-episode-play" aria-hidden="true">
                    ▶
                  </span>
                  <span className={lang === "te" ? "te" : ""}>{ep.title[lang]}</span>
                  <span className={`home-episode-sub ${other === "te" ? "te" : ""}`}>{ep.title[other]}</span>
                </button>
              ))}
            </div>
          )}
        </main>
      )}

      {/* Pairing card: persistent bottom-left, smaller while an episode plays.
          "Pairing, not casting" — it never leaves the screen. */}
      {session !== null && (
        <aside className={`stage-pairing${playing !== null ? " is-mini" : ""}`}>
          <div className="stage-code" data-testid="stage-code">
            {session.code}
          </div>
          {qr !== null && <img className="stage-qr" src={qr} alt={t("stage.scanToPair")} />}
          <div className="stage-pairing-text">
            <p className="stage-pairing-title">{t("stage.scanToPair")}</p>
            <p className="stage-pairing-hint">{t("stage.pairHint")}</p>
          </div>
          {/* Marigold, not teal: teal is reserved for "Chiku is hearing you". */}
          {micConnected && <div className="loop-pill pill-marigold stage-paired">{t("stage.paired")}</div>}
        </aside>
      )}
    </div>
  );
}
