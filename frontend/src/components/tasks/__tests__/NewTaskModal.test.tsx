import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Connection, NewExternalTask } from '../../../tasksApi';

const sent: [number, NewExternalTask][] = [];
let refuse: string | null = null;
vi.mock('../../../tasksApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../tasksApi')>();
  return {
    ...real,
    getCreateOptions: async () => ({
      projects: [
        { id: 'P', name: 'Platform (P)' },
        { id: 'W', name: 'Web (W)' },
      ],
      priorities: [{ id: '1', name: 'Highest' }],
      create_url: 'https://team.atlassian.net/secure/CreateIssue!default.jspa',
    }),
    getTaskTypes: async (_c: number, project: string) =>
      project === 'W'
        ? [{ id: '20', name: 'Story' }]
        : [
            { id: '10', name: 'Task' },
            { id: '11', name: 'Bug' },
          ],
    createExternalTask: async (id: number, task: NewExternalTask) => {
      if (refuse) throw { response: { data: { detail: refuse } } };
      sent.push([id, task]);
      return { id: `jira:${id}:P-9`, title: task.title };
    },
  };
});

import NewTaskModal from '../NewTaskModal';

const conn: Connection = {
  id: 2,
  provider: 'jira',
  name: 'Work',
  config: { account: 'Me Myself' },
  filters: {},
  mapping: {},
  task_count: 0,
};

describe('NewTaskModal in a tracker', () => {
  it('creates a Jira issue with project, type and priority', async () => {
    const created = vi.fn();
    const closed = vi.fn();
    render(
      <NewTaskModal
        connections={[conn]}
        onClose={closed}
        onCreate={async () => {}}
        onCreated={created}
      />,
    );
    fireEvent.change(screen.getByLabelText('Create in'), {
      target: { value: '2' },
    });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: 'W' },
    });
    await act(async () => {});
    expect(screen.getByLabelText('Type')).toHaveValue('20');
    fireEvent.change(screen.getByLabelText('Priority'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Ship it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(sent).toEqual([
      [
        2,
        {
          project: 'W',
          type: '20',
          priority: '1',
          title: 'Ship it',
          description: '',
        },
      ],
    ]);
    expect(created).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it('links to the tracker when it asks for more fields', async () => {
    refuse = 'Jira answered HTTP 400: customfield_9: Team is required.';
    render(
      <NewTaskModal
        connections={[conn]}
        onClose={() => {}}
        onCreate={async () => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Create in'), {
      target: { value: '2' },
    });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'X' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Team is required');
    expect(
      screen.getByRole('link', { name: /Create it in Jira Cloud/ }),
    ).toHaveAttribute('href', expect.stringContaining('CreateIssue'));
  });
});
