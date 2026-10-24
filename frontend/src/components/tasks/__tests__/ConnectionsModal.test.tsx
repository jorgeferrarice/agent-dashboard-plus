import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Connection } from '../../../tasksApi';

const created: unknown[] = [];
const updated: [number, unknown][] = [];
let failCreate: string | null = null;
vi.mock('../../../tasksApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../tasksApi')>();
  return {
    ...real,
    createConnection: async (fields: unknown) => {
      if (failCreate) {
        throw { response: { data: { detail: failCreate } } };
      }
      created.push(fields);
      return fields;
    },
    updateConnection: async (id: number, change: unknown) => {
      updated.push([id, change]);
      return change;
    },
    deleteConnection: async () => {},
    getStatusColumns: async () => [
      {
        name: 'In Progress',
        category: 'in_progress',
        auto_column: 'in_progress',
        column: 'in_progress',
      },
      {
        name: 'QA',
        category: 'in_progress',
        auto_column: 'review',
        column: 'todo',
      },
    ],
  };
});

import ConnectionsModal from '../ConnectionsModal';

const conn: Connection = {
  id: 3,
  provider: 'jira',
  name: 'Work',
  config: {
    site: 'https://team.atlassian.net',
    email: 'me@example.com',
    account: 'Me',
  },
  filters: {},
  mapping: {},
  last_sync_at: null,
  last_error: 'Jira rejected the credentials',
  task_count: 0,
};

beforeEach(() => {
  created.length = 0;
  updated.length = 0;
  failCreate = null;
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(label)), {
    target: { value },
  });

describe('ConnectionsModal', () => {
  it('adds a Jira connection', async () => {
    const onChanged = vi.fn();
    render(
      <ConnectionsModal
        connections={[]}
        onClose={() => {}}
        onChanged={onChanged}
        onRefresh={async () => {}}
      />,
    );
    // With no connection yet, the form is open right away.
    fill('^Name', 'Work');
    fill('Site', 'https://team.atlassian.net');
    fill('Account email', 'me@example.com');
    fill('API token', 'tok');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    expect(created).toEqual([
      {
        provider: 'jira',
        name: 'Work',
        config: { site: 'https://team.atlassian.net', email: 'me@example.com' },
        secret: 'tok',
      },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows why a connection was refused', async () => {
    failCreate = 'Jira rejected the credentials (HTTP 401).';
    render(
      <ConnectionsModal
        connections={[]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fill('^Name', 'Work');
    fill('Site', 'https://team.atlassian.net');
    fill('Account email', 'a@b.c');
    fill('API token', 'bad');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 401');
  });

  it('lists connections with their error and edits without resending the token', async () => {
    render(
      <ConnectionsModal
        connections={[conn]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('rejected');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work' }));
    fill('^Name', 'Job');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updated).toEqual([[3, { name: 'Job' }]]);
  });

  it('saves filters with the connection', async () => {
    render(
      <ConnectionsModal
        connections={[conn]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work' }));
    fireEvent.change(screen.getByLabelText('Assigned to'), {
      target: { value: 'any' },
    });
    fill('Project keys', 'WEB, API');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updated).toEqual([
      [
        3,
        {
          name: 'Work',
          filters: {
            assignee: 'any',
            projects: ['WEB', 'API'],
            done_days: 14,
            query: '',
          },
        },
      ],
    ]);
  });

  it('maps statuses to columns, saving only the changes', async () => {
    render(
      <ConnectionsModal
        connections={[{ ...conn, mapping: { QA: 'todo' } }]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work' }));
    await act(async () => {});
    expect(screen.getByLabelText('Column for QA')).toHaveValue('todo');
    fireEvent.change(screen.getByLabelText('Column for In Progress'), {
      target: { value: 'review' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updated).toEqual([
      [3, { name: 'Work', mapping: { 'In Progress': 'review', QA: 'todo' } }],
    ]);
  });

  it('resets every status to its automatic column', async () => {
    render(
      <ConnectionsModal
        connections={[{ ...conn, mapping: { QA: 'todo' } }]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reset to automatic' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updated).toEqual([[3, { name: 'Work', mapping: {} }]]);
  });

  it('adds a Shortcut connection with only a token', async () => {
    render(
      <ConnectionsModal
        connections={[]}
        onClose={() => {}}
        onChanged={() => {}}
        onRefresh={async () => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Tracker'), {
      target: { value: 'shortcut' },
    });
    expect(screen.queryByLabelText('Site')).toBeNull();
    fill('^Name', 'Acme');
    fill('API token', 'sc');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    expect(created).toEqual([
      { provider: 'shortcut', name: 'Acme', config: {}, secret: 'sc' },
    ]);
  });
});
