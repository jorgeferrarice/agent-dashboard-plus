import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Columns3, List, Plug, Plus, RefreshCw } from 'lucide-react';
import {
  COLUMNS,
  COLUMN_LABELS,
  changeStatus,
  createLocalTask,
  errorMessage,
  getConnections,
  getStatuses,
  getTasks,
  refreshTasks,
} from '../../tasksApi';
import type {
  Column,
  Connection,
  LocalTaskFields,
  StatusOption,
  TaskItem,
} from '../../tasksApi';
import { getSocket } from '../../socket';
import { useI18n } from '../../i18n';
import NewTaskModal from './NewTaskModal';
import TaskCard from './TaskCard';
import TaskList from './TaskList';
import StatusPicker from './StatusPicker';
import TaskPanel from './TaskPanel';
import ConnectionsModal from './ConnectionsModal';
import TransitionForm from './TransitionForm';
import { SOURCE_STYLE, compareTasks, syncedAgo } from './taskMeta';

/** Whether cards can be dragged: only with a mouse or
 *  trackpad. On a touch screen a drag scrolls the board, and
 *  the status dropdown moves cards instead. */
const canDragCards = () =>
  !(window.matchMedia?.('(pointer: coarse)').matches ?? false);

type View = 'board' | 'list';
const HIDDEN_KEY = 'agentDashboard.tasksHidden';

/** The chip a task belongs to: local, or its connection. */
const sourceKey = (task: TaskItem) =>
  task.connection_id ? String(task.connection_id) : 'local';

/** Sources this browser last hid with the chips. */
function loadHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}
const VIEW_KEY = 'agentDashboard.tasksView';

/** The view this browser last used. */
function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

/**
 * The Tasks tab: the user's tasks from every source on one
 * Kanban board with four fixed columns.
 */
const TasksView: React.FC = () => {
  const { t, language } = useI18n();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [managing, setManaging] = useState(false);
  const [view, setView] = useState<View>(loadView);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Storage unavailable: the view is simply not remembered.
    }
  }, [view]);
  // Tasks with a change on its way to the server.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const [draggable] = useState(canDragCards);
  // Task whose side panel is open.
  const [openId, setOpenId] = useState<string | null>(null);
  const openTask = tasks.find((t) => t.id === openId);
  // Sources hidden with the chips: 'local' or a connection ID.
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {
      // Storage unavailable: the chips are simply not remembered.
    }
  }, [hidden]);
  const toggleSource = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const shown = useMemo(
    () => tasks.filter((t) => !hidden.has(sourceKey(t))),
    [tasks, hidden],
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<Column | null>(null);
  // A move waiting for the fields its status requires.
  const [filling, setFilling] = useState<{
    task: TaskItem;
    option: StatusOption;
  } | null>(null);
  // A dropped card waiting for the user to pick its status.
  const [picking, setPicking] = useState<{
    task: TaskItem;
    options: StatusOption[];
  } | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await getConnections());
    } catch (err) {
      console.error('Failed to load task connections:', err);
    }
  }, []);

  /** Loads the board; with `refresh`, reads the trackers first
   *  (one connection, or all of them). */
  const load = useCallback(
    async (refresh = false, connectionId?: number) => {
      setLoading(true);
      try {
        setTasks(await (refresh ? refreshTasks(connectionId) : getTasks()));
        setError(null);
      } catch (err) {
        setError(t('tasks.loadFailed', { error: errorMessage(err) }));
      } finally {
        setLoading(false);
      }
      await loadConnections();
    },
    [loadConnections, t],
  );

  useEffect(() => {
    load();
  }, [load]);

  // The backend reads the trackers every few minutes and says
  // when this user's board changed.
  useEffect(() => {
    const socket = getSocket();
    const onUpdate = () => load();
    socket.on('tasks_updated', onUpdate);
    return () => {
      socket.off('tasks_updated', onUpdate);
    };
  }, [load]);

  const lastSync = connections
    .map((c) => c.last_sync_at)
    .filter((t): t is string => !!t)
    .sort()
    .pop();

  /** Puts the server's copy of a task in place of ours. */
  const replace = (task: TaskItem) =>
    setTasks((prev) => {
      const found = prev.some((t) => t.id === task.id);
      return found
        ? prev.map((t) => (t.id === task.id ? task : t))
        : [...prev, task];
    });

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * Moves a task to a status. The card goes to the status's
   * column at once and comes back if the server refuses. A
   * status that needs fields filled asks for them first.
   */
  const moveTask = async (
    task: TaskItem,
    option: StatusOption,
    fields?: Record<string, unknown>,
  ) => {
    // One change per task at a time: answers could arrive in
    // the wrong order.
    if (busyRef.current.has(task.id)) return;
    if (option.fields?.length && !fields) {
      setFilling({ task, option });
      return;
    }
    setBusyFor(task.id, true);
    replace({ ...task, column: option.column });
    try {
      replace(await changeStatus(task.id, option.id, fields));
      setError(null);
    } catch (err) {
      replace(task);
      setError(t('tasks.statusFailed', { error: errorMessage(err) }));
    } finally {
      setBusyFor(task.id, false);
    }
  };

  /** Moves a dropped card to a status of the column it was
   *  dropped on, asking which one when there are several. */
  const dropOn = async (taskId: string, column: Column) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.column === column) return;
    let options: StatusOption[];
    try {
      options = (await getStatuses(task.id)).filter(
        (o) =>
          o.column === column && o.id !== task.status && o.name !== task.status,
      );
    } catch (err) {
      setError(t('tasks.statusFailed', { error: errorMessage(err) }));
      return;
    }
    if (options.length === 0) {
      setError(
        t('tasks.cannotMove', {
          title: task.title,
          column: t(COLUMN_LABELS[column]),
        }),
      );
    } else if (options.length === 1) {
      await moveTask(task, options[0]);
    } else {
      setPicking({ task, options });
    }
  };

  const create = async (
    fields: Partial<LocalTaskFields> & { title: string },
  ) => {
    replace(await createLocalTask(fields));
  };

  const byColumn = useMemo(() => {
    const groups: Record<Column, TaskItem[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const task of shown) groups[task.column]?.push(task);
    for (const list of Object.values(groups)) list.sort(compareTasks);
    return groups;
  }, [shown]);

  return (
    <div className="flex h-full min-h-0 flex-col p-3 sm:p-6">
      <header className="mb-3 flex flex-wrap items-center gap-2 sm:mb-5">
        <h1 className="text-xl font-bold text-slate-50 sm:text-2xl">
          {t('tasks.title')}
        </h1>
        <span className="mr-auto text-xs text-slate-500">
          {lastSync &&
            t('tasks.sync.trackers', {
              ago: syncedAgo(lastSync, t, language),
            })}
        </span>
        <div
          role="group"
          aria-label={t('tasks.view')}
          className="flex rounded-md border border-slate-700 p-0.5"
        >
          {(
            [
              ['board', t('tasks.view.board'), Columns3],
              ['list', t('tasks.view.list'), List],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              onClick={() => setView(value)}
              aria-pressed={view === value}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                view === value
                  ? 'bg-slate-700 text-slate-50'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setManaging(true)}
          aria-label={t('tasks.connections')}
          title={t('tasks.connectionsTitle')}
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:text-slate-50"
        >
          <Plug size={14} />
          <span className="hidden sm:inline">{t('tasks.connections')}</span>
        </button>
        <button
          onClick={() => load(true)}
          disabled={loading}
          aria-label={t('tasks.refresh')}
          title={t('tasks.refreshTitle')}
          className="rounded-md border border-slate-700 p-2 text-slate-400 hover:text-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:bg-accent-hover"
        >
          <Plus size={14} /> {t('tasks.new')}
        </button>
      </header>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      {connections.length > 0 && (
        <div
          role="group"
          aria-label={t('tasks.showFrom')}
          className="mb-3 flex flex-wrap gap-1.5"
        >
          {[
            {
              key: 'local',
              label: t('tasks.source.local'),
              style: SOURCE_STYLE.local,
            },
            ...connections.map((c) => ({
              key: String(c.id),
              label: c.name,
              style: SOURCE_STYLE[c.provider],
            })),
          ].map((chip) => {
            const on = !hidden.has(chip.key);
            return (
              <button
                key={chip.key}
                aria-pressed={on}
                onClick={() => toggleSource(chip.key)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-opacity ${chip.style} ${
                  on ? '' : 'opacity-40 line-through'
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      )}
      {connections
        .filter((c) => c.last_error)
        .map((c) => (
          <p
            key={c.id}
            role="alert"
            className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs text-red-300"
          >
            <button
              onClick={() => setManaging(true)}
              className="font-semibold hover:underline"
            >
              {c.name}
            </button>
            : {c.last_error}
          </p>
        ))}
      {view === 'list' ? (
        <TaskList
          tasks={shown}
          busy={busy}
          onStatus={(t, option) => moveTask(t, option)}
          onOpen={(t) => setOpenId(t.id)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((column) => (
            <section
              key={column}
              aria-label={t(COLUMN_LABELS[column])}
              onDragOver={(e) => {
                // Only cards drop here: ignore files, text, etc.
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropColumn !== column) setDropColumn(column);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropColumn((prev) => (prev === column ? null : prev));
                }
              }}
              onDrop={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const id = dragging;
                setDragging(null);
                setDropColumn(null);
                dropOn(id, column);
              }}
              className={`flex w-72 min-w-[16rem] shrink-0 snap-start flex-col rounded-xl p-2 sm:flex-1 ${
                dropColumn === column
                  ? 'bg-slate-800/80 ring-1 ring-accent-muted'
                  : 'bg-slate-950/60'
              }`}
            >
              <h2 className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t(COLUMN_LABELS[column])}
                <span className="rounded bg-slate-800 px-1.5 text-slate-500">
                  {byColumn[column].length}
                </span>
              </h2>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {byColumn[column].map((task) => (
                  <div
                    key={task.id}
                    draggable={draggable && !busy.has(task.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox only starts a drag that carries data.
                      e.dataTransfer.setData('text/plain', task.title);
                      setDragging(task.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropColumn(null);
                    }}
                    className={`${draggable ? 'cursor-grab' : ''} ${
                      dragging === task.id ? 'opacity-50' : ''
                    }`}
                  >
                    <TaskCard
                      task={task}
                      busy={busy.has(task.id)}
                      onStatus={(t, option) => moveTask(t, option)}
                      onOpen={(t) => setOpenId(t.id)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {openTask && (
        <TaskPanel
          task={openTask}
          busy={busy.has(openTask.id)}
          onClose={() => setOpenId(null)}
          onSaved={replace}
          onDeleted={(id) => {
            setOpenId(null);
            setTasks((prev) => prev.filter((t) => t.id !== id));
          }}
          onStatus={(t, option) => moveTask(t, option)}
        />
      )}
      {managing && (
        <ConnectionsModal
          connections={connections}
          onClose={() => setManaging(false)}
          onChanged={() => load()}
          onRefresh={(id) => load(true, id)}
        />
      )}
      {filling && (
        <TransitionForm
          task={filling.task}
          option={filling.option}
          onCancel={() => setFilling(null)}
          onSubmit={(fields) => {
            const { task, option } = filling;
            setFilling(null);
            moveTask(task, option, fields);
          }}
        />
      )}
      {picking && (
        <StatusPicker
          task={picking.task}
          options={picking.options}
          onCancel={() => setPicking(null)}
          onPick={(option) => {
            const { task } = picking;
            setPicking(null);
            moveTask(task, option);
          }}
        />
      )}
      {creating && (
        <NewTaskModal
          connections={connections}
          onClose={() => setCreating(false)}
          onCreate={create}
          onCreated={replace}
        />
      )}
    </div>
  );
};

export default TasksView;
