import { useEffect, useState } from "react";
import type { EpisodeIndex } from "@chiku/schema";
import type { RigState } from "@chiku/rig";
import { ChikuRig } from "../../rig/ChikuRig";
import { useI18n } from "../../i18n";
import { fetchEpisodeIndex } from "../../episodes/client";

const RIG_STATES: readonly RigState[] = ["idle", "listening", "speaking", "celebrate", "goodbye"];

interface HomeProps {
  onPlayEpisode: (episodeId: string) => void;
  onParent: () => void;
  /** Dev-only entry to the M1 loop demo. */
  onLoopDemo: () => void;
}

export function Home({ onPlayEpisode, onParent, onLoopDemo }: HomeProps) {
  const { lang, other, tIn } = useI18n();
  const [rigState, setRigState] = useState<RigState>("idle");
  const [episodes, setEpisodes] = useState<EpisodeIndex | null>(null);
  const [apiDown, setApiDown] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchEpisodeIndex()
      .then((idx) => {
        if (alive) setEpisodes(idx);
      })
      .catch(() => {
        if (alive) setApiDown(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="home">
      {/* Person glyph, top right — visible trust, out of a child's path (design). */}
      <button type="button" className="home-parent" onClick={onParent} aria-label="Grown-ups">
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="currentColor" />
        </svg>
      </button>

      <h1 className="home-title">
        <span className={lang === "te" ? "te" : ""}>{tIn(lang, "app.title")}</span>{" "}
        <span className={other === "te" ? "te" : ""} aria-hidden="true">
          {tIn(other, "app.title")}
        </span>
      </h1>

      <div className="home-stage">
        <ChikuRig state={rigState} />
      </div>

      {episodes !== null && episodes.length > 0 && (
        <div className="home-episodes">
          {episodes.map((ep) => (
            <button
              key={ep.id}
              type="button"
              className="home-episode-card"
              onClick={() => onPlayEpisode(ep.id)}
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

      {apiDown && (
        <p className="home-note">
          {tIn(lang, "home.apiDown")} <code>corepack pnpm dev:api</code>
        </p>
      )}

      {import.meta.env.DEV && (
        <div className="dev-states">
          {RIG_STATES.map((s) => (
            <button
              key={s}
              type="button"
              className={s === rigState ? "is-active" : ""}
              onClick={() => setRigState(s)}
            >
              {s}
            </button>
          ))}
          <button type="button" onClick={onLoopDemo}>
            loop demo
          </button>
        </div>
      )}
    </main>
  );
}
