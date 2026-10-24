import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  createExternalTask,
  errorMessage,
  getCreateOptions,
  getTaskTypes,
} from '../../tasksApi';
import type {
  Choice,
  Connection,
  CreateOptions,
  LocalTaskFields,
  TaskItem,
} from '../../tasksApi';
import TaskFields from './TaskFields';
import { EMPTY_DRAFT, draftFields, fieldClass } from './taskDraft';
import { PROVIDER_SPECS } from './providerSpecs';
import { SOURCE_LABEL, safeUrl } from './taskMeta';
import { useI18n } from '../../i18n';

interface NewTaskModalProps {
  /** Trackers the task can also be created in. */
  connections?: Connection[];
  onClose: () => void;
  onCreate: (
    fields: Partial<LocalTaskFields> & { title: string },
  ) => Promise<void>;
  /** Called with a task created in a tracker. */
  onCreated?: (task: TaskItem) => void;
}

/** Fields of a new task in a tracker. */
const ExternalTaskForm: React.FC<{
  connection: Connection;
  onCreated: (task: TaskItem) => void;
  onCancel: () => void;
}> = ({ connection, onCreated, onCancel }) => {
  const { t } = useI18n();
  const [options, setOptions] = useState<CreateOptions | null>(null);
  const [types, setTypes] = useState<Choice[]>([]);
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCreateOptions(connection.id)
      .then((found) => {
        if (cancelled) return;
        setOptions(found);
        setProject(found.projects[0]?.id ?? '');
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getTaskTypes(connection.id, project)
      .then((found) => {
        if (cancelled) return;
        setTypes(found);
        setType(found[0]?.id ?? '');
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [connection.id, project]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !project) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await createExternalTask(connection.id, {
          project,
          type: type || null,
          priority: priority || null,
          title,
          description,
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-xs text-slate-400">
        {t('tasks.create.project')}
        <select
          value={project}
          disabled={!options}
          onChange={(e) => setProject(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        >
          {!options && <option>{t('tasks.loading')}</option>}
          {options?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs text-slate-400">
          {t('tasks.create.type')}
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={`mt-1 ${fieldClass}`}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-400">
          {t('tasks.create.priority')}
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={`mt-1 ${fieldClass}`}
          >
            <option value="">{t('tasks.create.defaultPriority')}</option>
            {options?.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.title')}
        <input
          autoFocus
          required
          maxLength={300}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.description')}
        <textarea
          rows={4}
          maxLength={20000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      <p className="text-xs text-slate-500">
        {t('tasks.create.assignedTo', {
          account: connection.config.account || t('tasks.create.you'),
        })}
      </p>
      {error && (
        <div role="alert" className="space-y-1 text-sm text-red-400">
          <p>{error}</p>
          {safeUrl(options?.create_url) && (
            <a
              href={safeUrl(options?.create_url)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-accent hover:underline"
            >
              {t('tasks.create.itIn', {
                tracker: t(
                  PROVIDER_SPECS[connection.provider]?.label ??
                    SOURCE_LABEL[connection.provider],
                ),
              })}
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-slate-600 bg-slate-700/60 px-3 py-2 text-sm text-slate-200 hover:bg-slate-600"
        >
          {t('tasks.cancel')}
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim() || !project}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? t('tasks.create.creating') : t('tasks.create.create')}
        </button>
      </div>
    </form>
  );
};

/** Form for a new task: local, or in one of the trackers. */
const NewTaskModal: React.FC<NewTaskModalProps> = ({
  connections = [],
  onClose,
  onCreate,
  onCreated,
}) => {
  const { t } = useI18n();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // 'local' or a connection ID.
  const [where, setWhere] = useState('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatable = connections.filter((c) => PROVIDER_SPECS[c.provider]);
  const target = creatable.find((c) => String(c.id) === where);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(draftFields(draft));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="app-root fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 id="new-task-title" className="text-lg font-bold text-slate-50">
          {t('tasks.create.title')}
        </h3>
        {creatable.length > 0 && (
          <label className="block text-xs text-slate-400">
            {t('tasks.create.in')}
            <select
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              className={`mt-1 ${fieldClass}`}
            >
              <option value="local">{t('tasks.create.local')}</option>
              {creatable.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name} ({t(PROVIDER_SPECS[c.provider]!.label)})
                </option>
              ))}
            </select>
          </label>
        )}
        {target ? (
          <ExternalTaskForm
            key={target.id}
            connection={target}
            onCancel={onClose}
            onCreated={(task) => {
              onCreated?.(task);
              onClose();
            }}
          />
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <TaskFields draft={draft} onChange={setDraft} autoFocus />
            {error && (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border border-slate-600 bg-slate-700/60 px-3 py-2 text-sm text-slate-200 hover:bg-slate-600"
              >
                {t('tasks.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !draft.title.trim()}
                className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? t('tasks.create.creating') : t('tasks.create.create')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default NewTaskModal;
