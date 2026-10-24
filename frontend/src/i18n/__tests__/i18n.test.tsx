import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { en, pt } from '../messages';
import { translate, useI18n } from '../index';

let serverLanguage: string | null = null;
const saved: unknown[] = [];
vi.mock('../../api', () => ({
  getPreferences: async () => ({ language: serverLanguage }),
  savePreferences: async (prefs: unknown) => {
    saved.push(prefs);
    return prefs;
  },
}));

import I18nProvider from '../I18nProvider';
import LanguageSelector from '../../components/LanguageSelector';

const Probe = () => {
  const { t } = useI18n();
  return <p>{t('tabs.tasks')}</p>;
};

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  serverLanguage = null;
  saved.length = 0;
});

describe('messages', () => {
  it('has every key in both languages, none blank', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of [...Object.entries(en), ...Object.entries(pt)]) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(names(pt[key]), key).toEqual(names(en[key]));
    }
  });

  it('fills placeholders', () => {
    expect(translate('pt-BR', 'tabs.close', { label: 'bash' })).toBe(
      'Fechar aba bash',
    );
    expect(translate('en', 'tabs.close', { label: 'bash' })).toBe(
      'Close tab bash',
    );
  });
});

describe('I18nProvider', () => {
  it('defaults to Portuguese and saves a change on the server', async () => {
    render(
      <I18nProvider>
        <Probe />
        <LanguageSelector />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(screen.getByText('Tarefas')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('pt-BR');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Idioma'), {
        target: { value: 'en' },
      });
    });
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(saved).toEqual([{ language: 'en' }]);
    expect(document.documentElement.lang).toBe('en');
  });

  it('follows the language saved for the user on the server', async () => {
    serverLanguage = 'en';
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });
});

describe('errorMessage', () => {
  it('translates fixed backend messages and keeps the others', async () => {
    const { errorMessage } = await import('../../tasksApi');
    const fail = (detail: string) => ({ response: { data: { detail } } });
    document.documentElement.lang = 'pt-BR';
    expect(errorMessage(fail('Title is required'))).toBe(
      'O título é obrigatório',
    );
    expect(errorMessage(fail('Jira answered HTTP 400: x'))).toBe(
      'Jira answered HTTP 400: x',
    );
    document.documentElement.lang = 'en';
    expect(errorMessage(fail('Title is required'))).toBe('Title is required');
  });
});
