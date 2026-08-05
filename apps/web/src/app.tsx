import { useState } from "react";
import { LangProvider } from "./i18n";
import { Home } from "./surfaces/home/Home";
import { LoopDemo } from "./surfaces/player/LoopDemo";

type Surface = "home" | "loop";

export function App() {
  const [surface, setSurface] = useState<Surface>("home");
  return (
    <LangProvider>
      {surface === "home" ? (
        <Home onPlay={() => setSurface("loop")} />
      ) : (
        <LoopDemo onBack={() => setSurface("home")} />
      )}
    </LangProvider>
  );
}
