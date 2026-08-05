import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EpisodeIndexSchema, EpisodeSchema, type UnderstandResponse } from "@chiku/schema";
import { createApp } from "../src/app";
import { RuleBrain } from "../src/providers/brain/rule";
import type { Brain } from "../src/providers/brain/types";

// Fixture media root (decoupled from content/episodes/, which is authored
// in parallel — see the M0 task split).
const FIXTURE_MEDIA = fileURLToPath(new URL("fixtures/media", import.meta.url));
const ORIGIN = "http://localhost:5173";

function makeApp(brain: Brain = new RuleBrain(FIXTURE_MEDIA)) {
  return createApp({ mediaDir: FIXTURE_MEDIA, allowedOrigin: ORIGIN, brain });
}

describe("GET /healthz", () => {
  it("returns 200 {ok:true}", async () => {
    const res = await makeApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /episodes", () => {
  it("returns a schema-valid EpisodeIndex built from disk", async () => {
    const res = await makeApp().request("/episodes");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const index = EpisodeIndexSchema.parse(body); // throws on drift
    expect(index).toEqual([
      {
        id: "ep001",
        title: { te: "రంగుల అడవి", en: "The Forest of Colours" },
        langs: ["te", "en"],
      },
      {
        id: "ep002",
        title: { te: "నీటి పాట", en: "The Water Song" },
        langs: ["te", "en"],
      },
    ]);
  });
});

describe("CORS origin lock", () => {
  it("echoes the allowed origin", async () => {
    const res = await makeApp().request("/healthz", {
      headers: { origin: ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("sends no CORS header for any other origin", async () => {
    const res = await makeApp().request("/healthz", {
      headers: { origin: "http://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /episodes/:id", () => {
  it("returns the full, schema-valid episode", async () => {
    const res = await makeApp().request("/episodes/ep001");
    expect(res.status).toBe(200);
    const ep = EpisodeSchema.parse(await res.json());
    expect(ep.id).toBe("ep001");
    expect(ep.segments).toHaveLength(2);
  });

  it("404s an unknown id and a traversal attempt", async () => {
    expect((await makeApp().request("/episodes/nope")).status).toBe(404);
    expect((await makeApp().request("/episodes/..%2F..%2Fetc")).status).toBe(404);
  });
});

describe("GET /media/episodes/:id/:file", () => {
  it("serves audio with the right content-type", async () => {
    const res = await makeApp().request("/media/episodes/ep001/cp1_ask_en.m4a");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("serves marks JSON", async () => {
    const res = await makeApp().request("/media/episodes/ep001/cp1_ask_en.marks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("404s missing files and traversal attempts", async () => {
    expect((await makeApp().request("/media/episodes/ep001/missing.m4a")).status).toBe(404);
    expect((await makeApp().request("/media/episodes/ep001/..%2Fepisode.json")).status).toBe(404);
    expect((await makeApp().request("/media/episodes/..%2Fep001/cp1_ask_en.m4a")).status).toBe(404);
  });
});

describe("POST /understand (§8 step 4)", () => {
  const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
    app.request("/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const valid = {
    episodeId: "ep001",
    checkpointId: "cp1",
    utterance: "paccha",
    lang: "te",
    expectIds: ["green"],
  };

  it("rejects an invalid body with 400", async () => {
    const res = await post(makeApp(), { utterance: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid request body");
  });

  it("RuleBrain praises a transliteration", async () => {
    const res = await post(makeApp(), valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matchId: "green", action: "praise" });
  });

  it("RuleBrain praises a synonym the client matcher would miss", async () => {
    const res = await post(makeApp(), { ...valid, utterance: "it is like emerald", lang: "en" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UnderstandResponse).action).toBe("praise");
  });

  it("RuleBrain retries an on-topic miss with a short warm line", async () => {
    const res = await post(makeApp(), { ...valid, utterance: "blue", lang: "en" });
    const body = (await res.json()) as UnderstandResponse;
    expect(body.action).toBe("retry");
    expect(body.matchId).toBeNull();
    expect(body.reply?.text.split(" ").length).toBeLessThanOrEqual(12);
  });

  it("RuleBrain redirects personal probes without engaging (§7)", async () => {
    const res = await post(makeApp(), { ...valid, utterance: "what is your name", lang: "en" });
    const body = (await res.json()) as UnderstandResponse;
    expect(body.action).toBe("redirect");
    expect(body.matchId).toBeNull();
  });

  it("502s when the brain dies — the client falls back locally", async () => {
    const dead: Brain = {
      understand: () => Promise.reject(new Error("boom")),
    };
    const res = await post(makeApp(dead), valid);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "brain-unavailable" });
  });

  it("clamps a praise whose matchId is not among expectIds to a retry", async () => {
    const rogue: Brain = {
      understand: () => Promise.resolve({ matchId: "purple", action: "praise" }),
    };
    const res = await post(makeApp(rogue), valid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnderstandResponse;
    expect(body.action).toBe("retry");
    expect(body.matchId).toBeNull();
  });
});

describe("POST /speak (contract wired, voice stubbed)", () => {
  it("rejects an invalid body with 400", async () => {
    const res = await makeApp().request("/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 501 for a valid body until M2", async () => {
    const res = await makeApp().request("/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", lang: "en", voice: "en-default" }),
    });
    expect(res.status).toBe(501);
  });
});

describe("per-IP rate limit", () => {
  it("returns 429 once the bucket is empty, per client key", async () => {
    const app = createApp({
      mediaDir: FIXTURE_MEDIA,
      allowedOrigin: ORIGIN,
      rateLimit: { capacity: 2, refillPerMinute: 0 },
    });
    const as = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

    expect((await app.request("/healthz", as("10.0.0.1"))).status).toBe(200);
    expect((await app.request("/healthz", as("10.0.0.1"))).status).toBe(200);
    const limited = await app.request("/healthz", as("10.0.0.1"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate limited" });

    // A different client still has its own bucket.
    expect((await app.request("/healthz", as("10.0.0.2"))).status).toBe(200);
  });
});
