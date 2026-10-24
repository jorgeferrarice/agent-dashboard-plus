import { COLUMN_LABELS } from '../../tasksApi';
import type { Priority, TaskItem } from '../../tasksApi';
import type { I18n, Language, MessageKey } from '../../i18n';

type T = I18n['t'];

/** Badge colour per source. */
export const SOURCE_STYLE: Record<TaskItem['source'], string> = {
  local: 'bg-slate-700 text-slate-200',
  jira: 'bg-blue-900/70 text-blue-200',
  shortcut: 'bg-violet-900/70 text-violet-200',
  huly: 'bg-teal-900/70 text-teal-200',
};

/** Message key of the name a source goes by on its badge. */
export const SOURCE_LABEL: Record<TaskItem['source'], MessageKey> = {
  local: 'tasks.source.local',
  jira: 'tasks.source.jira',
  shortcut: 'tasks.source.shortcut',
  huly: 'tasks.source.huly',
};

/** The status as a person reads it: local tasks have no status
 *  name of their own, only their column. */
export const statusLabel = (task: TaskItem, t: T) =>
  task.source === 'local' ? t(COLUMN_LABELS[task.column]) : task.status;

/** Priorities, most urgent first. */
export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low'];

/** Message key of each priority's name. */
export const PRIORITY_LABELS: Record<Priority, MessageKey> = {
  urgent: 'tasks.priority.urgent',
  high: 'tasks.priority.high',
  medium: 'tasks.priority.medium',
  low: 'tasks.priority.low',
};

export const PRIORITY_STYLE: Record<Priority, string> = {
  urgent: 'bg-red-900/70 text-red-200',
  high: 'bg-orange-900/70 text-orange-200',
  medium: 'bg-yellow-900/60 text-yellow-200',
  low: 'bg-slate-700 text-slate-300',
};

/** Today as `YYYY-MM-DD` in the viewer's time zone. */
export const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Whether an unfinished task is past its deadline. */
export const isOverdue = (task: TaskItem, now = today()) =>
  !!task.due_date && task.column !== 'done' && task.due_date < now;

/**
 * Order of cards within a column: most urgent priority first,
 * then the nearest deadline, then the most recently updated.
 * Tasks without a priority or a deadline come after those with
 * one.
 */
export function compareTasks(a: TaskItem, b: TaskItem): number {
  const rank = (t: TaskItem) =>
    t.priority ? PRIORITIES.indexOf(t.priority) : PRIORITIES.length;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  // '~' sorts after any date.
  const due = (t: TaskItem) => t.due_date || '~';
  if (due(a) !== due(b)) return due(a) < due(b) ? -1 : 1;
  const updated = (t: TaskItem) => t.updated_at || '';
  if (updated(a) !== updated(b)) return updated(a) > updated(b) ? -1 : 1;
  return 0;
}

/** Splits comma-separated tags as typed into a list. */
export const parseTags = (text: string) =>
  [...new Set(text.split(',').map((t) => t.trim()))].filter(Boolean);

/** Formats `YYYY-MM-DD` as a short date, e.g. "Nov 1" / "1 de nov.". */
export const shortDate = (iso: string, language: Language) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(language, {
    month: 'short',
    day: 'numeric',
  });

/** Columns of the table that can be sorted by. */
export type SortKey =
  | 'source'
  | 'key'
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'due_date'
  | 'updated_at';

export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** Value a task is sorted by for a column; empty sorts last. */
function sortValue(task: TaskItem, key: SortKey): string | number {
  switch (key) {
    case 'source':
      return task.connection_name || task.source;
    case 'status':
      // Local tasks sort by column; others by status name.
      return task.source === 'local' ? task.column : task.status;
    case 'priority':
      return task.priority ? PRIORITIES.indexOf(task.priority) : '';
    default:
      return task[key] ?? '';
  }
}

/**
 * Sorts tasks by one table column. Tasks without a value come
 * last in both directions; ties keep the board's order.
 */
export function sortTasks(tasks: TaskItem[], sort: Sort | null): TaskItem[] {
  const sorted = [...tasks].sort(compareTasks);
  if (!sort) return sorted;
  return sorted.sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === y) return 0;
    if (x === '') return 1;
    if (y === '') return -1;
    const order =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true });
    return sort.desc ? -order : order;
  });
}

/** When a connection was last read, in words. */
export const syncedAgo = (
  iso: string | null | undefined,
  t: T,
  language: Language,
) => {
  if (!iso) return t('tasks.sync.never');
  const time = new Date(
    iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`,
  );
  const minutes = Math.round((Date.now() - time.getTime()) / 60000);
  if (minutes < 1) return t('tasks.sync.justNow');
  if (minutes < 60) return t('tasks.sync.minutes', { minutes });
  return t('tasks.sync.at', {
    time: time.toLocaleString(language, {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
  });
};

/** A tracker link, only when it is an http(s) URL: links come
 *  from the trackers and are rendered as `href`. */
export const safeUrl = (url?: string | null) =>
  url && /^https?:\/\//i.test(url) ? url : undefined;
