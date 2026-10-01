import { useCallback } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { ar, type Dict } from './ar';
import { en } from './en';

export type Lang = 'ar' | 'en';
export type Theme = 'dark' | 'light';

const dicts: Record<Lang, Dict> = { ar, en };

/** Per-device preferences. Storage can be unavailable (private mode) — the app still works with defaults. */
const safeStorage = createJSONStorage(() => {
  try {
    const k = '__t';
    localStorage.setItem(k, k);
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

interface Prefs {
  lang: Lang;
  theme: Theme;
  /** Time-alert sounds on this device (e.g. on at the cashier PC, off on a waiter tablet). */
  sound: boolean;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  setSound: (on: boolean) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      lang: 'ar',
      theme: 'light',
      sound: true,
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setSound: (sound) => set({ sound }),
    }),
    {
      name: 'lounge-prefs',
      storage: safeStorage,
      partialize: (s) => ({ lang: s.lang, theme: s.theme, sound: s.sound }) as Prefs,
      // v1: the shop's look became red & white. Devices saved on the old dark default switch once;
      // anyone can still pick dark from the user menu afterwards. (public/prefs.js mirrors this.)
      version: 1,
      migrate: (persisted, version) => (version < 1 ? { ...(persisted as Prefs), theme: 'light' } : persisted) as Prefs,
    },
  ),
);

export function applyDocumentPrefs(lang: Lang, theme: Theme) {
  const el = document.documentElement;
  el.lang = lang;
  el.dir = lang === 'ar' ? 'rtl' : 'ltr';
  el.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#070707' : '#ffffff');
}

type Leaves<T, P extends string = ''> = {
  [K in keyof T & (string | number)]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends Record<string | number, unknown>
      ? Leaves<T[K], `${P}${K}.`>
      : never;
}[keyof T & (string | number)];

export type TKey = Leaves<Dict>;
export type TVars = Record<string, string | number>;

export function translate(lang: Lang, key: string, vars?: TVars): string {
  let node: unknown = dicts[lang];
  const parts = key.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!node || typeof node !== 'object') {
      node = undefined;
      break;
    }
    const rec = node as Record<string, unknown>;
    // Some keys contain dots themselves (event types such as "events.session.started").
    const rest = parts.slice(i).join('.');
    if (i < parts.length - 1 && typeof rec[rest] === 'string') {
      node = rec[rest];
      break;
    }
    node = rec[parts[i]!];
  }
  let str = typeof node === 'string' ? node : lang !== 'en' ? translate('en', key) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
}

export function useT() {
  const lang = usePrefs((s) => s.lang);
  const t = useCallback((key: TKey, vars?: TVars) => translate(lang, key, vars), [lang]);
  /** For dynamic keys coming from data (station types, event types, error codes). */
  const tk = useCallback(
    (group: 'types' | 'tiers' | 'modes' | 'roles' | 'events' | 'errors' | 'status', key: string, fallback?: string) => {
      const out = translate(lang, `${group}.${key}`);
      return out === `${group}.${key}` ? (fallback ?? key) : out;
    },
    [lang],
  );
  return { t, tk, lang };
}

/** Locale used for Intl: Latin digits keep money and timers readable and consistent. */
export const intlLocale = (lang: Lang) => (lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB');
