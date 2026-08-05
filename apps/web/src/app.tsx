import { LangProvider } from "./i18n";
import { navigate, useRoute } from "./router";
import { Home } from "./surfaces/home/Home";
import { LoopDemo } from "./surfaces/player/LoopDemo";
import { Player } from "./surfaces/player/Player";
import { ParentView } from "./surfaces/parent/ParentView";
import { Stage } from "./surfaces/stage/Stage";
import { Mic } from "./surfaces/mic/Mic";

export function App() {
  const route = useRoute();
  const home = (): void => navigate({ name: "home" });

  return (
    <LangProvider>
      {route.name === "home" && (
        <Home
          onPlayEpisode={(episodeId) => navigate({ name: "player", episodeId })}
          onParent={() => navigate({ name: "parent" })}
          onLoopDemo={() => navigate({ name: "loop" })}
        />
      )}
      {route.name === "player" && <Player episodeId={route.episodeId} onExit={home} />}
      {route.name === "stage" && <Stage onExit={home} />}
      {route.name === "mic" && <Mic code={route.code} onExit={home} />}
      {route.name === "parent" && <ParentView onBack={home} />}
      {route.name === "loop" && <LoopDemo onBack={home} />}
    </LangProvider>
  );
}
