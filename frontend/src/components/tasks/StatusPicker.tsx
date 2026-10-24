import React from 'react';
import { COLUMN_LABELS } from '../../tasksApi';
import type { StatusOption, TaskItem } from '../../tasksApi';
import { useI18n } from '../../i18n';

interface StatusPickerProps {
  task: TaskItem;
  options: StatusOption[];
  onPick: (option: StatusOption) => void;
  onCancel: () => void;
}

/**
 * Asks which status to use when a card is dropped on a column
 * that holds more than one status the task can move to.
 */
const StatusPicker: React.FC<StatusPickerProps> = ({
  task,
  options,
  onPick,
  onCancel,
}) => {
  const { t } = useI18n();
  return (
    <div
      className="app-root fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-picker-title"
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      >
        <h3 id="status-picker-title" className="font-bold text-slate-50">
          {t('tasks.moveTo', { column: t(COLUMN_LABELS[options[0].column]) })}
        </h3>
        <p className="mt-1 break-words text-sm text-slate-400">
          {t('tasks.whichStatus', { title: task.title })}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {options.map((o, i) => (
            <button
              key={o.id}
              autoFocus={i === 0}
              onClick={() => onPick(o)}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-left text-sm text-slate-100 hover:border-accent-muted"
            >
              {o.name}
            </button>
          ))}
          <button
            onClick={onCancel}
            className="mt-1 rounded-md px-3 py-2 text-sm text-slate-400 hover:text-slate-100"
          >
            {t('tasks.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StatusPicker;
