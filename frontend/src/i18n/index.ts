import { createContext, useContext } from 'react';
import { en, pt } from './messages';

/** Interface languages, as BCP 47 tags (also used for dates). */
export const LANGUAGES = ['pt-BR', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

export type MessageKey = keyof typeof en;
/** Values for `{name}` placeholders in a message. */
export type MessageVars = Record<string, string | number>;

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = {
  en,
  'pt-BR': pt,
};

/** Names of the languages, each in its own language. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
};

export const isLanguage = (value: unknown): value is Language =>
  LANGUAGES.includes(value as Language);

/**
 * A message in a language, with `{name}` placeholders filled.
 * A key missing from the dictionary falls back to English, then
 * to the key itself.
 */
export function translate(
  language: Language,
  key: MessageKey,
  vars?: MessageVars,
): string {
  const text = DICTIONARIES[language][key] ?? en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name) =>
    name in vars ? String(vars[name]) : all,
  );
}

export interface I18n {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, vars?: MessageVars) => string;
}

// Without a provider (tests, a component rendered alone) the
// text is English; the app's provider defaults to pt-BR.
export const I18nContext = createContext<I18n>({
  language: 'en',
  setLanguage: () => {},
  t: (key, vars) => translate('en', key, vars),
});

/** The interface language and its translator, `t(key, vars)`. */
export const useI18n = () => useContext(I18nContext);
