import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { GitConnection } from '../../../gitApi';

const created: unknown[] = [];
const updated: [number, unknown][] = [];
vi.mock('../../../gitApi', () => ({
  createGitConnection: async (fields: unknown) => {
    created.push(fields);
    return fields;
  },
  updateGitConnection: async (id: number, change: unknown) => {
    updated.push([id, change]);
    return change;
  },
  deleteGitConnection: async () => {},
}));

import GitConnectionsModal from '../GitConnectionsModal';

const bitbucket: GitConnection = {
  id: 4,
  provider: 'bitbucket',
  name: 'Bitbucket',
  config: { account: 'Me', email: 'me@example.com', workspaces: ['acme'] },
  last_sync_at: null,
  last_error: null,
  pr_count: 2,
  commit_count: 5,
};

const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  created.length = 0;
  updated.length = 0;
});

describe('GitConnectionsModal', () => {
  it('adds a Bitbucket connection with email, workspaces and token', async () => {
    const onChanged = vi.fn();
    render(
      <GitConnectionsModal
        connections={[]}
        onClose={() => {}}
        onChanged={onChanged}
        onRefresh={async () => {}}
      />,
    );
    fill(/Service/, 'bitbucket');
    fill(/^Name/, 'Work');
    fill(/Atlassian account email/, 'me@example.com');
    fill(/Workspaces/, 'acme, side-project, acme');
    fill(/API token/, 'secret-token');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    expect(created).toEqual([
      {
        provider: 'bitbucket',
        name: 'Work',
        config: {
          email: 'me@example.com',
          workspaces: ['acme', 'side-project'],
        },
        secret: 'secret-token',
      },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('never fills in the saved token and keeps it when left blank', async () => {
    render(
      <GitConnectionsModal
        connections={[bitbucket]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bitbucket' }));
    expect(screen.getByLabelText(/API token/)).toHaveValue('');
    expect(screen.getByLabelText(/Workspaces/)).toHaveValue('acme');
    fill(/^Name/, 'Renamed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updated).toEqual([[4, { name: 'Renamed' }]]);
  });

  it('asks before removing a connection', () => {
    render(
      <GitConnectionsModal
        connections={[bitbucket]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bitbucket' }));
    expect(screen.getByText(/Remove this connection\?/)).toBeInTheDocument();
  });
});
