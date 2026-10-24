import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Trash2, X } from 'lucide-react';
import {
  deleteLocalTask,
  errorMessage,
  setAssignee,
  updateLocalTask,
} from '../../tasksApi';
import type { StatusOption, TaskItem } from '../../tasksApi';
import StatusSelect from './StatusSelect';
import TaskFields from './TaskFields';
import TaskComments from './TaskComments';
import { useI18n } from '../../i18n';
import UserPicker from './UserPicker';
import { draftFields, taskDraft } from './taskDraft';
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

interface TaskPanelProps {
  task: TaskItem;
  busy?: boolean;
  onClose: () => void;
  /** The server's copy of the task after a change. */
  onSaved: (task: TaskItem) => void;
  onDeleted: (taskId: string) => void;
  onStatus: (task: TaskItem, option: StatusOption) => void;
}

/** One labelled line of the read-only details. */
const Detail: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex gap-3 text-sm">
    <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
    <dd className="min-w-0 text-slate-200">{children}</dd>
  </div>
);

/** Editor for a local task: every field, save and delete. */
const LocalTaskEditor: React.FC<{
  task: TaskItem;
  onSaved: (task: TaskItem) => void;
  onDeleted: (taskId: string) => void;
}> = ({ task, onSaved, onDeleted }) => {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => taskDraft(task));
  // When the task changes elsewhere (another device, a reload)
  // and nothing was typed here, show the new values.
  const [seen, setSeen] = useState(task.updated_at);
  // The values the draft started from, to tell if it was edited.
  const [base, setBase] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const changed =
    JSON.stringify(draftFields(draft)) !==
    JSON.stringify(draftFields(taskDraft(task)));
  if (seen !== task.updated_at) {
    setSeen(task.updated_at);
    if (JSON.stringify(draft) === JSON.stringify(base)) {
      setDraft(taskDraft(task));
      setBase(taskDraft(task));
    }
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateLocalTask(task.id, draftFields(draft));
      onSaved(saved);
      setDraft(taskDraft(saved));
      setBase(taskDraft(saved));
      setSeen(saved.updated_at);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteLocalTask(task.id);
      onDeleted(task.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <TaskFields draft={draft} onChange={setDraft} />
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !changed || !draft.title.trim()}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? t('tasks.panel.saving') : t('tasks.panel.save')}
        </button>
        {changed && (
          <button
            type="button"
            onClick={() => {
              setDraft(taskDraft(task));
              setBase(taskDraft(task));
            }}
            className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            {t('tasks.panel.discard')}
          </button>
        )}
      </div>
      <div className="border-t border-slate-800 pt-3">
        {confirmDelete ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="mr-auto text-slate-300">
              {t('tasks.panel.confirmDelete')}
            </span>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-100"
            >
              {t('tasks.panel.keep')}
            </button>
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={remove}
              className="rounded-md bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {t('tasks.panel.delete')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300"
          >
            <Trash2 size={14} /> {t('tasks.panel.deleteTask')}
          </button>
        )}
      </div>
    </form>
  );
};

/** Who a tracker's task is assigned to, and a way to change it. */
const AssigneeEditor: React.FC<{
  task: TaskItem;
  onSaved: (task: TaskItem) => void;
}> = ({ task, onSaved }) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assign = async (userId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await setAssignee(task.id, userId));
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      {editing ? (
        <UserPicker
          taskId={task.id}
          label={t('tasks.panel.assignTo')}
          value={null}
          onChange={(user) => user && assign(user.id)}
        />
      ) : (
        <span>{task.assignee || t('tasks.panel.unassigned')}</span>
      )}
      <div className="flex gap-3 text-xs">
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(!editing)}
          className="text-accent hover:underline disabled:opacity-50"
        >
          {editing ? t('tasks.cancel') : t('tasks.panel.change')}
        </button>
        {task.assignee && !editing && (
          <button
            type="button"
            disabled={busy}
            onClick={() => assign(null)}
            className="text-slate-400 hover:text-slate-100 disabled:opacity-50"
          >
            {t('tasks.panel.unassign')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};

/** Details of a task from an external tracker: status,
 *  assignee and comments can be changed here. */
const ExternalDetails: React.FC<{
  task: TaskItem;
  busy?: boolean;
  onStatus: (task: TaskItem, option: StatusOption) => void;
  onSaved: (task: TaskItem) => void;
}> = ({ task, busy, onStatus, onSaved }) => {
  const { t, language } = useI18n();
  return (
    <div className="space-y-4">
      <h3 className="break-words text-lg font-semibold text-slate-50">
        {task.title}
      </h3>
      <dl className="space-y-2">
        <Detail label={t('tasks.panel.status')}>
          <StatusSelect
            task={task}
            currentLabel={statusLabel(task, t)}
            disabled={busy}
            onChange={(option) => onStatus(task, option)}
          />
        </Detail>
        {task.priority && (
          <Detail label={t('tasks.panel.priority')}>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-semibold ${PRIORITY_STYLE[task.priority]}`}
            >
              {t(PRIORITY_LABELS[task.priority])}
            </span>
          </Detail>
        )}
        <Detail label={t('tasks.panel.assignee')}>
          <AssigneeEditor task={task} onSaved={onSaved} />
        </Detail>
        {task.due_date && (
          <Detail label={t('tasks.panel.due')}>
            <span className={isOverdue(task) ? 'text-red-300' : ''}>
              {shortDate(task.due_date, language)}
            </span>
          </Detail>
        )}
        {task.tags.length > 0 && (
          <Detail label={t('tasks.panel.labels')}>
            {task.tags.join(', ')}
          </Detail>
        )}
      </dl>
      <section aria-label={t('tasks.panel.description')}>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {t('tasks.panel.description')}
        </h4>
        <p className="whitespace-pre-wrap break-words text-sm text-slate-300">
          {task.description || t('tasks.panel.noDescription')}
        </p>
      </section>
      <TaskComments taskId={task.id} />
    </div>
  );
};

/**
 * Side panel with everything about one task. Local tasks are
 * edited here; tasks from a tracker show their details and can
 * change status. On a phone the panel takes the whole screen.
 */
const TaskPanel: React.FC<TaskPanelProps> = ({
  task,
  busy,
  onClose,
  onSaved,
  onDeleted,
  onStatus,
}) => {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  // Focus the panel, not a field: a focused field would raise
  // the keyboard on a phone before the user asked to type.
  useEffect(() => {
    panelRef.current?.focus();
  }, [task.id]);

  return (
    <div
      className="app-root fixed inset-0 z-40 flex justify-end bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('tasks.panel.label', { task: task.key || task.title })}
        className="flex h-full w-full flex-col border-l border-slate-700 bg-slate-900 shadow-2xl outline-none sm:max-w-md"
      >
        <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SOURCE_STYLE[task.source]}`}
          >
            {task.connection_name || t(SOURCE_LABEL[task.source])}
          </span>
          {task.key && (
            <span className="font-mono text-xs text-slate-400">{task.key}</span>
          )}
          {safeUrl(task.url) && (
            <a
              href={safeUrl(task.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              {t('tasks.panel.openIn', {
                source: t(SOURCE_LABEL[task.source]),
              })}{' '}
              <ExternalLink size={12} />
            </a>
          )}
          <button
            onClick={onClose}
            aria-label={t('tasks.panel.close')}
            className="ml-auto rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-50"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {task.source === 'local' ? (
            <LocalTaskEditor
              key={task.id}
              task={task}
              onSaved={onSaved}
              onDeleted={onDeleted}
            />
          ) : (
            <ExternalDetails
              task={task}
              busy={busy}
              onStatus={onStatus}
              onSaved={onSaved}
            />
          )}
        </div>
      </aside>
    </div>
  );
};

export default TaskPanel;
