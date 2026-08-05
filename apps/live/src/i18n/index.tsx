// Same shape as apps/web/src/i18n — typed keys, both dictionaries complete, and
// kid screens always render BOTH scripts (design rule: re-order languages,
// never hide one). The only addition here is `{token}` interpolation, which the
// live surface needs for "Show me {n} fingers!".

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import en from "./en.json";
import te from "./te.json";

export type Lang = "te" | "en";
export type I18nKey = keyof typeof en;
export type Values = Readonly<Record<string, string | number>>;

// Both dictionaries must cover every key — there is no partial-translation state.
const dicts: Record<Lang, Record<I18nKey, string>> = { en, te };

function interpolate(s: string, values: Values | undefined): string {
  if (!values) return s;
  return s.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = values[name];
    return v === undefined ? whole : String(v);
  });
}

export function translate(lang: Lang, key: I18nKey, values?: Values): string {
  return interpolate(dicts[lang][key] ?? dicts.en[key], values);
}

interface I18n {
  lang: Lang;
  other: Lang;
  setLang: (l: Lang) => void;
  /** Primary-language string for the current lang. */
  t: (key: I18nKey, values?: Values) => string;
  /** String in an explicit language (kid screens always show both scripts). */
  tIn: (lang: Lang, key: I18nKey, values?: Values) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function LangProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const value = useMemo<I18n>(
    () => ({
      lang,
      other: lang === "en" ? "te" : "en",
      setLang,
      t: (key, values) => translate(lang, key, values),
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
