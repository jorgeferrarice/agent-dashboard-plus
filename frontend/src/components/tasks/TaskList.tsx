import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink } from 'lucide-react';
import { COLUMNS, COLUMN_LABELS } from '../../tasksApi';
import type { StatusOption, TaskItem } from '../../tasksApi';
import StatusSelect from './StatusSelect';
import {
  PRIORITY_LABELS,
  PRIORITY_STYLE,
  SOURCE_LABEL,
  SOURCE_STYLE,
  isOverdue,
  shortDate,
  sortTasks,
  statusLabel,
  safeUrl,
} from './taskMeta';
import type { Sort, SortKey } from './taskMeta';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n';

const HEADERS: { key: SortKey; label: MessageKey; className?: string }[] = [
  { key: 'source', label: 'tasks.col.source' },
  { key: 'key', label: 'tasks.col.key', className: 'hidden sm:table-cell' },
  { key: 'title', label: 'tasks.col.title' },
  { key: 'status', label: 'tasks.col.status' },
  { key: 'priority', label: 'tasks.col.priority' },
  {
    key: 'assignee',
    label: 'tasks.col.assignee',
    className: 'hidden md:table-cell',
  },
  { key: 'due_date', label: 'tasks.col.due' },
  {
    key: 'updated_at',
    label: 'tasks.col.updated',
    className: 'hidden lg:table-cell',
  },
];

interface TaskListProps {
  tasks: TaskItem[];
  busy: ReadonlySet<string>;
  onStatus: (task: TaskItem, option: StatusOption) => void;
  onOpen?: (task: TaskItem) => void;
}

/**
 * The tasks as a table, grouped by board column. Clicking a
 * header sorts by it; clicking again reverses; a third click
 * goes back to the board's order.
 */
const TaskList: React.FC<TaskListProps> = ({
  tasks,
  busy,
  onStatus,
  onOpen,
}) => {
  const { t, language } = useI18n();
  const [sort, setSort] = useState<Sort | null>(null);

  const groups = useMemo(
    () =>
      COLUMNS.map((column) => ({
        column,
        tasks: sortTasks(
          tasks.filter((task) => task.column === column),
          sort,
        ),
      })),
    [tasks, sort],
  );

  const clickHeader = (key: SortKey) =>
    setSort((prev) =>
      prev?.key !== key
        ? { key, desc: false }
        : prev.desc
          ? null
          : { key, desc: true },
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-wider text-slate-400">
          <tr>
            {HEADERS.map((h) => (
              <th
                key={h.key}
                scope="col"
                aria-sort={
                  sort?.key === h.key
                    ? sort.desc
                      ? 'descending'
                      : 'ascending'
                    : 'none'
                }
                className={`px-3 py-2 font-semibold ${h.className ?? ''}`}
              >
                <button
                  onClick={() => clickHeader(h.key)}
                  className="flex items-center gap-1 hover:text-slate-100"
                >
                  {t(h.label)}
                  {sort?.key === h.key &&
                    (sort.desc ? (
                      <ArrowDown size={12} />
                    ) : (
                      <ArrowUp size={12} />
                    ))}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map(({ column, tasks: rows }) => (
          <tbody key={column} aria-label={t(COLUMN_LABELS[column])}>
            <tr className="bg-slate-900/80">
              <th
                colSpan={HEADERS.length}
                scope="rowgroup"
                className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400"
              >
                {t(COLUMN_LABELS[column])}{' '}
                <span className="text-slate-600">({rows.length})</span>
              </th>
            </tr>
            {rows.map((task) => (
              <tr
                key={task.id}
                className={`border-t border-slate-800 hover:bg-slate-800/50 ${
                  busy.has(task.id) ? 'opacity-60' : ''
                }`}
              >
                <td className="px-3 py-2">
                  <span
                    className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SOURCE_STYLE[task.source]}`}
                  >
                    {task.connection_name || t(SOURCE_LABEL[task.source])}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-400 sm:table-cell">
                  {task.key}
                </td>
                <td className="min-w-48 px-3 py-2 text-slate-100">
                  <button
                    onClick={() => onOpen?.(task)}
                    className="break-words text-left hover:text-accent"
                  >
                    {task.title}
                  </button>
                  {safeUrl(task.url) && (
                    <a
                      href={safeUrl(task.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('tasks.open', {
                        task: task.key || task.title,
                      })}
                      className="ml-1.5 inline-block align-middle text-slate-500 hover:text-slate-200"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusSelect
                    task={task}
                    currentLabel={statusLabel(task, t)}
                    disabled={busy.has(task.id)}
                    onChange={(option) => onStatus(task, option)}
                  />
                </td>
                <td className="px-3 py-2">
                  {task.priority && (
                    <span
                      className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ${PRIORITY_STYLE[task.priority]}`}
                    >
                      {t(PRIORITY_LABELS[task.priority])}
                    </span>
                  )}
                </td>
                <td className="hidden px-3 py-2 text-slate-300 md:table-cell">
                  {task.assignee}
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-2 ${
                    isOverdue(task) ? 'text-red-300' : 'text-slate-400'
                  }`}
                >
                  {task.due_date && shortDate(task.due_date, language)}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-slate-500 lg:table-cell">
                  {task.updated_at &&
                    new Date(task.updated_at).toLocaleString(language, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
};

export default TaskList;
