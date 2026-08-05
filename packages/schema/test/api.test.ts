import { describe, expect, it } from "vitest";

import episodeJson from "../../../content/episodes/ep001/episode.json";
import {
  EpisodeIndexSchema,
  EpisodeSchema,
  SpeakRequestSchema,
  SpeakResponseSchema,
  UnderstandRequestSchema,
  UnderstandResponseSchema,
  VisemeMarkSchema,
} from "../src/index";

describe("POST /understand IO", () => {
  it("round-trips a request", () => {
    const req = {
      episodeId: "ep001",
      checkpointId: "cp1",
      utterance: "pachcha",
      lang: "te" as const,
      expectIds: ["green", "leaf"],
    };
    expect(UnderstandRequestSchema.parse(req)).toEqual(req);
  });

  it("round-trips a praise hit, a retry miss, and a redirect", () => {
    const hit = { matchId: "green", action: "praise" as const };
    expect(UnderstandResponseSchema.parse(hit)).toEqual(hit);

    const miss = {
      matchId: null,
      reply: { text: "Almost! Look at the leaf again — pach-cha!" },
      action: "retry" as const,
    };
    expect(UnderstandResponseSchema.parse(miss)).toEqual(miss);

    const redirect = {
      matchId: null,
      reply: { text: "Let's look at the market together!" },
      action: "redirect" as const,
    };
    expect(UnderstandResponseSchema.parse(redirect)).toEqual(redirect);
  });

  it("rejects an off-contract action (the brain may not free-chat)", () => {
    const bad = { matchId: null, reply: { text: "hi!" }, action: "chat" };
    expect(UnderstandResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a response that omits matchId (must be explicit null)", () => {
    const bad = { action: "retry", reply: { text: "try again" } };
    expect(UnderstandResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a request with an unsupported lang", () => {
    const bad = {
      episodeId: "ep001",
      checkpointId: "cp1",
      utterance: "vert",
      lang: "fr",
      expectIds: ["green"],
    };
    expect(UnderstandRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("POST /speak IO", () => {
  it("round-trips a request and a marked response", () => {
    const req = { text: "అవును! ఆకు పచ్చ!", lang: "te" as const, voice: "chatterbox-te" };
    expect(SpeakRequestSchema.parse(req)).toEqual(req);

    const res = {
      audioUrl: "/media/cache/9f2a7c.mp3",
      marks: [
        { t: 0, viseme: "A" as const },
        { t: 120, viseme: "U" as const },
        { t: 260, viseme: "closed" as const },
        { t: 400, viseme: "smile" as const },
      ],
    };
    expect(SpeakResponseSchema.parse(res)).toEqual(res);
  });

  it("rejects visemes outside the design contract (no UW/FV)", () => {
    expect(VisemeMarkSchema.safeParse({ t: 0, viseme: "UW" }).success).toBe(
      false,
    );
    expect(VisemeMarkSchema.safeParse({ t: 0, viseme: "FV" }).success).toBe(
      false,
    );
    expect(
      SpeakResponseSchema.safeParse({
        audioUrl: "/media/cache/x.mp3",
        marks: [{ t: 10, viseme: "UW" }],
      }).success,
    ).toBe(false);
  });

  it("rejects negative or fractional mark times", () => {
    expect(VisemeMarkSchema.safeParse({ t: -5, viseme: "A" }).success).toBe(
      false,
    );
    expect(VisemeMarkSchema.safeParse({ t: 3.7, viseme: "A" }).success).toBe(
      false,
    );
  });
});

describe("GET /episodes IO", () => {
  it("round-trips an index derived from ep001", () => {
    const ep = EpisodeSchema.parse(episodeJson);
    const index = [{ id: ep.id, title: ep.title, langs: ep.langs }];
    expect(EpisodeIndexSchema.parse(index)).toEqual(index);
  });

  it("accepts an empty index and rejects a malformed entry", () => {
    expect(EpisodeIndexSchema.parse([])).toEqual([]);
    const bad = [{ id: "ep002", title: { en: "English only" }, langs: ["en"] }];
    expect(EpisodeIndexSchema.safeParse(bad).success).toBe(false);
  });
});
