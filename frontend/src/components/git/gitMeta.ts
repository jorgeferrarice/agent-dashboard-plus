import type { GitProvider, PullRequest, Review } from '../../gitApi';
import type { Language, MessageKey } from '../../i18n';

/** Badge colour per Git host. */
export const PROVIDER_STYLE: Record<GitProvider, string> = {
  github: 'bg-slate-700 text-slate-100',
  bitbucket: 'bg-blue-900/70 text-blue-200',
};

export const PROVIDER_LABEL: Record<GitProvider, MessageKey> = {
  github: 'git.provider.github',
  bitbucket: 'git.provider.bitbucket',
};

export const STATE_STYLE: Record<PullRequest['state'], string> = {
  open: 'bg-emerald-900/70 text-emerald-200',
  draft: 'bg-slate-700 text-slate-300',
  merged: 'bg-violet-900/70 text-violet-200',
  closed: 'bg-red-900/70 text-red-200',
};

export const REVIEW_STYLE: Record<
  NonNullable<PullRequest['review']>,
  string
> = {
  approved: 'bg-emerald-900/70 text-emerald-200',
  changes_requested: 'bg-amber-900/70 text-amber-200',
  pending: 'bg-slate-700 text-slate-300',
};

export const CHECKS_STYLE: Record<
  NonNullable<PullRequest['checks']>,
  string
> = {
  success: 'bg-emerald-900/70 text-emerald-200',
  failure: 'bg-red-900/70 text-red-200',
  pending: 'bg-yellow-900/60 text-yellow-200',
};

export const VERDICT_STYLE: Record<Review['verdict'], string> = {
  approve: 'bg-emerald-900/70 text-emerald-200',
  comment: 'bg-slate-700 text-slate-200',
  request_changes: 'bg-amber-900/70 text-amber-200',
};

/** `repo#number`, how a pull request is named in the UI. */
export const prName = (pr: PullRequest) => `${pr.repo}#${pr.number}`;

/** A timestamp as a short date and time, or '' when missing. */
export const shortTime = (
  iso: string | null | undefined,
  language: Language,
) =>
  iso
    ? new Date(iso).toLocaleString(language, {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '';
