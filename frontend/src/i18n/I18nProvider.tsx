import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getPreferences, savePreferences } from '../api';
import { DEFAULT_LANGUAGE, I18nContext, isLanguage, translate } from './index';
import type { Language } from './index';

const STORAGE_KEY = 'agentDashboard.language';

/** The language this browser used last, to show it at once. */
function loadStored(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage unavailable: use the default.
  }
  return DEFAULT_LANGUAGE;
}

function store(language: Language) {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage unavailable: the server copy is enough.
  }
}

/**
 * Provides the interface language. The user's choice is kept on
 * the server, so it follows them to every device; this browser
 * keeps a copy to show the right language before the server
 * answers.
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [language, setLanguageState] = useState<Language>(loadStored);

  useEffect(() => {
    let cancelled = false;
    getPreferences()
      .then((prefs) => {
        if (cancelled || !isLanguage(prefs.language)) return;
        setLanguageState(prefs.language);
        store(prefs.language);
      })
      .catch(() => {
        // Not logged in yet, or offline: keep the local choice.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    store(next);
    savePreferences({ language: next }).catch((err) =>
      console.error('Failed to save the language:', err),
    );
  }, []);

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (
        key: Parameters<typeof translate>[1],
        vars?: Record<string, string | number>,
      ) => translate(language, key, vars),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export default I18nProvider;
