import React from 'react';
import { COLUMNS, COLUMN_LABELS } from '../../tasksApi';
import type { Column, Priority } from '../../tasksApi';
import { PRIORITIES, PRIORITY_LABELS } from './taskMeta';
import { fieldClass } from './taskDraft';
import type { TaskDraft } from './taskDraft';
import { useI18n } from '../../i18n';

interface TaskFieldsProps {
  draft: TaskDraft;
  onChange: (draft: TaskDraft) => void;
  autoFocus?: boolean;
}

/** Inputs for every field of a local task. */
const TaskFields: React.FC<TaskFieldsProps> = ({
  draft,
  onChange,
  autoFocus,
}) => {
  const { t } = useI18n();
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.title')}
        <input
          autoFocus={autoFocus}
          required
          maxLength={300}
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.description')}
        <textarea
          rows={5}
          maxLength={20000}
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.column')}
        <select
          value={draft.column}
          onChange={(e) => set('column', e.target.value as Column)}
          className={`mt-1 ${fieldClass}`}
        >
          {COLUMNS.map((c) => (
            <option key={c} value={c}>
              {t(COLUMN_LABELS[c])}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs text-slate-400">
          {t('tasks.field.priority')}
          <select
            value={draft.priority}
            onChange={(e) => set('priority', e.target.value as Priority | '')}
            className={`mt-1 ${fieldClass}`}
          >
            <option value="">{t('tasks.field.none')}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABELS[p])}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-400">
          {t('tasks.field.due')}
          <input
            type="date"
            value={draft.due_date}
            onChange={(e) => set('due_date', e.target.value)}
            className={`mt-1 ${fieldClass}`}
          />
        </label>
      </div>
      <label className="block text-xs text-slate-400">
        {t('tasks.field.tags')}
        <input
          value={draft.tags}
          placeholder={t('tasks.field.tagsPlaceholder')}
          onChange={(e) => set('tags', e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
    </>
  );
};

export default TaskFields;
