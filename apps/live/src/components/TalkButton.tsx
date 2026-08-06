// Hold to talk. Not an always-open microphone.
//
// This runs in a child's bedroom. An always-live mic there is the wrong default
// no matter how good the on-device story is, so the only way the microphone
// opens is a hand held on this button, and the only way it stays open is that
// hand staying there. Release, drag off, alt-tab, or blur and it closes. The
// contract a parent can check in one sentence: teal means open, and teal only
// happens while something is pressing.
//
// Keyboard gets the same gesture (space/enter down opens, up closes) rather
// than a toggle, because a toggle is a different privacy promise.

import { useCallback, useRef } from "react";
import { useI18n } from "../i18n";
import { Bilingual } from "./Bilingual";
import "./TalkButton.css";

interface TalkButtonProps {
  /** True while the microphone is genuinely open — the one teal state. */
  listening: boolean;
  onPress: () => void;
  onRelease: () => void;
}

export function TalkButton({ listening, onPress, onRelease }: TalkButtonProps) {
  const { lang, tIn } = useI18n();
  // Guards the press/release pair: pointer and keyboard can both fire, a
  // pointer can leave and come back, and a release must never outnumber a press.
  const heldRef = useRef(false);

  const press = useCallback((): void => {
    if (heldRef.current) return;
    heldRef.current = true;
    onPress();
  }, [onPress]);

  const release = useCallback((): void => {
    if (!heldRef.current) return;
    heldRef.current = false;
    onRelease();
  }, [onRelease]);

  const key = listening ? "talk.listening" : "talk.hold";

  return (
    <button
      type="button"
      className={`talk-btn${listening ? " is-listening" : ""}`}
      data-action="talk.hold"
      data-listening={listening ? "true" : "false"}
      aria-label={tIn(lang, key)}
      aria-pressed={listening}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (e.key !== " " && e.key !== "Enter") return;
        // Space would scroll and Enter would re-fire as a click; this button
        // is a gesture, not an activation.
        e.preventDefault();
        press();
      }}
      onKeyUp={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        release();
      }}
      onBlur={release}
    >
      <span className="talk-btn-mic" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" focusable="false">
          <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
          <path d="M6 11a1 1 0 0 1 2 0 4 4 0 0 0 8 0 1 1 0 0 1 2 0 6 6 0 0 1-5 5.9V19h2a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h2v-2.1A6 6 0 0 1 6 11Z" />
        </svg>
      </span>
      <span className="talk-btn-wave" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <Bilingual k={key} />
    </button>
  );
}
