import React, { useState } from 'react';
import { COLUMN_LABELS, getStatuses } from '../../tasksApi';
import type { StatusOption, TaskItem } from '../../tasksApi';
import { useI18n } from '../../i18n';

interface StatusSelectProps {
  task: TaskItem;
  /** Shown as the current choice; the task's own status by default. */
  currentLabel: string;
  onChange: (option: StatusOption) => void;
  disabled?: boolean;
}

/**
 * Dropdown of the statuses a task can move to. The choices are
 * fetched the first time the dropdown is touched: for an
 * external tracker they depend on its workflow, and asking for
 * every card up front would cost one request per card.
 */
const StatusSelect: React.FC<StatusSelectProps> = ({
  task,
  currentLabel,
  onChange,
  disabled,
}) => {
  const { t } = useI18n();
  // What can follow a status depends on the status: choices
  // are kept for the status they were fetched in.
  const [loaded, setLoaded] = useState<{
    status: string;
    options: StatusOption[] | null;
  } | null>(null);
  const current = loaded?.status === task.status ? loaded : null;
  const options = current?.options ?? null;
  const failed = !!current && current.options === null;

  const load = () => {
    if (current) return;
    const status = task.status;
    getStatuses(task.id)
      .then((found) => setLoaded({ status, options: found }))
      .catch(() => setLoaded({ status, options: null }));
  };

  return (
    <select
      aria-label={t('tasks.statusOf', { title: task.title })}
      value=""
      disabled={disabled}
      onPointerDown={load}
      onFocus={load}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const option = options?.find((o) => o.id === e.target.value);
        if (option) onChange(option);
      }}
      className="max-w-full truncate rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50"
    >
      <option value="">{currentLabel}</option>
      {!options && !failed && <option disabled>{t('tasks.loading')}</option>}
      {failed && <option disabled>{t('tasks.statusesFailed')}</option>}
      {options
        ?.filter((o) => o.id !== task.status && o.name !== task.status)
        .map((o) => (
          <option key={o.id} value={o.id}>
            {task.source === 'local' ? t(COLUMN_LABELS[o.column]) : o.name}
          </option>
        ))}
    </select>
  );
};

export default StatusSelect;
