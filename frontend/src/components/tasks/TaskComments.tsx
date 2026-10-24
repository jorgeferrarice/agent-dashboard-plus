import React, { useEffect, useState } from 'react';
import { addComment, errorMessage, getComments } from '../../tasksApi';
import type { TaskComment } from '../../tasksApi';
import { fieldClass } from './taskDraft';
import { useI18n } from '../../i18n';

/** The comments of a tracker's task, and a box to add one. */
const TaskComments: React.FC<{ taskId: string }> = ({ taskId }) => {
  const { t, language } = useI18n();
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getComments(taskId)
      .then((found) => !cancelled && setComments(found))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addComment(taskId, draft);
      setComments((prev) => [...(prev ?? []), added]);
      setDraft('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('tasks.comments')} className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {comments
          ? t('tasks.comments.count', { count: comments.length })
          : t('tasks.comments')}
      </h4>
      {!comments && !error && (
        <p className="text-sm text-slate-500">{t('tasks.loading')}</p>
      )}
      {comments?.length === 0 && (
        <p className="text-sm text-slate-500">{t('tasks.comments.none')}</p>
      )}
      <ol className="space-y-2">
        {comments?.map((c) => (
          <li
            key={c.id}
            className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"
          >
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-300">{c.author}</span>
              {c.created &&
                ` · ${new Date(c.created).toLocaleString(language, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}`}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">
              {c.body}
            </p>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="space-y-2">
        <textarea
          aria-label={t('tasks.comments.new')}
          rows={3}
          maxLength={20000}
          value={draft}
          placeholder={t('tasks.comments.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          className={fieldClass}
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? t('tasks.comments.sending') : t('tasks.comments.send')}
        </button>
      </form>
    </section>
  );
};

export default TaskComments;
