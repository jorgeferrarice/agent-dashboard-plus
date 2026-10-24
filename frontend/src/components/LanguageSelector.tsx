import React from 'react';
import { LANGUAGES, LANGUAGE_NAMES, useI18n } from '../i18n';
import type { Language } from '../i18n';

/** Picks the interface language; the choice follows the user. */
const LanguageSelector: React.FC = () => {
  const { language, setLanguage, t } = useI18n();
  return (
    <select
      aria-label={t('settings.language')}
      value={language}
      onChange={(e) => setLanguage(e.target.value as Language)}
      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
    >
      {LANGUAGES.map((l) => (
        <option key={l} value={l}>
          {LANGUAGE_NAMES[l]}
        </option>
      ))}
    </select>
  );
};

export default LanguageSelector;
