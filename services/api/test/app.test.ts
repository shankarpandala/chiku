import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EpisodeIndexSchema } from "@chiku/schema";
import { createApp } from "../src/app";

// Fixture media root (decoupled from content/episodes/, which is authored
// in parallel — see the M0 task split).
const FIXTURE_MEDIA = fileURLToPath(new URL("fixtures/media", import.meta.url));
const ORIGIN = "http://localhost:5173";

function makeApp() {
  return createApp({ mediaDir: FIXTURE_MEDIA, allowedOrigin: ORIGIN });
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

describe("POST /understand (contract wired, brain stubbed)", () => {
  const valid = {
    checkpointId: "cp1",
    utterance: "paccha",
    lang: "te",
    expectIds: ["green"],
  };

  it("rejects an invalid body with 400", async () => {
    const res = await makeApp().request("/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ utterance: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid request body");
  });

  it("returns 501 for a valid body until M2", async () => {
    const res = await makeApp().request("/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not implemented until M2" });
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
