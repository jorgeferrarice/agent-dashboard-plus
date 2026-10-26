import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { getReview, postComment, runReview } from '../../gitApi';
import type {
  PostResult,
  PullRequest,
  Review,
  ReviewComment,
} from '../../gitApi';
import { errorMessage } from '../../tasksApi';
import { safeUrl } from '../tasks/taskMeta';
import { fieldClass } from '../tasks/taskDraft';
import { useI18n } from '../../i18n';
import { VERDICT_STYLE, prName, shortTime } from './gitMeta';

/** One suggested comment: editable, posted only on a click. */
const SuggestedComment: React.FC<{
  prId: string;
  comment: ReviewComment;
}> = ({ prId, comment }) => {
  const { t } = useI18n();
  const [text, setText] = useState(comment.body);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<PostResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = comment.path
    ? comment.line
      ? `${comment.path}:${comment.line}`
      : comment.path
    : t('git.panel.general');

  const post = async () => {
    setPosting(true);
    setError(null);
    try {
      setPosted(
        await postComment(prId, {
          body: text.trim(),
          path: comment.path,
          line: comment.line,
        }),
      );
    } catch (err) {
      setError(t('git.panel.postFailed', { error: errorMessage(err) }));
    } finally {
      setPosting(false);
    }
  };

  return (
    <li className="space-y-2 rounded-xl border border-slate-700 bg-slate-800 p-3">
      <p className="break-all font-mono text-xs text-slate-400">{where}</p>
      <textarea
        rows={4}
        value={text}
        disabled={!!posted}
        aria-label={t('git.panel.commentLabel', { where })}
        onChange={(e) => setText(e.target.value)}
        className={`${fieldClass} disabled:opacity-70`}
      />
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {posted ? (
        <div className="space-y-1 text-xs">
          <p className="flex items-center gap-2 font-semibold text-emerald-300">
            {t('git.panel.posted')}
            {safeUrl(posted.url) && (
              <a
                href={safeUrl(posted.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 font-normal text-accent hover:underline"
              >
                {t('git.panel.view')} <ExternalLink size={12} />
              </a>
            )}
          </p>
          {!posted.inline && comment.path && (
            <p className="text-amber-300">{t('git.panel.postedGeneral')}</p>
          )}
        </div>
      ) : (
        <button
          onClick={post}
          disabled={posting || !text.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:bg-accent-hover disabled:opacity-50"
        >
          {posting ? t('git.panel.posting') : t('git.panel.post')}
        </button>
      )}
    </li>
  );
};

/**
 * Side panel with Claude's review of a pull request. Opening it
 * shows the saved review, or starts one when there is none (the
 * click on "Review PR" is the request). Suggested comments are
 * only posted when the user clicks Post on each. On a phone the
 * panel takes the whole screen.
 */
const ReviewPanel: React.FC<{ pr: PullRequest; onClose: () => void }> = ({
  pr,
  onClose,
}) => {
  const { t, language } = useI18n();
  const [review, setReview] = useState<Review | null>(null);
  const [phase, setPhase] = useState<'loading' | 'running' | 'idle'>('loading');
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // A review costs money: StrictMode's second effect run must
  // not start another one.
  const started = useRef(false);

  const run = async () => {
    setPhase('running');
    setError(null);
    try {
      setReview(await runReview(pr.id));
    } catch (err) {
      setError(t('git.panel.failed', { error: errorMessage(err) }));
    } finally {
      setPhase('idle');
    }
  };

  useEffect(() => {
    panelRef.current?.focus();
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const saved = await getReview(pr.id);
        if (saved) {
          setReview(saved);
          setPhase('idle');
        } else {
          await run();
        }
      } catch (err) {
        setError(t('git.panel.failed', { error: errorMessage(err) }));
        setPhase('idle');
      }
    })();
    // Runs once per panel: the panel is keyed by pull request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        aria-label={t('git.panel.label', { pr: prName(pr) })}
        className="flex h-full w-full flex-col border-l border-slate-700 bg-slate-900 shadow-2xl outline-none sm:max-w-xl"
      >
        <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <span className="min-w-0 truncate font-mono text-xs text-slate-400">
            {prName(pr)}
          </span>
          {safeUrl(pr.url) && (
            <a
              href={safeUrl(pr.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
            >
              {t('git.panel.open')} <ExternalLink size={12} />
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
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <h3 className="break-words text-lg font-semibold text-slate-50">
            {pr.title}
          </h3>
          {phase === 'loading' && (
            <p role="status" className="text-sm text-slate-400">
              {t('git.panel.loading')}
            </p>
          )}
          {phase === 'running' && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-slate-300"
            >
              <RefreshCw size={14} className="animate-spin" />
              {t('git.panel.running')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {phase === 'idle' && (
            <button
              onClick={run}
              className="flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              <RefreshCw size={14} />
              {review ? t('git.panel.again') : t('git.panel.start')}
            </button>
          )}
          {review && phase !== 'running' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${VERDICT_STYLE[review.verdict]}`}
                >
                  {t(`git.verdict.${review.verdict}`)}
                </span>
                <span>
                  {t('git.panel.reviewed', {
                    when: shortTime(review.created_at, language),
                    model: review.model,
                  })}
                </span>
                <span>
                  {t('git.panel.language', { language: review.language })}
                </span>
              </div>
              <section aria-label={t('git.panel.summary')}>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {t('git.panel.summary')}
                </h4>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-200">
                  {review.summary}
                </p>
              </section>
              <section aria-label={t('git.panel.suggestions')}>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {t('git.panel.suggestions')}
                </h4>
                {review.comments.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    {t('git.panel.noSuggestions')}
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-slate-500">
                      {t('git.panel.nothingPosted')}
                    </p>
                    <ul className="space-y-3">
                      {review.comments.map((c, i) => (
                        <SuggestedComment
                          // A new review starts every draft over.
                          key={`${review.created_at}:${i}`}
                          prId={pr.id}
                          comment={c}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
};

export default ReviewPanel;
