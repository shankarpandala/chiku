// Device-local playback volume (the grown-up strip's slider). Applied when a
// line starts — good enough for M3; live mid-line volume needs rig support.

import { defaultCreateAudio, type RigAudio } from "@chiku/rig";

const VOLUME_KEY = "chiku.volume";
let volume: number | null = null;

export function getVolume(): number {
  if (volume !== null) return volume;
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const n = raw === null ? NaN : Number(raw);
    volume = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.8; // §7 default
  } catch {
    volume = 0.8;
  }
  return volume;
}

export function setVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  try {
    window.localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // in-memory value still applies
  }
}

/** Rig audio factory that honors the device volume at line start. */
export function createVolumeAudio(url: string): RigAudio | null {
  const audio = defaultCreateAudio(url);
  const el = audio?.element;
  if (typeof HTMLMediaElement !== "undefined" && el instanceof HTMLMediaElement) {
    el.volume = getVolume();
  }
  return audio;
}
