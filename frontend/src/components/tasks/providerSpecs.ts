import type { ProviderName } from '../../tasksApi';
import type { MessageKey } from '../../i18n';

/** A setting a connection form asks for. Text is given as
 *  message keys; example values (URLs, emails) as they are. */
export interface SpecField {
  key: string;
  label: MessageKey;
  /** An example value, shown as it is. */
  placeholder?: string;
  /** A translated hint, when there is no example value. */
  placeholderKey?: MessageKey;
  type?: 'text' | 'email' | 'url';
}

/** What a connection form shows for one tracker. */
export interface ProviderSpec {
  label: MessageKey;
  fields: SpecField[];
  secretLabel: MessageKey;
  /** How to get the token, in one sentence. */
  secretHelp: MessageKey;
  secretHelpUrl?: string;
  /** Shown as a warning on the form. */
  note?: MessageKey;
  /** What projects are called in the filters, e.g. "Project keys". */
  projectsLabel: MessageKey;
  /** Name of the tracker's own query language, e.g. "JQL";
   *  absent when it has none the dashboard can pass on. */
  queryLabel?: MessageKey;
  queryPlaceholder?: MessageKey;
}

/** Trackers the dashboard can connect to, in menu order. */
export const PROVIDER_SPECS: Partial<Record<ProviderName, ProviderSpec>> = {
  jira: {
    label: 'tasks.spec.jira',
    fields: [
      {
        key: 'site',
        label: 'tasks.spec.jira.site',
        placeholder: 'https://your-team.atlassian.net',
        type: 'url',
      },
      {
        key: 'email',
        label: 'tasks.spec.jira.email',
        placeholder: 'you@example.com',
        type: 'email',
      },
    ],
    secretLabel: 'tasks.spec.jira.secret',
    secretHelp: 'tasks.spec.jira.help',
    secretHelpUrl:
      'https://id.atlassian.com/manage-profile/security/api-tokens',
    projectsLabel: 'tasks.spec.jira.projects',
    queryLabel: 'tasks.spec.jira.query',
    queryPlaceholder: 'tasks.spec.jira.queryPlaceholder',
  },
  shortcut: {
    label: 'tasks.spec.shortcut',
    fields: [],
    secretLabel: 'tasks.spec.shortcut.secret',
    secretHelp: 'tasks.spec.shortcut.help',
    secretHelpUrl: 'https://app.shortcut.com/settings/account/api-tokens',
    projectsLabel: 'tasks.spec.shortcut.projects',
    queryLabel: 'tasks.spec.shortcut.query',
    queryPlaceholder: 'tasks.spec.shortcut.queryPlaceholder',
  },
  huly: {
    label: 'tasks.spec.huly',
    fields: [
      {
        key: 'url',
        label: 'tasks.spec.huly.url',
        placeholder: 'https://huly.example.com',
        type: 'url',
      },
      {
        key: 'workspace',
        label: 'tasks.spec.huly.workspace',
        placeholderKey: 'tasks.spec.huly.workspacePlaceholder',
      },
      {
        key: 'email',
        label: 'tasks.spec.huly.email',
        placeholder: 'you@example.com',
        type: 'email',
      },
    ],
    secretLabel: 'tasks.spec.huly.secret',
    secretHelp: 'tasks.spec.huly.help',
    note: 'tasks.spec.huly.note',
    projectsLabel: 'tasks.spec.huly.projects',
  },
};
