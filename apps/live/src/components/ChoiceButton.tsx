// The tap answer. Always available, never a lesser path: with the camera off
// this IS the game, and with the camera on it is the escape hatch a frustrated
// child (or a dark room, or a broken tracker) needs.
//
// 112px minimum — comfortably past the 64px floor, because these get poked with
// a whole hand rather than a fingertip.

import { useI18n } from "../i18n";
import type { ActivityChoice } from "../activities/types";
import { Glyph } from "./Glyph";

interface ChoiceButtonProps {
  choice: ActivityChoice;
  onPick: (choice: ActivityChoice) => void;
  /** Briefly marked after a gentle miss — a wobble, never a red X. */
  nudged: boolean;
  disabled: boolean;
}

export function ChoiceButton({ choice, onPick, nudged, disabled }: ChoiceButtonProps) {
  const { lang, tIn } = useI18n();
  const label = tIn(lang, choice.labelKey, choice.labelValues);

  return (
    <button
      type="button"
      className={`choice${nudged ? " is-nudged" : ""}`}
      onClick={() => onPick(choice)}
      disabled={disabled}
      aria-label={label}
      data-choice={choice.id}
    >
      {choice.digit !== undefined ? (
        // Numeral + the same count as dots: a pre-reader counts the dots, an
        // older child reads the digit, and nobody has to read a word.
        <span className="choice-digit" aria-hidden="true">
          {choice.digit}
          <span className="choice-dots">
            {Array.from({ length: choice.digit }, (_, i) => (
              <span key={i} className="choice-dot" />
            ))}
          </span>
        </span>
      ) : choice.glyph ? (
        <Glyph name={choice.glyph} />
      ) : null}
    </button>
  );
}
