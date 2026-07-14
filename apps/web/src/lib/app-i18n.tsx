"use client";

import { createContext, useContext } from "react";
import { useStoredState } from "./use-stored-state";
import { common } from "./i18n/common";
import { settings } from "./i18n/settings";
import { knowledge } from "./i18n/knowledge";
import { inbox } from "./i18n/inbox";
import { wiki } from "./i18n/wiki";
import { about } from "./i18n/about";
import { tree } from "./i18n/tree";

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
    inbox: inbox[lang],
    wiki: wiki[lang],
    about: about[lang],
    tree: tree[lang],
  };
}

export type AppDict = ReturnType<typeof buildDict>;

const STORAGE_KEY = "skipper-lang";

function asAppLang(value: string): AppLang | null {
  return value === "en" || value === "it" || value === "fr" || value === "es" ? value : null;
}

function detectLang(): AppLang {
  if (typeof navigator === "undefined") return "en";
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const p of prefs) {
    const c = asAppLang((p || "").slice(0, 2).toLowerCase());
    if (c) return c;
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
  // "" means no explicit choice — the OS/browser language is in effect.
  const [stored, setStored] = useStoredState(STORAGE_KEY, "");
  const chosen = asAppLang(stored);
  const lang = chosen ?? detectLang();
  const explicit = chosen !== null;

  const setLang = (l: AppLang) => setStored(l);
  const clearLang = () => setStored("");

  return (
    <AppLangContext.Provider value={{ lang, setLang, explicit, clearLang, t: buildDict(lang) }}>
      {children}
    </AppLangContext.Provider>
  );
}

export function useT() {
  return useContext(AppLangContext);
}
