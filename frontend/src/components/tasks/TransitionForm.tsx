import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Choice, StatusOption, TaskItem } from '../../tasksApi';
import UserPicker from './UserPicker';
import { fieldClass } from './taskDraft';
import { SOURCE_LABEL, safeUrl } from './taskMeta';
import { useI18n } from '../../i18n';

interface TransitionFormProps {
  task: TaskItem;
  option: StatusOption;
  onSubmit: (fields: Record<string, unknown>) => void;
  onCancel: () => void;
}

type Value = string | string[] | Choice | null;

/** Whether a field has something in it. */
const filled = (value: Value) =>
  Array.isArray(value) ? value.length > 0 : !!value;

/**
 * Asks for the fields a tracker requires before a task can move
 * to a status, e.g. Jira's "Resolution" when closing an issue.
 */
const TransitionForm: React.FC<TransitionFormProps> = ({
  task,
  option,
  onSubmit,
  onCancel,
}) => {
  const { t } = useI18n();
  const fields = option.fields ?? [];
  const [values, setValues] = useState<Record<string, Value>>({});
  const set = (id: string, value: Value) =>
    setValues((prev) => ({ ...prev, [id]: value }));
  const unsupported = fields.filter((f) => f.kind === 'unsupported');
  const complete =
    unsupported.length === 0 && fields.every((f) => filled(values[f.id]));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    onSubmit(
      Object.fromEntries(
        fields.map((f) => {
          const v = values[f.id];
          return [f.id, f.kind === 'user' ? (v as Choice).id : v];
        }),
      ),
    );
  };

  return (
    <div
      className="app-root fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="transition-title"
        onSubmit={submit}
        className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 id="transition-title" className="font-bold text-slate-50">
          {t('tasks.moveTo', { column: option.name })}
        </h3>
        <p className="break-words text-sm text-slate-400">
          {t('tasks.needsDetails', {
            source: t(SOURCE_LABEL[task.source]),
            task: task.key || task.title,
          })}
        </p>
        {fields.map((f) => {
          const value = values[f.id] ?? null;
          switch (f.kind) {
            case 'select':
              return (
                <label key={f.id} className="block text-xs text-slate-400">
                  {f.name}
                  <select
                    value={(value as string) ?? ''}
                    onChange={(e) => set(f.id, e.target.value)}
                    className={`mt-1 ${fieldClass}`}
                  >
                    <option value="">{t('tasks.choose')}</option>
                    {f.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            case 'multiselect':
              return (
                <label key={f.id} className="block text-xs text-slate-400">
                  {f.name}
                  <select
                    multiple
                    value={(value as string[]) ?? []}
                    onChange={(e) =>
                      set(
                        f.id,
                        [...e.target.selectedOptions].map((o) => o.value),
                      )
                    }
                    className={`mt-1 ${fieldClass}`}
                  >
                    {f.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            case 'user':
              return (
                <UserPicker
                  key={f.id}
                  taskId={task.id}
                  label={f.name}
                  value={value as Choice | null}
                  onChange={(user) => set(f.id, user)}
                />
              );
            case 'unsupported':
              return (
                <p key={f.id} className="text-sm text-amber-300">
                  {t('tasks.cannotFill', { field: f.name })}
                </p>
              );
            default:
              return (
                <label key={f.id} className="block text-xs text-slate-400">
                  {f.name}
                  {f.kind === 'richtext' ? (
                    <textarea
                      rows={3}
                      value={(value as string) ?? ''}
                      onChange={(e) => set(f.id, e.target.value)}
                      className={`mt-1 ${fieldClass}`}
                    />
                  ) : (
                    <input
                      type={f.kind === 'text' ? 'text' : f.kind}
                      value={(value as string) ?? ''}
                      onChange={(e) => set(f.id, e.target.value)}
                      className={`mt-1 ${fieldClass}`}
                    />
                  )}
                </label>
              );
          }
        })}
        {unsupported.length > 0 && safeUrl(task.url) && (
          <a
            href={safeUrl(task.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-accent hover:underline"
          >
            {t('tasks.moveItIn', { source: t(SOURCE_LABEL[task.source]) })}{' '}
            <ExternalLink size={12} />
          </a>
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
            disabled={!complete}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
          >
            {t('tasks.move')}
          </button>
        </div>
      </form>
    </div>
  );
};

export default TransitionForm;
