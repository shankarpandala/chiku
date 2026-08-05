// The one marigold primary action per screen (design system). 64px floor,
// bilingual label, and a physical press: the shadow collapses so a child who
// cannot read still gets confirmation that the tap landed.

import type { ReactNode } from "react";
import type { I18nKey } from "../i18n";
import { Bilingual } from "./Bilingual";

interface BigButtonProps {
  k: I18nKey;
  onClick: () => void;
  /** "primary" is marigold; "quiet" is the sand alternative (never two golds). */
  tone?: "primary" | "quiet";
  disabled?: boolean;
  children?: ReactNode;
}

export function BigButton({ k, onClick, tone = "primary", disabled = false, children }: BigButtonProps) {
  return (
    <button
      type="button"
      className={`big-btn big-btn-${tone}`}
      onClick={onClick}
      disabled={disabled}
      data-action={k}
    >
      {children}
      <Bilingual k={k} />
    </button>
  );
}
