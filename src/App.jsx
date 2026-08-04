import { useCallback, useEffect, useRef, useState } from "react";
import { sx } from "./lib/styleString";
import { VIS } from "./data/kidPalette";
import { META } from "./data/meta";
import { NavSidebar } from "./components/NavSidebar";
import { ScreenHeader } from "./components/ScreenHeader";
import KidHome from "./screens/KidHome";
import EpisodePlayer from "./screens/EpisodePlayer";
import CallChiku from "./screens/CallChiku";
import TvStage from "./screens/TvStage";
import PhoneRemote from "./screens/PhoneRemote";
import ParentDashboard from "./screens/ParentDashboard";
import CharacterSheet from "./screens/CharacterSheet";
import DesignSystem from "./screens/DesignSystem";
import AppIcons from "./screens/AppIcons";

// Defaults carried over from the design prototype's editable props. The
// in-app language toggle (Parent Dashboard) overrides LANGUAGE via s.lang.
const LANGUAGE = "en";
const CELEBRATION = "confetti";
const REDUCE_MOTION = false;

// setState with class-component merge semantics, so the prototype's state
// logic ports over call-for-call.
function useMergeState(initial) {
  const [state, set] = useState(initial);
  const merge = useCallback((patch) => {
    set((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  }, []);
  return [state, merge];
}

export default function App() {
  const [s, setState] = useMergeState({
    screen: "home", cp: "ask", call: "listening", tv: "player",
    gate: false, hold: 0, limit: 20, lang: null, viseme: "closed", talking: false,
  });

  const stateRef = useRef(s);
  useEffect(() => { stateRef.current = s; });

  // Mouth: a random viseme every 200ms while a speaking state is active
  // (stands in for the TTS timing marks that drive it in the real product).
  useEffect(() => {
    const mouth = setInterval(() => {
      const st = stateRef.current;
      const speaking = (st.screen === "player" && (st.cp === "ask" || st.cp === "answered" || st.cp === "retry")) || (st.screen === "call" && st.call === "speaking");
      if (!speaking) { if (st.viseme !== "closed") setState({ viseme: "closed" }); return; }
      setState({ viseme: VIS[Math.floor(Math.random() * 7)] });
    }, 200);
    return () => clearInterval(mouth);
  }, [setState]);

  // Grown-up gate: two seconds of sustained pressure fills the circle.
  const holdT = useRef();
  const holdStart = useCallback(() => {
    clearInterval(holdT.current);
    holdT.current = setInterval(() => {
      setState((st) => {
        const h = st.hold + 0.06;
        if (h >= 1) { clearInterval(holdT.current); return { hold: 0, gate: true }; }
        return { hold: h };
      });
    }, 70);
  }, [setState]);
  const holdStop = useCallback(() => { clearInterval(holdT.current); setState({ hold: 0 }); }, [setState]);
  useEffect(() => () => clearInterval(holdT.current), []);

  const S = s.screen;
  const en = (s.lang ?? LANGUAGE ?? "en") === "en";
  const calm = (CELEBRATION ?? "confetti") === "calm";
  const still = REDUCE_MOTION ?? false;
  const go = useCallback((screen) => () => setState({ screen }), [setState]);

  const meta = META[S];
  const chikuBob = still ? "" : "animation:chBob 3.6s ease-in-out infinite";
  const screenProps = { s, setState, en, go, chikuBob };

  return (
    <div className={still ? "no-motion" : ""} style={sx("display:flex;min-height:100vh;background:var(--color-bg);font-family:var(--font-body);color:var(--color-text)")}>
      <NavSidebar S={S} go={go} />
      <main style={sx("flex:1;min-width:0;padding:32px 40px 96px")}>
        <ScreenHeader kicker={meta[0]} title={meta[1]} note={meta[2]} />
        {S === "home" && <KidHome {...screenProps} />}
        {S === "player" && <EpisodePlayer {...screenProps} calm={calm} still={still} />}
        {S === "call" && <CallChiku {...screenProps} />}
        {S === "tv" && <TvStage {...screenProps} />}
        {S === "remote" && <PhoneRemote {...screenProps} />}
        {S === "parent" && <ParentDashboard {...screenProps} holdStart={holdStart} holdStop={holdStop} />}
        {S === "character" && <CharacterSheet />}
        {S === "system" && <DesignSystem />}
        {S === "icons" && <AppIcons />}
      </main>
    </div>
  );
}
