import { describe, expect, it } from "vitest";
import { parseHash, routeHash, type Route } from "../src/router";

describe("hash router", () => {
  const cases: Array<[string, Route]> = [
    ["", { name: "home" }],
    ["#/", { name: "home" }],
    ["#/play/ep001", { name: "player", episodeId: "ep001" }],
    ["#/stage", { name: "stage" }],
    ["#/mic/AB7K", { name: "mic", code: "AB7K" }],
    ["#/mic/ab7k", { name: "mic", code: "AB7K" }], // QR scanners may lowercase
    ["#/parent", { name: "parent" }],
    ["#/loop", { name: "loop" }],
    ["#/mic", { name: "home" }], // mic without a code is meaningless
    ["#/garbage/x", { name: "home" }],
  ];

  it.each(cases)("parses %s", (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it("round-trips every route through routeHash", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "player", episodeId: "ep001" },
      { name: "stage" },
      { name: "mic", code: "AB7K" },
      { name: "parent" },
      { name: "loop" },
    ];
    for (const r of routes) expect(parseHash(routeHash(r))).toEqual(r);
  });
});
