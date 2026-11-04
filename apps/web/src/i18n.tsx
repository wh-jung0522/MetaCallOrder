import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "ko" | "en";
export type T = (ko: string, en: string) => string;
// For tables and for text kept in state, so it follows the switch instead of freezing in the language it was logged in.
export type Pair = readonly [ko: string, en: string];

const STORAGE_KEY = "lang";

function initialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "ko" ? "ko" : "en";
}

const LangContext = createContext<{ lang: Lang; setLang: (lang: Lang) => void }>({ lang: "en", setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = lang === "ko" ? "콜오더" : "CallOrder";
  }, [lang]);

  const choose = (next: Lang) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLang(next);
  };

  return <LangContext.Provider value={{ lang, setLang: choose }}>{children}</LangContext.Provider>;
}

export function useT() {
  const { lang, setLang } = useContext(LangContext);
  const t: T = (ko, en) => (lang === "ko" ? ko : en);
  return { t, lang, setLang };
}
