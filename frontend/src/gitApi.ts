import api from './api';

/** Git hosts a connection can be made to. */
export type GitProvider = 'github' | 'bitbucket';

/** A pull request on one of the user's lists. */
export interface PullRequest {
  /** `<provider>:<connection id>:<repo>:<number>`; holds `:` and
   *  `/`, so it is always URL-encoded in paths. */
  id: string;
  provider: GitProvider;
  connection_id: number;
  connection_name: string;
  /** `owner/repo` (GitHub) or `workspace/slug` (Bitbucket). */
  repo: string;
  number: number;
  title: string;
  url?: string | null;
  author?: string | null;
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** Why it is on the user's lists. */
  roles: Array<'author' | 'assignee' | 'reviewer'>;
  review?: 'approved' | 'changes_requested' | 'pending' | null;
  /** CI status; always null for Bitbucket. */
  checks?: 'success' | 'failure' | 'pending' | null;
  source_branch?: string | null;
  target_branch?: string | null;
  /** ISO 8601. */
  updated_at?: string | null;
}

/** A commit of the user's. */
export interface Commit {
  id: string;
  provider: GitProvider;
  connection_id: number;
  connection_name: string;
  repo: string;
  sha: string;
  /** First line of the message only. */
  message: string;
  url?: string | null;
  branch?: string | null;
  /** ISO 8601. */
  date?: string | null;
}

export interface GitData {
  prs: PullRequest[];
  commits: Commit[];
}

/** A connection to a GitHub or Bitbucket account. The token
 *  never comes back. */
export interface GitConnection {
  id: number;
  provider: GitProvider;
  name: string;
  /** Settings that are not secret, plus `account`: who the
   *  token belongs to. */
  config: { account?: string; email?: string; workspaces?: string[] };
  last_sync_at?: string | null;
  /** Why the last read failed; null when it worked. */
  last_error?: string | null;
  pr_count: number;
  commit_count: number;
}

export interface GitConnectionChange {
  name?: string;
  config?: { email?: string; workspaces?: string[] };
  /** Blank keeps the saved token. */
  secret?: string;
}

/** A comment the review suggests; no path means a general one. */
export interface ReviewComment {
  path?: string | null;
  line?: number | null;
  body: string;
}

/** Claude's review of a pull request. */
export interface Review {
  pr_id: string;
  head_sha?: string | null;
  model: string;
  created_at: string;
  summary: string;
  verdict: 'approve' | 'comment' | 'request_changes';
  /** Language of the comments, e.g. `pt-BR`. */
  language: string;
  comments: ReviewComment[];
}

/** What posting a comment did. `inline` false: it went in as a
 *  general comment (e.g. the line is not in the diff). */
export interface PostResult {
  url?: string | null;
  inline: boolean;
}

const prPath = (prId: string) => `/git/prs/${encodeURIComponent(prId)}`;

export const getGit = async (): Promise<GitData> =>
  (await api.get('/git')).data;

/** Reads the accounts again (one connection, or all). */
export const refreshGit = async (connectionId?: number): Promise<GitData> =>
  (await api.post('/git/refresh', { connection_id: connectionId ?? null }))
    .data;

export const getGitConnections = async (): Promise<GitConnection[]> =>
  (await api.get('/git/connections')).data;

/** Adds a connection; the server checks the token first. */
export const createGitConnection = async (fields: {
  provider: GitProvider;
  name: string;
  config: { email?: string; workspaces?: string[] };
  secret: string;
}): Promise<GitConnection> => (await api.post('/git/connections', fields)).data;

export const updateGitConnection = async (
  id: number,
  change: GitConnectionChange,
): Promise<GitConnection> =>
  (await api.patch(`/git/connections/${id}`, change)).data;

export const deleteGitConnection = async (id: number): Promise<void> => {
  await api.delete(`/git/connections/${id}`);
};

/** The last review saved for a pull request; null when there
 *  is none yet. */
export const getReview = async (prId: string): Promise<Review | null> => {
  try {
    return (await api.get(`${prPath(prId)}/review`)).data;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) return null;
    throw err;
  }
};

/** Asks Claude for a new review. Slow: up to a few minutes. */
export const runReview = async (prId: string): Promise<Review> =>
  (await api.post(`${prPath(prId)}/review`)).data;

/** Posts one comment, as the user wrote it, on the pull request. */
export const postComment = async (
  prId: string,
  comment: ReviewComment,
): Promise<PostResult> =>
  (
    await api.post(`${prPath(prId)}/comments`, {
      body: comment.body,
      path: comment.path ?? null,
      line: comment.line ?? null,
    })
  ).data;
