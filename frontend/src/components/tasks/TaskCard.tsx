import React from 'react';
import { CalendarDays, ExternalLink } from 'lucide-react';
import type { StatusOption, TaskItem } from '../../tasksApi';
import StatusSelect from './StatusSelect';
import { useI18n } from '../../i18n';
import {
  PRIORITY_LABELS,
  PRIORITY_STYLE,
  SOURCE_LABEL,
  SOURCE_STYLE,
  isOverdue,
  shortDate,
  statusLabel,
  safeUrl,
} from './taskMeta';

interface TaskCardProps {
  task: TaskItem;
  busy?: boolean;
  onStatus: (task: TaskItem, option: StatusOption) => void;
  /** Opens the task's side panel. */
  onOpen?: (task: TaskItem) => void;
}

/** One task on the board. */
const TaskCard: React.FC<TaskCardProps> = ({
  task,
  busy,
  onStatus,
  onOpen,
}) => {
  const { t, language } = useI18n();
  return (
    <article
      aria-label={task.title}
      className={`rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm shadow-sm ${
        busy ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
        <span className={`rounded px-1.5 py-0.5 ${SOURCE_STYLE[task.source]}`}>
          {task.connection_name || t(SOURCE_LABEL[task.source])}
        </span>
        {task.key && (
          <span className="font-mono text-slate-400">{task.key}</span>
        )}
        {safeUrl(task.url) && (
          <a
            href={safeUrl(task.url)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('tasks.openIn', {
              task: task.key || task.title,
              source: t(SOURCE_LABEL[task.source]),
            })}
            className="ml-auto text-slate-500 hover:text-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
      <button
        onClick={() => onOpen?.(task)}
        className="block w-full break-words text-left font-medium text-slate-100 hover:text-accent"
      >
        {task.title}
      </button>
      {(task.priority || task.due_date || task.tags.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
          {task.priority && (
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${PRIORITY_STYLE[task.priority]}`}
            >
              {t(PRIORITY_LABELS[task.priority])}
            </span>
          )}
          {task.due_date && (
            <span
              title={isOverdue(task) ? t('tasks.overdue') : t('tasks.dueDate')}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${
                isOverdue(task)
                  ? 'bg-red-950 text-red-300'
                  : 'bg-slate-900 text-slate-400'
              }`}
            >
              <CalendarDays size={11} />
              {shortDate(task.due_date, language)}
            </span>
          )}
          {task.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-slate-900 px-1.5 py-0.5 text-slate-400"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2">
        <StatusSelect
          task={task}
          currentLabel={statusLabel(task, t)}
          disabled={busy}
          onChange={(option) => onStatus(task, option)}
        />
      </div>
    </article>
  );
};

export default TaskCard;
