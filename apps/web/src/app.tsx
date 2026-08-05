import { useState } from "react";
import { LangProvider } from "./i18n";
import { Home } from "./surfaces/home/Home";
import { LoopDemo } from "./surfaces/player/LoopDemo";
import { Player } from "./surfaces/player/Player";
import { ParentView } from "./surfaces/parent/ParentView";

type Surface = { name: "home" } | { name: "player"; episodeId: string } | { name: "parent" } | { name: "loop" };

export function App() {
  const [surface, setSurface] = useState<Surface>({ name: "home" });
  const home = (): void => setSurface({ name: "home" });

  return (
    <LangProvider>
      {surface.name === "home" && (
        <Home
          onPlayEpisode={(episodeId) => setSurface({ name: "player", episodeId })}
          onParent={() => setSurface({ name: "parent" })}
          onLoopDemo={() => setSurface({ name: "loop" })}
        />
      )}
      {surface.name === "player" && <Player episodeId={surface.episodeId} onExit={home} />}
      {surface.name === "parent" && <ParentView onBack={home} />}
      {surface.name === "loop" && <LoopDemo onBack={home} />}
    </LangProvider>
  );
}
