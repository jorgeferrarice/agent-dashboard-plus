import React, { useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  createGitConnection,
  deleteGitConnection,
  updateGitConnection,
} from '../../gitApi';
import type { GitConnection, GitProvider } from '../../gitApi';
import { errorMessage } from '../../tasksApi';
import { syncedAgo } from '../tasks/taskMeta';
import { fieldClass } from '../tasks/taskDraft';
import { useI18n } from '../../i18n';
import { PROVIDER_LABEL, PROVIDER_STYLE } from './gitMeta';

/** Where each host's token is created. */
const TOKEN_URL: Record<GitProvider, string> = {
  github: 'https://github.com/settings/tokens',
  bitbucket: 'https://id.atlassian.com/manage-profile/security/api-tokens',
};

/** Splits comma-separated workspace slugs as typed. */
const parseWorkspaces = (text: string) =>
  [...new Set(text.split(',').map((w) => w.trim()))].filter(Boolean);

/** Form to add a connection, or edit one when `editing` is set. */
const ConnectionForm: React.FC<{
  editing?: GitConnection;
  onDone: () => void;
  onCancel: () => void;
}> = ({ editing, onDone, onCancel }) => {
  const { t } = useI18n();
  const [provider, setProvider] = useState<GitProvider>(
    editing?.provider ?? 'github',
  );
  const [name, setName] = useState(editing?.name ?? '');
  const savedEmail = editing?.config.email ?? '';
  const savedWorkspaces = (editing?.config.workspaces ?? []).join(', ');
  const [email, setEmail] = useState(savedEmail);
  const [workspaces, setWorkspaces] = useState(savedWorkspaces);
  // Never prefilled: the saved token does not come back.
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bitbucket = provider === 'bitbucket';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const config = bitbucket
      ? { email: email.trim(), workspaces: parseWorkspaces(workspaces) }
      : {};
    try {
      if (editing) {
        const configChanged =
          bitbucket &&
          (email !== savedEmail ||
            parseWorkspaces(workspaces).join(',') !==
              parseWorkspaces(savedWorkspaces).join(','));
        await updateGitConnection(editing.id, {
          name,
          ...(configChanged ? { config } : {}),
          ...(secret ? { secret } : {}),
        });
      } else {
        await createGitConnection({ provider, name, config, secret });
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label={
        editing
          ? t('tasks.conn.edit', { name: editing.name })
          : t('tasks.conn.new')
      }
      className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4"
    >
      {!editing && (
        <label className="block text-xs text-slate-400">
          {t('git.conn.provider')}
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as GitProvider)}
            className={`mt-1 ${fieldClass}`}
          >
            {(['github', 'bitbucket'] as const).map((p) => (
              <option key={p} value={p}>
                {t(PROVIDER_LABEL[p])}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-xs text-slate-400">
        {t('tasks.conn.name')}
        <input
          required
          maxLength={60}
          value={name}
          placeholder={t('git.conn.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      {bitbucket && (
        <>
          <label className="block text-xs text-slate-400">
            {t('git.conn.email')}
            <input
              required
              type="email"
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              className={`mt-1 ${fieldClass}`}
            />
          </label>
          <label className="block text-xs text-slate-400">
            {t('git.conn.workspaces')}
            <input
              required
              value={workspaces}
              placeholder="my-team, side-project"
              onChange={(e) => setWorkspaces(e.target.value)}
              className={`mt-1 ${fieldClass}`}
            />
            <span className="mt-1 block text-slate-500">
              {t('git.conn.workspacesHelp')}
            </span>
          </label>
        </>
      )}
      <label className="block text-xs text-slate-400">
        {t(bitbucket ? 'git.conn.token.bitbucket' : 'git.conn.token.github')}
        <input
          type="password"
          autoComplete="off"
          required={!editing}
          value={secret}
          placeholder={editing ? t('tasks.conn.keepSecret') : ''}
          onChange={(e) => setSecret(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
        <span className="mt-1 block text-slate-500">
          {t(bitbucket ? 'git.conn.help.bitbucket' : 'git.conn.help.github')}{' '}
          <a
            href={TOKEN_URL[provider]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            {t('git.conn.createToken')}
          </a>{' '}
          {t('tasks.conn.secretNote')}
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
        >
          {t('tasks.cancel')}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
        >
          {busy
            ? t('tasks.conn.checking')
            : editing
              ? t('tasks.conn.save')
              : t('tasks.conn.connect')}
        </button>
      </div>
    </form>
  );
};

/**
 * Lists the user's GitHub and Bitbucket connections and adds,
 * edits, re-reads and removes them.
 */
const GitConnectionsModal: React.FC<{
  connections: GitConnection[];
  onClose: () => void;
  /** Called after a connection was added, changed or removed. */
  onChanged: () => void;
  onRefresh: (connectionId: number) => Promise<void>;
}> = ({ connections, onClose, onChanged, onRefresh }) => {
  const { t, language } = useI18n();
  // 'new', a connection ID being edited, or null.
  const [form, setForm] = useState<'new' | number | null>(
    connections.length === 0 ? 'new' : null,
  );
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (id: number) => {
    setError(null);
    try {
      await deleteGitConnection(id);
      setConfirmDelete(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const refresh = async (id: number) => {
    setRefreshing(id);
    try {
      await onRefresh(id);
    } finally {
      setRefreshing(null);
    }
  };

  const done = () => {
    setForm(null);
    onChanged();
  };

  return (
    <div
      className="app-root fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-connections-title"
        className="flex max-h-full w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        <header className="flex items-center border-b border-slate-800 px-5 py-3">
          <h3
            id="git-connections-title"
            className="text-lg font-bold text-slate-50"
          >
            {t('git.conn.title')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('tasks.conn.close')}
            className="ml-auto rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-50"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <p className="text-sm text-slate-400">{t('git.conn.intro')}</p>
          {connections.map((c) =>
            form === c.id ? (
              <ConnectionForm
                key={c.id}
                editing={c}
                onDone={done}
                onCancel={() => setForm(null)}
              />
            ) : (
              <div
                key={c.id}
                className="rounded-xl border border-slate-700 bg-slate-800 p-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PROVIDER_STYLE[c.provider]}`}
                  >
                    {t(PROVIDER_LABEL[c.provider])}
                  </span>
                  <span className="min-w-0 truncate font-semibold text-slate-100">
                    {c.name}
                  </span>
                  <div className="ml-auto flex shrink-0 gap-1">
                    <button
                      onClick={() => refresh(c.id)}
                      aria-label={t('tasks.conn.refresh', { name: c.name })}
                      title={t('git.conn.refreshTitle')}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-50"
                    >
                      <RefreshCw
                        size={14}
                        className={refreshing === c.id ? 'animate-spin' : ''}
                      />
                    </button>
                    <button
                      onClick={() => setForm(c.id)}
                      aria-label={t('tasks.conn.edit', { name: c.name })}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-50"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(c.id)}
                      aria-label={t('tasks.conn.remove', { name: c.name })}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-red-300"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {c.config.account && <>{c.config.account} · </>}
                  {t('git.conn.count', {
                    prs: c.pr_count,
                    commits: c.commit_count,
                  })}{' '}
                  · {syncedAgo(c.last_sync_at, t, language)}
                </p>
                {c.last_error && (
                  <p role="alert" className="mt-1 text-xs text-red-400">
                    {c.last_error}
                  </p>
                )}
                {confirmDelete === c.id && (
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    <span className="mr-auto text-slate-300">
                      {t('git.conn.confirmRemove')}
                    </span>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="rounded-md px-2 py-1 text-slate-400 hover:text-slate-100"
                    >
                      {t('tasks.conn.keep')}
                    </button>
                    <button
                      autoFocus
                      onClick={() => remove(c.id)}
                      className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-500"
                    >
                      {t('tasks.conn.removeButton')}
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {form === 'new' ? (
            <ConnectionForm onDone={done} onCancel={() => setForm(null)} />
          ) : (
            <button
              onClick={() => setForm('new')}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-600 px-3 py-2.5 text-sm text-slate-300 hover:border-accent-muted hover:text-slate-50"
            >
              <Plus size={14} /> {t('tasks.conn.add')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default GitConnectionsModal;
