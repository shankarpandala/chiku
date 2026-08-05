import { describe, expect, it } from "vitest";

import episodeJson from "../../../content/episodes/ep001/episode.json";
import {
  CheckpointSegmentSchema,
  EpisodeSchema,
  type CheckpointSegment,
} from "../src/index";

const raw: unknown = episodeJson;

// --- fixtures ---------------------------------------------------------------

const validCheckpoint = () => ({
  type: "checkpoint" as const,
  id: "cpX",
  ask: {
    audio: { te: "cpX_ask_te.mp3", en: "cpX_ask_en.mp3" },
    marks: { te: "cpX_ask_te.marks.json", en: "cpX_ask_en.marks.json" },
  },
  listenMs: 6000,
  expect: [
    {
      id: "green",
      match: ["green", "paccha", "pachcha"],
      praise: {
        audio: { te: "cpX_praise_te.mp3", en: "cpX_praise_en.mp3" },
      },
    },
  ],
  onMiss: {
    retryAudio: "cpX_retry",
    maxRetries: 1,
    fallbackAudio: "lets_say_together",
  },
  escalate: true,
});

const validEpisode = () => ({
  id: "epX",
  title: { te: "శీర్షిక", en: "Title" },
  langs: ["te", "en"],
  segments: [{ type: "video" as const, src: "seg1.mp4" }, validCheckpoint()],
});

// --- ep001 parses -----------------------------------------------------------

describe("content/episodes/ep001/episode.json", () => {
  it("parses with the Episode schema", () => {
    const ep = EpisodeSchema.parse(raw);
    expect(ep.id).toBe("ep001");
    expect(ep.title.en).toBe("Colours at the Market");
    expect(ep.title.te).toBe("సంతలో రంగులు");
    expect(ep.langs).toEqual(["te", "en"]);
  });

  it("has 4 checkpoints, opens and closes on video, never two checkpoints adjacent", () => {
    const ep = EpisodeSchema.parse(raw);
    const checkpoints = ep.segments.filter(
      (s): s is CheckpointSegment => s.type === "checkpoint",
    );
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.map((c) => c.id)).toEqual(["cp1", "cp2", "cp3", "cp4"]);

    expect(ep.segments[0]?.type).toBe("video");
    expect(ep.segments[ep.segments.length - 1]?.type).toBe("video");
    for (let i = 1; i < ep.segments.length; i += 1) {
      const prev = ep.segments[i - 1];
      const cur = ep.segments[i];
      expect(prev?.type === "checkpoint" && cur?.type === "checkpoint").toBe(
        false,
      );
    }
  });

  it("keeps Latin transliterations of Telugu answers as normal match members", () => {
    const ep = EpisodeSchema.parse(raw);
    const cp1 = ep.segments.find(
      (s): s is CheckpointSegment => s.type === "checkpoint" && s.id === "cp1",
    );
    const green = cp1?.expect.find((e) => e.id === "green");
    expect(green?.match).toEqual(
      expect.arrayContaining(["green", "paccha", "pachcha", "పచ్చ"]),
    );

    const cp2 = ep.segments.find(
      (s): s is CheckpointSegment => s.type === "checkpoint" && s.id === "cp2",
    );
    const three = cp2?.expect.find((e) => e.id === "three");
    expect(three?.match).toEqual(
      expect.arrayContaining(["three", "moodu", "మూడు"]),
    );
  });

  it("every checkpoint has a full miss path and both praise languages", () => {
    const ep = EpisodeSchema.parse(raw);
    for (const seg of ep.segments) {
      if (seg.type !== "checkpoint") continue;
      expect(seg.listenMs).toBeGreaterThan(0);
      expect(seg.onMiss.fallbackAudio.length).toBeGreaterThan(0);
      expect(seg.onMiss.maxRetries).toBeGreaterThanOrEqual(1);
      for (const ans of seg.expect) {
        expect(ans.praise.audio.te.length).toBeGreaterThan(0);
        expect(ans.praise.audio.en.length).toBeGreaterThan(0);
      }
    }
  });
});

// --- representative invalid payloads ----------------------------------------

describe("Episode schema rejections", () => {
  it("rejects a negative listenMs", () => {
    const cp = { ...validCheckpoint(), listenMs: -500 };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(false);

    const ep = { ...validEpisode(), segments: [cp] };
    expect(EpisodeSchema.safeParse(ep).success).toBe(false);
  });

  it("rejects a checkpoint whose ask audio is missing te", () => {
    const cp = {
      ...validCheckpoint(),
      ask: { audio: { en: "cpX_ask_en.mp3" } },
    };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(false);
  });

  it("rejects half-localized marks (te and en time differently)", () => {
    const base = validCheckpoint();
    const cp = { ...base, ask: { audio: base.ask.audio, marks: { en: "cpX_ask_en.marks.json" } } };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(false);
  });

  it("rejects an unknown segment type", () => {
    const ep = {
      ...validEpisode(),
      segments: [{ type: "quiz", src: "seg1.mp4" }],
    };
    expect(EpisodeSchema.safeParse(ep).success).toBe(false);
  });

  it("rejects an unsupported language", () => {
    const ep = { ...validEpisode(), langs: ["te", "fr"] };
    expect(EpisodeSchema.safeParse(ep).success).toBe(false);
  });

  it("rejects a checkpoint with an empty expect list", () => {
    const cp = { ...validCheckpoint(), expect: [] };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(false);
  });

  it("rejects unknown keys in authored content (strict)", () => {
    const cp = { ...validCheckpoint(), bonusPoints: 100 };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(false);
  });

  it("accepts a checkpoint without marks (optional until rendered)", () => {
    const base = validCheckpoint();
    const cp = { ...base, ask: { audio: base.ask.audio } };
    expect(CheckpointSegmentSchema.safeParse(cp).success).toBe(true);
  });
});
