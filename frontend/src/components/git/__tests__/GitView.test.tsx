import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { GitConnection, GitData, PullRequest } from '../../../gitApi';

let data: GitData = { prs: [], commits: [] };
let connections: GitConnection[] = [];
vi.mock('../../../gitApi', () => ({
  getGit: async () => data,
  refreshGit: async () => data,
  getGitConnections: async () => connections,
}));
const socketHandlers: Record<string, () => void> = {};
vi.mock('../../../socket', () => ({
  getSocket: () => ({
    on: (event: string, fn: () => void) => {
      socketHandlers[event] = fn;
    },
    off: () => {},
  }),
}));

import GitView from '../GitView';

const pr = (over: Partial<PullRequest>): PullRequest => ({
  id: `github:1:acme/app:${over.number ?? 1}`,
  provider: 'github',
  connection_id: 1,
  connection_name: 'GitHub work',
  repo: 'acme/app',
  number: 1,
  title: 'A change',
  state: 'open',
  roles: ['author'],
  ...over,
});

const conn: GitConnection = {
  id: 1,
  provider: 'github',
  name: 'GitHub work',
  config: { account: 'me' },
  last_sync_at: null,
  last_error: null,
  pr_count: 0,
  commit_count: 0,
};

const settle = () => act(async () => {});
const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  data = { prs: [], commits: [] };
  connections = [conn];
});

describe('GitView', () => {
  it('splits pull requests by role and shows their badges', async () => {
    data = {
      prs: [
        pr({
          number: 1,
          title: 'Mine',
          state: 'merged',
          review: 'approved',
          checks: 'failure',
        }),
        pr({ number: 2, title: 'Theirs', roles: ['reviewer'] }),
        pr({ number: 3, title: 'Given to me', roles: ['assignee'] }),
      ],
      commits: [
        {
          id: 'github:1:abc',
          provider: 'github',
          connection_id: 1,
          connection_name: 'GitHub work',
          repo: 'acme/app',
          sha: 'abcdef1234567',
          message: 'Fix the parser',
          date: '2026-10-20T10:00:00Z',
        },
      ],
    };
    render(<GitView />);
    await settle();
    const mine = section('My pull requests');
    expect(within(mine).getByText('Mine')).toBeInTheDocument();
    expect(within(mine).getByText('Merged')).toBeInTheDocument();
    expect(within(mine).getByText('Approved')).toBeInTheDocument();
    expect(within(mine).getByText('CI failed')).toBeInTheDocument();
    expect(within(mine).queryByText('Theirs')).not.toBeInTheDocument();
    const review = section('To review / assigned to me');
    expect(within(review).getByText('Theirs')).toBeInTheDocument();
    expect(within(review).getByText('Review requested')).toBeInTheDocument();
    expect(within(review).getByText('Assigned')).toBeInTheDocument();
    expect(
      within(section('My commits')).getByText('Fix the parser'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Review / })).toHaveLength(3);
  });

  it('shows why a connection failed', async () => {
    connections = [{ ...conn, last_error: 'GitHub rejected the token' }];
    render(<GitView />);
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'GitHub work: GitHub rejected the token',
    );
  });

  it('invites adding a connection when there is none', async () => {
    connections = [];
    render(<GitView />);
    await settle();
    expect(
      screen.getByText(/No Git account connected yet/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'My pull requests' }),
    ).not.toBeInTheDocument();
  });

  it('reloads when the server says the lists changed', async () => {
    render(<GitView />);
    await settle();
    data = { prs: [pr({ title: 'New one' })], commits: [] };
    await act(async () => socketHandlers.git_updated());
    expect(screen.getByText('New one')).toBeInTheDocument();
  });
});
