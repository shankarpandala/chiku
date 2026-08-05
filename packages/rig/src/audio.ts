// Default audio + amplitude drivers for speak(). Both are injectable via
// RigOptions so tests (and non-browser hosts) can substitute fakes; every
// factory returns null when the platform lacks the capability, and speak()
// degrades one level per the §6 chain: marks > amplitude > viseme cycle.

import type { AmplitudeSource, RigAudio } from "./types";

export function defaultCreateAudio(url: string): RigAudio | null {
  if (typeof Audio === "undefined") return null;
  const el = new Audio(url);
  el.preload = "auto";
  return {
    play: () => el.play(),
    pause: () => {
      el.pause();
    },
    get currentTime() {
      return el.currentTime;
    },
    addEventListener: (type, listener) => {
      el.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      el.removeEventListener(type, listener);
    },
    element: el,
  };
}

interface AudioContextLike {
  createMediaElementSource(el: HTMLMediaElement): { connect(node: unknown): void };
  createAnalyser(): {
    fftSize: number;
    frequencyBinCount: number;
    getByteTimeDomainData(buf: Uint8Array): void;
    connect(node: unknown): void;
  };
  destination: unknown;
  close(): Promise<void>;
}

/** WebAudio RMS sampler over the playing element — the §6 amplitude fallback. */
export function defaultCreateAmplitude(audio: RigAudio): AmplitudeSource | null {
  const g = globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  const el = audio.element;
  if (Ctx === undefined || typeof HTMLMediaElement === "undefined" || !(el instanceof HTMLMediaElement)) {
    return null;
  }
  try {
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    return {
      sample: () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const d = (v - 128) / 128;
          sum += d * d;
        }
        return Math.sqrt(sum / buf.length);
      },
      dispose: () => {
        void ctx.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
