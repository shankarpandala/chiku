// Hash router — deliberately tiny (no router dependency): the QR on the TV
// stage encodes #/mic/CODE, so surfaces must be reachable by URL.

import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "player"; episodeId: string }
  | { name: "stage" }
  | { name: "mic"; code: string }
  | { name: "parent" }
  | { name: "loop" };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p.length > 0);
  switch (parts[0]) {
    case "play":
      return parts[1] !== undefined ? { name: "player", episodeId: parts[1] } : { name: "home" };
    case "stage":
      return { name: "stage" };
    case "mic":
      return parts[1] !== undefined ? { name: "mic", code: parts[1].toUpperCase() } : { name: "home" };
    case "parent":
      return { name: "parent" };
    case "loop":
      return { name: "loop" };
    default:
      return { name: "home" };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "player":
      return `#/play/${route.episodeId}`;
    case "stage":
      return "#/stage";
    case "mic":
      return `#/mic/${route.code}`;
    case "parent":
      return "#/parent";
    case "loop":
      return "#/loop";
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
