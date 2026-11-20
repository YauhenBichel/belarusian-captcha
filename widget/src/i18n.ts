// Interface strings (docs/DESIGN.md section 6.2). Only the interface changes with the language;
// the challenge itself stays Belarusian. A string missing from a language falls back to English,
// and the element that shows it gets lang="en", so a screen reader pronounces it correctly.

import be from './i18n/be.json' with { type: 'json' };
import beLatn from './i18n/be-Latn.json' with { type: 'json' };
import en from './i18n/en.json' with { type: 'json' };
import ru from './i18n/ru.json' with { type: 'json' };

export type Lang = 'be' | 'be-Latn' | 'ru' | 'en';
export type StringKey = keyof typeof en;

export const LANGS: readonly Lang[] = ['be', 'be-Latn', 'ru', 'en'];
export const DEFAULT_LANG: Lang = 'be';

const TABLES: Record<Lang, Partial<Record<string, string>>> = {
  be,
  'be-Latn': beLatn,
  ru,
  en,
};

export function parseLang(value: string | null | undefined): Lang {
  return LANGS.includes(value as Lang) ? (value as Lang) : DEFAULT_LANG;
}

/** The string and the language it is really in (its own, or "en" after a fallback). */
export function t(lang: Lang, key: StringKey): { text: string; lang: Lang } {
  const own = TABLES[lang][key];
  if (typeof own === 'string' && own) return { text: own, lang };
  return { text: en[key], lang: 'en' };
}
