// Every kid-facing string appears in both scripts (§9). The primary language is
// the loud one; the other language sits under it, same string, smaller.

import { useI18n, type I18nKey, type Values } from "../i18n";

interface BilingualProps {
  k: I18nKey;
  values?: Values;
  className?: string;
  /** Render as a single line (primary then other, inline) rather than stacked. */
  inline?: boolean;
}

export function Bilingual({ k, values, className, inline = false }: BilingualProps) {
  const { lang, other, tIn } = useI18n();
  return (
    <span className={`bi${inline ? " bi-inline" : ""}${className ? ` ${className}` : ""}`}>
      <span className={lang === "te" ? "te" : ""}>{tIn(lang, k, values)}</span>
      <span className={`bi-other${other === "te" ? " te" : ""}`}>{tIn(other, k, values)}</span>
    </span>
  );
}
