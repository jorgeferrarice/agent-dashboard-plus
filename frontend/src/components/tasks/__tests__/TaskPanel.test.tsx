import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TaskComment, TaskItem } from '../../../tasksApi';

let comments: TaskComment[] = [];
const assigned: (string | null)[] = [];
vi.mock('../../../tasksApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../tasksApi')>();
  return {
    ...real,
    getComments: async () => comments,
    addComment: async (_id: string, body: string) => {
      const c = {
        id: String(comments.length),
        author: 'Me',
        body: body.trim(),
      };
      comments = [...comments, c];
      return c;
    },
    searchUsers: async () => [
      { id: 'acc-1', name: 'Ana' },
      { id: 'acc-2', name: 'Bruno' },
    ],
    setAssignee: async (_id: string, userId: string | null) => {
      assigned.push(userId);
      return { ...jiraTask, assignee: userId === 'acc-1' ? 'Ana' : null };
    },
  };
});

import TaskPanel from '../TaskPanel';

const jiraTask: TaskItem = {
  id: 'jira:1:P-1',
  source: 'jira',
  connection_id: 1,
  connection_name: 'Work',
  key: 'P-1',
  title: 'Fix login',
  description: 'Steps…',
  column: 'todo',
  status: 'To Do',
  tags: [],
  assignee: 'Me Myself',
  url: 'https://team.atlassian.net/browse/P-1',
};

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  comments = [{ id: 'c1', author: 'Ana', body: 'First!' }];
  assigned.length = 0;
});

describe('TaskPanel for a tracker task', () => {
  it('lists comments and adds one', async () => {
    render(
      <TaskPanel
        task={jiraTask}
        onClose={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        onStatus={() => {}}
      />,
    );
    await wait(0);
    const section = screen.getByRole('region', { name: 'Comments' });
    expect(within(section).getByText('First!')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New comment'), {
      target: { value: 'On it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    });
    expect(within(section).getByText('On it')).toBeInTheDocument();
    expect(screen.getByLabelText('New comment')).toHaveValue('');
  });

  it('reassigns and unassigns', async () => {
    const saved: TaskItem[] = [];
    render(
      <TaskPanel
        task={jiraTask}
        onClose={() => {}}
        onSaved={(t) => saved.push(t)}
        onDeleted={() => {}}
        onStatus={() => {}}
      />,
    );
    await wait(0);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.focus(screen.getByRole('combobox', { name: 'Assign to' }));
    await wait(300);
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    });
    expect(assigned).toEqual(['acc-1']);
    expect(saved[0].assignee).toBe('Ana');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    });
    expect(assigned).toEqual(['acc-1', null]);
  });
});
