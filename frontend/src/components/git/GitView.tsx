import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { GitCommitHorizontal, Plug, RefreshCw, Sparkles } from 'lucide-react';
import { getGit, getGitConnections, refreshGit } from '../../gitApi';
import type { Commit, GitConnection, GitData, PullRequest } from '../../gitApi';
import { errorMessage } from '../../tasksApi';
import { safeUrl, syncedAgo } from '../tasks/taskMeta';
import { getSocket } from '../../socket';
import { useI18n } from '../../i18n';
import GitConnectionsModal from './GitConnectionsModal';
import ReviewPanel from './ReviewPanel';
import {
  CHECKS_STYLE,
  PROVIDER_STYLE,
  REVIEW_STYLE,
  STATE_STYLE,
  prName,
  shortTime,
} from './gitMeta';

const badge = 'rounded px-1.5 py-0.5 text-[10px] font-semibold';

/** Newest first; items without a date last. */
const newest = <T,>(items: T[], date: (item: T) => string | null | undefined) =>
  [...items].sort((a, b) => (date(b) || '').localeCompare(date(a) || ''));

/** A titled list, with a line for when it is empty. */
const Section: React.FC<{
  title: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}> = ({ title, empty, count, children }) => (
  <section aria-label={title} className="min-w-0">
    <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
      {title}
      <span className="rounded bg-slate-800 px-1.5 text-slate-500">
        {count}
      </span>
    </h2>
    {count === 0 ? (
      <p className="text-sm text-slate-500">{empty}</p>
    ) : (
      <ul className="space-y-2">{children}</ul>
    )}
  </section>
);

/** One pull request: badges, title, and the Review PR button. */
const PrRow: React.FC<{
  pr: PullRequest;
  showRoles: boolean;
  onReview: (pr: PullRequest) => void;
}> = ({ pr, showRoles, onReview }) => {
  const { t, language } = useI18n();
  const url = safeUrl(pr.url);
  return (
    <li className="rounded-xl border border-slate-700 bg-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${badge} ${PROVIDER_STYLE[pr.provider]}`}>
          {pr.connection_name}
        </span>
        <span className="font-mono text-xs text-slate-400">{prName(pr)}</span>
        <span className={`${badge} ${STATE_STYLE[pr.state]}`}>
          {t(`git.state.${pr.state}`)}
        </span>
        {pr.review && (
          <span className={`${badge} ${REVIEW_STYLE[pr.review]}`}>
            {t(`git.review.${pr.review}`)}
          </span>
        )}
        {pr.checks && (
          <span className={`${badge} ${CHECKS_STYLE[pr.checks]}`}>
            {t(`git.checks.${pr.checks}`)}
          </span>
        )}
        {showRoles &&
          pr.roles
            .filter((r) => r !== 'author')
            .map((r) => (
              <span key={r} className={`${badge} bg-sky-900/70 text-sky-200`}>
                {t(`git.role.${r}`)}
              </span>
            ))}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-words text-sm font-semibold text-slate-100 hover:underline"
            >
              {pr.title}
            </a>
          ) : (
            <span className="break-words text-sm font-semibold text-slate-100">
              {pr.title}
            </span>
          )}
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {[
              pr.author && t('git.by', { author: pr.author }),
              pr.source_branch &&
                `${pr.source_branch} → ${pr.target_branch ?? ''}`,
              shortTime(pr.updated_at, language),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button
          onClick={() => onReview(pr)}
          aria-label={t('git.reviewOf', { pr: prName(pr) })}
          className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-text hover:bg-accent-hover"
        >
          <Sparkles size={12} /> {t('git.reviewButton')}
        </button>
      </div>
    </li>
  );
};

const CommitRow: React.FC<{ commit: Commit }> = ({ commit }) => {
  const { language } = useI18n();
  const url = safeUrl(commit.url);
  const sha = commit.sha.slice(0, 7);
  return (
    <li className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
      <GitCommitHorizontal
        size={14}
        className="mt-0.5 shrink-0 text-slate-500"
      />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-slate-200">{commit.message}</p>
        <p className="truncate text-xs text-slate-500">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent hover:underline"
            >
              {sha}
            </a>
          ) : (
            <span className="font-mono">{sha}</span>
          )}
          {' · '}
          {[
            commit.repo,
            commit.branch,
            shortTime(commit.date, language),
            commit.connection_name,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </li>
  );
};

/**
 * The Git tab: the user's pull requests (opened, to review,
 * assigned) and recent commits from every GitHub and Bitbucket
 * connection, each pull request with a "Review PR" button.
 */
const GitView: React.FC = () => {
  const { t, language } = useI18n();
  const [data, setData] = useState<GitData>({ prs: [], commits: [] });
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [reviewing, setReviewing] = useState<PullRequest | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await getGitConnections());
    } catch (err) {
      console.error('Failed to load Git connections:', err);
    }
  }, []);

  /** Loads the lists; with `refresh`, reads the accounts first
   *  (one connection, or all of them). */
  const load = useCallback(
    async (refresh = false, connectionId?: number) => {
      setLoading(true);
      try {
        setData(await (refresh ? refreshGit(connectionId) : getGit()));
        setError(null);
      } catch (err) {
        setError(t('git.loadFailed', { error: errorMessage(err) }));
      } finally {
        setLoading(false);
      }
      await loadConnections();
      setLoaded(true);
    },
    [loadConnections, t],
  );

  useEffect(() => {
    load();
  }, [load]);

  // The backend reads the accounts every 2 minutes and says
  // when this user's lists changed.
  useEffect(() => {
    const socket = getSocket();
    const onUpdate = () => load();
    socket.on('git_updated', onUpdate);
    return () => {
      socket.off('git_updated', onUpdate);
    };
  }, [load]);

  const mine = useMemo(
    () =>
      newest(
        data.prs.filter((pr) => pr.roles.includes('author')),
        (pr) => pr.updated_at,
      ),
    [data.prs],
  );
  const toReview = useMemo(
    () =>
      newest(
        data.prs.filter(
          (pr) =>
            pr.roles.includes('reviewer') || pr.roles.includes('assignee'),
        ),
        (pr) => pr.updated_at,
      ),
    [data.prs],
  );
  const commits = useMemo(
    () => newest(data.commits, (c) => c.date),
    [data.commits],
  );
  const lastSync = connections
    .map((c) => c.last_sync_at)
    .filter((s): s is string => !!s)
    .sort()
    .pop();

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 sm:p-6">
      <header className="mb-3 flex flex-wrap items-center gap-2 sm:mb-5">
        <h1 className="text-xl font-bold text-slate-50 sm:text-2xl">
          {t('git.title')}
        </h1>
        <span className="mr-auto text-xs text-slate-500">
          {lastSync && t('git.read', { ago: syncedAgo(lastSync, t, language) })}
        </span>
        <button
          onClick={() => setManaging(true)}
          aria-label={t('git.connections')}
          title={t('git.connectionsTitle')}
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:text-slate-50"
        >
          <Plug size={14} />
          <span className="hidden sm:inline">{t('git.connections')}</span>
        </button>
        <button
          onClick={() => load(true)}
          disabled={loading}
          aria-label={t('git.refresh')}
          title={t('git.refresh')}
          className="rounded-md border border-slate-700 p-2 text-slate-400 hover:text-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
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
      {loaded && connections.length === 0 ? (
        <div className="mx-auto mt-10 max-w-md space-y-3 text-center">
          <p className="text-sm text-slate-400">{t('git.empty')}</p>
          <button
            onClick={() => setManaging(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:bg-accent-hover"
          >
            {t('tasks.conn.add')}
          </button>
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          <Section
            title={t('git.section.mine')}
            empty={t('git.none.mine')}
            count={mine.length}
          >
            {mine.map((pr) => (
              <PrRow
                key={pr.id}
                pr={pr}
                showRoles={false}
                onReview={setReviewing}
              />
            ))}
          </Section>
          <Section
            title={t('git.section.review')}
            empty={t('git.none.review')}
            count={toReview.length}
          >
            {toReview.map((pr) => (
              <PrRow key={pr.id} pr={pr} showRoles onReview={setReviewing} />
            ))}
          </Section>
          <Section
            title={t('git.section.commits')}
            empty={t('git.none.commits')}
            count={commits.length}
          >
            {commits.map((c) => (
              <CommitRow key={c.id} commit={c} />
            ))}
          </Section>
        </div>
      )}
      {reviewing && (
        <ReviewPanel
          key={reviewing.id}
          pr={reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
      {managing && (
        <GitConnectionsModal
          connections={connections}
          onClose={() => setManaging(false)}
          onChanged={() => load()}
          onRefresh={(id) => load(true, id)}
        />
      )}
    </div>
  );
};

export default GitView;
