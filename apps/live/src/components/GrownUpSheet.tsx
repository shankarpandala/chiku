// The grown-up surface. Everything on it is a decision a child must not make.
//
// WHY THIS EXISTS. The cloud-recognition consent used to sit on the camera-ask
// screen, behind a 2s hold. That screen is the one the child is on ALONE, every
// single session — it is the second thing they see — and a 2s hold is inside a
// six-year-old's patience on the first attempt. So the strongest privacy
// decision in the app was sitting on the child's main path behind a lock the
// child beats. Consent has to be adult-shaped, which means: off the child's
// route entirely, reached deliberately, and held long enough that boredom wins.
//
// Nothing here is hidden from the child by obscurity — the corner control is
// visible, and the wording stays the honest wording. It is gated by patience,
// which is the only lock that works on this age group and does not also lock
// out the grown-up.
//
// The session limit lives here too, for the same reason: §9.5's cap is only a
// cap if the person it applies to cannot raise it.

import { useEffect, useRef } from "react";
import { Bilingual } from "./Bilingual";
import { GROWNUP_CONSENT_HOLD_MS, HoldButton } from "./HoldButton";
import { LIMIT_STEP_MIN, MAX_LIMIT_MIN, MIN_LIMIT_MIN } from "../session/cap";
import { useI18n } from "../i18n";

interface GrownUpSheetProps {
  onClose: () => void;
  /** Current cloud-recognition state (settings/cloudEars). */
  cloudEars: boolean;
  /**
   * Whether the trade is worth offering at all. False when this browser has
   * local speech: nobody should be nudged into sending a child's voice away to
   * buy something they already have.
   */
  showCloudEars: boolean;
  onToggleCloudEars: () => void;
  limitMin: number;
  onLimitChange: (min: number) => void;
}

export function GrownUpSheet({
  onClose,
  cloudEars,
  showCloudEars,
  onToggleCloudEars,
  limitMin,
  onLimitChange,
}: GrownUpSheetProps) {
  const { lang, other, tIn } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape closes, and focus moves in so a keyboard user is not left behind the
  // overlay. No focus trap: this is a short sheet over a single-screen app, and
  // a trap that goes wrong strands the one person who needs it most.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const both = (k: Parameters<typeof tIn>[1]): string => `${tIn(lang, k)} · ${tIn(other, k)}`;

  return (
    <div className="grownup-backdrop" data-testid="grownup-sheet" onClick={onClose}>
      <div
        className="grownup-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={both("grownup.title")}
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="grownup-heading">
          <Bilingual k="grownup.title" inline />
        </h2>

        <p className="live-promise">
          <Bilingual k="camera.promise" />
        </p>

        {/* --- the session cap ------------------------------------------- */}
        <section className="grownup-block">
          <p className="grownup-label">
            <Bilingual k="grownup.limitLabel" inline />
          </p>
          <div className="grownup-stepper">
            <button
              type="button"
              className="grownup-step"
              data-action="grownup.limitLess"
              disabled={limitMin <= MIN_LIMIT_MIN}
              aria-label={both("grownup.limitLess")}
              onClick={() => onLimitChange(limitMin - LIMIT_STEP_MIN)}
            >
              −
            </button>
            <span className="grownup-limit-value" data-limit={limitMin}>
              {tIn(lang, "grownup.limitValue", { n: limitMin })}
            </span>
            <button
              type="button"
              className="grownup-step"
              data-action="grownup.limitMore"
              disabled={limitMin >= MAX_LIMIT_MIN}
              aria-label={both("grownup.limitMore")}
              onClick={() => onLimitChange(limitMin + LIMIT_STEP_MIN)}
            >
              +
            </button>
          </div>
          <p className="live-promise">
            <Bilingual k="grownup.limitNote" />
          </p>
        </section>

        {/* --- cloud ears -------------------------------------------------
            Same honest wording it has always had; only the door changed. */}
        {showCloudEars && (
          <section className="grownup-block cloud-ears">
            <p className="live-promise">
              <Bilingual k={cloudEars ? "cloud.explainOn" : "cloud.explainOff"} />
            </p>
            <HoldButton
              holdMs={GROWNUP_CONSENT_HOLD_MS}
              label={both(cloudEars ? "cloud.holdOff" : "cloud.holdOn")}
              onHeld={onToggleCloudEars}
            />
          </section>
        )}

        <button
          type="button"
          className="live-quiet grownup-close"
          data-action="grownup.close"
          onClick={onClose}
        >
          <Bilingual k="grownup.close" inline />
        </button>
      </div>
    </div>
  );
}
