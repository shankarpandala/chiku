import { useState } from "react";
import type { RigState } from "@chiku/rig";
import { ChikuRig } from "../../rig/ChikuRig";
import { useI18n } from "../../i18n";

const RIG_STATES: readonly RigState[] = ["idle", "listening", "speaking", "celebrate", "goodbye"];

export function Home() {
  const { lang, other, tIn } = useI18n();
  const [rigState, setRigState] = useState<RigState>("idle");

  return (
    <main className="home">
      <h1 className="home-title">
        <span className={lang === "te" ? "te" : ""}>{tIn(lang, "app.title")}</span>{" "}
        <span className={other === "te" ? "te" : ""} aria-hidden="true">
          {tIn(other, "app.title")}
        </span>
      </h1>

      <div className="home-stage">
        <ChikuRig state={rigState} />
      </div>

      <p className="home-greeting">
        <span className={lang === "te" ? "te" : ""}>{tIn(lang, "home.greeting")}</span>
        <span className={other === "te" ? "te" : ""}>{tIn(other, "home.greeting")}</span>
      </p>

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
        </div>
      )}
    </main>
  );
}
