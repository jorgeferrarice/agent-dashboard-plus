import React, { useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  COLUMNS,
  COLUMN_LABELS,
  createConnection,
  deleteConnection,
  errorMessage,
  getStatusColumns,
  updateConnection,
} from '../../tasksApi';
import type {
  Column,
  Connection,
  ProviderName,
  StatusColumn,
} from '../../tasksApi';
import { PROVIDER_SPECS } from './providerSpecs';
import { SOURCE_LABEL, SOURCE_STYLE, syncedAgo } from './taskMeta';
import { useI18n } from '../../i18n';
import { fieldClass } from './taskDraft';

interface ConnectionsModalProps {
  connections: Connection[];
  onClose: () => void;
  /** Called after a connection was added, changed or removed. */
  onChanged: () => void;
  onRefresh: (connectionId: number) => Promise<void>;
}

const PROVIDERS = Object.keys(PROVIDER_SPECS) as ProviderName[];

/** Form to add a connection, or edit one when `editing` is set. */
const ConnectionForm: React.FC<{
  editing?: Connection;
  onDone: () => void;
  onCancel: () => void;
}> = ({ editing, onDone, onCancel }) => {
  const { t } = useI18n();
  const [provider, setProvider] = useState<ProviderName>(
    editing?.provider ?? PROVIDERS[0],
  );
  const spec = PROVIDER_SPECS[provider]!;
  const [name, setName] = useState(editing?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      spec.fields.map((f) => [f.key, editing?.config[f.key] ?? '']),
    ),
  );
  const [secret, setSecret] = useState('');
  const saved = editing?.filters ?? {};
  const initialFilters = {
    assignee: String(saved.assignee ?? 'me'),
    projects: ((saved.projects as string[] | undefined) ?? []).join(', '),
    done_days: String(saved.done_days ?? 14),
    query: String(saved.query ?? ''),
  };
  const [filters, setFilters] = useState(initialFilters);
  const setFilter = (key: keyof typeof filters, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  // The connection's statuses, and the column picked for each.
  const [statuses, setStatuses] = useState<StatusColumn[] | null>(null);
  const [columns, setColumns] = useState<Record<string, Column>>({});
  // Keyed by ID: a reload of the list while editing must not
  // wipe the choices being made.
  const editingId = editing?.id;
  useEffect(() => {
    if (editingId === undefined) return;
    getStatusColumns(editingId)
      .then((found) => {
        setStatuses(found);
        setColumns(Object.fromEntries(found.map((st) => [st.name, st.column])));
      })
      .catch(() => setStatuses([]));
  }, [editingId]);
  /** Only the choices that differ from the automatic column. */
  const mapping = Object.fromEntries(
    (statuses ?? [])
      .filter((st) => columns[st.name] && columns[st.name] !== st.auto_column)
      .map((st) => [st.name, columns[st.name]]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const configChanged = spec.fields.some(
          (f) => config[f.key] !== (editing.config[f.key] ?? ''),
        );
        const filtersChanged =
          JSON.stringify(filters) !== JSON.stringify(initialFilters);
        const mappingChanged =
          statuses !== null &&
          JSON.stringify(mapping) !== JSON.stringify(editing.mapping);
        await updateConnection(editing.id, {
          name,
          ...(configChanged ? { config } : {}),
          ...(secret ? { secret } : {}),
          ...(mappingChanged ? { mapping } : {}),
          ...(filtersChanged
            ? {
                filters: {
                  assignee: filters.assignee,
                  projects: filters.projects
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean),
                  done_days: Number(filters.done_days) || 0,
                  query: filters.query,
                },
              }
            : {}),
        });
      } else {
        await createConnection({ provider, name, config, secret });
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
          {t('tasks.conn.tracker')}
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as ProviderName);
              setConfig({});
            }}
            className={`mt-1 ${fieldClass}`}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(PROVIDER_SPECS[p]!.label)}
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
          placeholder={t('tasks.conn.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      {spec.fields.map((f) => (
        <label key={f.key} className="block text-xs text-slate-400">
          {t(f.label)}
          <input
            required
            type={f.type ?? 'text'}
            value={config[f.key] ?? ''}
            placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
            onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            className={`mt-1 ${fieldClass}`}
          />
        </label>
      ))}
      <label className="block text-xs text-slate-400">
        {t(spec.secretLabel)}
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
          {t(spec.secretHelp)}{' '}
          {spec.secretHelpUrl && (
            <a
              href={spec.secretHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              {t('tasks.conn.openHelp')}
            </a>
          )}{' '}
          {t('tasks.conn.secretNote')}
        </span>
      </label>
      {spec.note && <p className="text-xs text-amber-300">{t(spec.note)}</p>}
      {editing && (
        <fieldset className="space-y-3 border-t border-slate-800 pt-3">
          <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('tasks.conn.which')}
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              {t('tasks.conn.assignedTo')}
              <select
                value={filters.assignee}
                disabled={!!filters.query.trim()}
                onChange={(e) => setFilter('assignee', e.target.value)}
                className={`mt-1 ${fieldClass}`}
              >
                <option value="me">{t('tasks.conn.me')}</option>
                <option value="unassigned">{t('tasks.conn.nobody')}</option>
                <option value="any">{t('tasks.conn.anyone')}</option>
              </select>
            </label>
            <label className="block text-xs text-slate-400">
              {t('tasks.conn.doneDays')}
              <input
                type="number"
                min={0}
                max={90}
                value={filters.done_days}
                disabled={!!filters.query.trim()}
                onChange={(e) => setFilter('done_days', e.target.value)}
                className={`mt-1 ${fieldClass}`}
              />
            </label>
          </div>
          <label className="block text-xs text-slate-400">
            {t(spec.projectsLabel)}
            <input
              value={filters.projects}
              disabled={!!filters.query.trim()}
              placeholder={t('tasks.conn.allProjects')}
              onChange={(e) => setFilter('projects', e.target.value)}
              className={`mt-1 ${fieldClass}`}
            />
          </label>
          {spec.queryLabel && (
            <label className="block text-xs text-slate-400">
              {t('tasks.conn.advanced', { language: t(spec.queryLabel) })}
              <textarea
                rows={2}
                maxLength={2000}
                value={filters.query}
                placeholder={
                  spec.queryPlaceholder ? t(spec.queryPlaceholder) : undefined
                }
                onChange={(e) => setFilter('query', e.target.value)}
                className={`mt-1 font-mono ${fieldClass}`}
              />
              <span className="mt-1 block text-slate-500">
                {t('tasks.conn.replaces')}
              </span>
            </label>
          )}
        </fieldset>
      )}
      {editing && statuses && statuses.length > 0 && (
        <fieldset className="space-y-2 border-t border-slate-800 pt-3">
          <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('tasks.conn.columns')}
          </legend>
          <p className="text-xs text-slate-500">
            {t('tasks.conn.columnsHelp')}
          </p>
          {statuses.map((st) => (
            <label
              key={st.name}
              className="flex items-center gap-2 text-sm text-slate-300"
            >
              <span className="min-w-0 flex-1 truncate">{st.name}</span>
              <select
                aria-label={t('tasks.conn.columnFor', { status: st.name })}
                value={columns[st.name] ?? st.auto_column}
                onChange={(e) =>
                  setColumns({
                    ...columns,
                    [st.name]: e.target.value as Column,
                  })
                }
                className="w-40 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              >
                {COLUMNS.map((c) => (
                  <option key={c} value={c}>
                    {c === st.auto_column
                      ? t('tasks.conn.auto', { column: t(COLUMN_LABELS[c]) })
                      : t(COLUMN_LABELS[c])}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {Object.keys(mapping).length > 0 && (
            <button
              type="button"
              onClick={() =>
                setColumns(
                  Object.fromEntries(
                    statuses.map((st) => [st.name, st.auto_column]),
                  ),
                )
              }
              className="text-xs text-accent hover:underline"
            >
              {t('tasks.conn.reset')}
            </button>
          )}
        </fieldset>
      )}
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
 * Lists the user's tracker connections and adds, edits,
 * re-reads and removes them.
 */
const ConnectionsModal: React.FC<ConnectionsModalProps> = ({
  connections,
  onClose,
  onChanged,
  onRefresh,
}) => {
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
      await deleteConnection(id);
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
        aria-labelledby="connections-title"
        className="flex max-h-full w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        <header className="flex items-center border-b border-slate-800 px-5 py-3">
          <h3
            id="connections-title"
            className="text-lg font-bold text-slate-50"
          >
            {t('tasks.conn.title')}
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
          <p className="text-sm text-slate-400">{t('tasks.conn.intro')}</p>
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
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SOURCE_STYLE[c.provider]}`}
                  >
                    {t(
                      PROVIDER_SPECS[c.provider]?.label ??
                        SOURCE_LABEL[c.provider],
                    )}
                  </span>
                  <span className="min-w-0 truncate font-semibold text-slate-100">
                    {c.name}
                  </span>
                  <div className="ml-auto flex shrink-0 gap-1">
                    <button
                      onClick={() => refresh(c.id)}
                      aria-label={t('tasks.conn.refresh', { name: c.name })}
                      title={t('tasks.conn.refreshTitle')}
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
                  {t('tasks.conn.count', { count: c.task_count })} ·{' '}
                  {syncedAgo(c.last_sync_at, t, language)}
                </p>
                {c.last_error && (
                  <p role="alert" className="mt-1 text-xs text-red-400">
                    {c.last_error}
                  </p>
                )}
                {confirmDelete === c.id && (
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    <span className="mr-auto text-slate-300">
                      {t('tasks.conn.confirmRemove')}
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

export default ConnectionsModal;
