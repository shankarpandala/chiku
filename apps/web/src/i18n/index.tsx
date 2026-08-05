import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import en from "./en.json";
import te from "./te.json";

export type Lang = "te" | "en";
export type I18nKey = keyof typeof en;

// Both dictionaries must cover every key — the design rule is "re-order
// languages, never hide one", so there is no partial-translation state.
const dicts: Record<Lang, Record<I18nKey, string>> = { en, te };

export function translate(lang: Lang, key: I18nKey): string {
  return dicts[lang][key] ?? dicts.en[key];
}

interface I18n {
  lang: Lang;
  other: Lang;
  setLang: (l: Lang) => void;
  /** Primary-language string for the current lang. */
  t: (key: I18nKey) => string;
  /** String in an explicit language (kid screens always show both scripts). */
  tIn: (lang: Lang, key: I18nKey) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function LangProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const value = useMemo<I18n>(
    () => ({
      lang,
      other: lang === "en" ? "te" : "en",
      setLang,
      t: (key) => translate(lang, key),
      tIn: translate,
    }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <LangProvider>");
  return ctx;
}
