"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { common } from "./i18n/common";
import { settings } from "./i18n/settings";
import { knowledge } from "./i18n/knowledge";
import { wiki } from "./i18n/wiki";
import { modules } from "./i18n/modules";
import { tree } from "./i18n/tree";
import { dev } from "./i18n/dev";
import { anatomize } from "./i18n/anatomize";

// App-wide localization (EN/IT/FR/ES). Resolution order: the language chosen
// in Settings (localStorage) wins; otherwise the OS/browser language;
// otherwise English. Dictionaries live in ./i18n/<area>.ts — one module per
// surface so areas evolve independently.

export type AppLang = "en" | "it" | "fr" | "es";

export const APP_LANGS: { code: AppLang; label: string; name: string; flag: string }[] = [
  { code: "en", label: "ENG", name: "English", flag: "🇬🇧" },
  { code: "it", label: "ITA", name: "Italiano", flag: "🇮🇹" },
  { code: "fr", label: "FRA", name: "Français", flag: "🇫🇷" },
  { code: "es", label: "ESP", name: "Español", flag: "🇪🇸" },
];

function buildDict(lang: AppLang) {
  return {
    common: common[lang],
    settings: settings[lang],
    knowledge: knowledge[lang],
    wiki: wiki[lang],
    modules: modules[lang],
    tree: tree[lang],
    dev: dev[lang],
    anatomize: anatomize[lang],
  };
}

export type AppDict = ReturnType<typeof buildDict>;

const STORAGE_KEY = "nestbrain-lang";

function detectLang(): AppLang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "it" || saved === "fr" || saved === "es") return saved;
  } catch {}
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const p of prefs) {
    const c = (p || "").slice(0, 2).toLowerCase();
    if (c === "it" || c === "fr" || c === "es" || c === "en") return c as AppLang;
  }
  return "en";
}

const AppLangContext = createContext<{
  lang: AppLang;
  setLang: (l: AppLang) => void;
  /** "auto" when no explicit choice was saved (OS language in effect). */
  explicit: boolean;
  clearLang: () => void;
  t: AppDict;
}>({
  lang: "en",
  setLang: () => {},
  explicit: false,
  clearLang: () => {},
  t: buildDict("en"),
});

export function AppLangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<AppLang>("en");
  const [explicit, setExplicit] = useState(false);

  useEffect(() => {
    setLangState(detectLang());
    try {
      setExplicit(localStorage.getItem(STORAGE_KEY) !== null);
    } catch {}
  }, []);

  const setLang = (l: AppLang) => {
    setLangState(l);
    setExplicit(true);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {}
  };

  const clearLang = () => {
    setExplicit(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setLangState(detectLang());
  };

  return (
    <AppLangContext.Provider value={{ lang, setLang, explicit, clearLang, t: buildDict(lang) }}>
      {children}
    </AppLangContext.Provider>
  );
}

export function useT() {
  return useContext(AppLangContext);
}
