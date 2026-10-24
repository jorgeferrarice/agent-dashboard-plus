import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TaskItem } from '../../../tasksApi';

// An in-memory server for the tasks API.
let tasks: TaskItem[] = [];
let next = 1;
let connections: unknown[] = [];
// Overrides the statuses offered and the result of a move.
let statuses:
  | { id: string; name: string; column: string; fields?: unknown[] }[]
  | null = null;
let failMove = false;
// Fields sent with the last move.
let movedWith: unknown = null;
vi.mock('../../../tasksApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../tasksApi')>();
  return {
    ...real,
    getTasks: async () => tasks,
    refreshTasks: async () => tasks,
    getConnections: async () => connections,
    createLocalTask: async (fields: { title: string; column?: string }) => {
      const task = {
        id: `local:${next++}`,
        source: 'local',
        title: fields.title,
        description: '',
        column: fields.column ?? 'todo',
        status: fields.column ?? 'todo',
        tags: [],
      } as TaskItem;
      tasks = [...tasks, task];
      return task;
    },
    updateLocalTask: async (id: string, fields: Partial<TaskItem>) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...fields } : t));
      return tasks.find((t) => t.id === id)!;
    },
    deleteLocalTask: async (id: string) => {
      tasks = tasks.filter((t) => t.id !== id);
    },
    getStatuses: async () =>
      statuses ??
      real.COLUMNS.map((c) => ({
        id: c,
        name: c,
        column: c,
      })),
    changeStatus: async (id: string, statusId: string, fields?: unknown) => {
      if (failMove) throw new Error('refused');
      movedWith = fields ?? null;
      const to = statuses?.find((o) => o.id === statusId)?.column ?? statusId;
      tasks = tasks.map((t) =>
        t.id === id ? { ...t, column: to, status: statusId } : t,
      ) as TaskItem[];
      return tasks.find((t) => t.id === id)!;
    },
  };
});

const socketHandlers: Record<string, () => void> = {};
vi.mock('../../../socket', () => ({
  getSocket: () => ({
    on: (event: string, fn: () => void) => {
      socketHandlers[event] = fn;
    },
    off: () => {},
  }),
}));

import TasksView from '../TasksView';

const column = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  // Node's own localStorage global shadows jsdom's: use an
  // in-memory one, fresh for each test.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  tasks = [];
  connections = [];
  next = 1;
  statuses = null;
  failMove = false;
  movedWith = null;
});

const localTask = (title: string): TaskItem => ({
  id: `local:${title}`,
  source: 'local',
  title,
  description: '',
  column: 'todo',
  status: 'todo',
  tags: [],
});

/** Drags the card titled `title` onto the column `to`. */
async function drag(title: string, to: string) {
  const card = screen.getByRole('article', { name: title }).parentElement!;
  const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(column(to), { dataTransfer });
  await act(async () => {
    fireEvent.drop(column(to), { dataTransfer });
  });
  fireEvent.dragEnd(card, { dataTransfer });
}

describe('TasksView', () => {
  it('creates a local task and moves it with the status dropdown', async () => {
    render(<TasksView />);
    await act(async () => {});
    expect(screen.getAllByRole('region')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: /New task/ }));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Write docs' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(within(column('To do')).getByText('Write docs')).toBeInTheDocument();

    const select = screen.getByLabelText('Status of Write docs');
    await act(async () => {
      fireEvent.focus(select);
    });
    // The current status shows once, as the current choice.
    expect(
      within(select).getAllByRole('option', { name: 'To do' }),
    ).toHaveLength(1);
    expect(
      within(select).getByRole('option', { name: 'In review' }),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(select, { target: { value: 'review' } });
    });
    expect(
      within(column('In review')).getByText('Write docs'),
    ).toBeInTheDocument();
    expect(within(column('To do')).queryByText('Write docs')).toBeNull();
  });

  it('switches to the list view grouped by column', async () => {
    tasks = [
      {
        id: 'local:7',
        source: 'local',
        title: 'Listed',
        description: '',
        column: 'done',
        status: 'done',
        tags: [],
      },
    ];
    render(<TasksView />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    const done = screen.getByRole('rowgroup', { name: 'Done' });
    expect(within(done).getByText('Listed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    expect(screen.getByRole('columnheader', { name: /Title/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('moves a card dragged onto another column', async () => {
    tasks = [localTask('Drag me')];
    render(<TasksView />);
    await act(async () => {});
    await drag('Drag me', 'Done');
    expect(within(column('Done')).getByText('Drag me')).toBeInTheDocument();
  });

  it('asks which status when the column has several', async () => {
    tasks = [localTask('Pick')];
    statuses = [
      { id: 's1', name: 'Code review', column: 'review' },
      { id: 's2', name: 'QA', column: 'review' },
      { id: 's3', name: 'Doing', column: 'in_progress' },
    ];
    render(<TasksView />);
    await act(async () => {});
    await drag('Pick', 'In review');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('Doing')).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'QA' }));
    });
    expect(within(column('In review')).getByText('Pick')).toBeInTheDocument();
    expect(tasks[0].status).toBe('s2');
  });

  it('keeps the card and explains when the column has no status for it', async () => {
    tasks = [localTask('Stuck')];
    statuses = [{ id: 's3', name: 'Doing', column: 'in_progress' }];
    render(<TasksView />);
    await act(async () => {});
    await drag('Stuck', 'Done');
    expect(within(column('To do')).getByText('Stuck')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot move to Done/);
  });

  it('puts the card back when the server refuses the move', async () => {
    tasks = [localTask('Refused')];
    failMove = true;
    render(<TasksView />);
    await act(async () => {});
    await drag('Refused', 'Done');
    expect(within(column('To do')).getByText('Refused')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/refused/);
  });

  it('edits and deletes a local task from its side panel', async () => {
    tasks = [localTask('Old title')];
    render(<TasksView />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Old title' }));
    const panel = screen.getByRole('dialog', { name: /Task Old title/ });
    const save = within(panel).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(within(panel).getByLabelText('Title'), {
      target: { value: 'New title' },
    });
    fireEvent.change(within(panel).getByLabelText('Priority'), {
      target: { value: 'high' },
    });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(tasks[0]).toMatchObject({ title: 'New title', priority: 'high' });
    expect(
      within(column('To do')).getByRole('button', { name: 'New title' }),
    ).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /Delete task/ }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Delete' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('New title')).toBeNull();
    expect(tasks).toEqual([]);
  });

  it('closes the side panel with Escape', async () => {
    tasks = [localTask('Peek')];
    render(<TasksView />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Peek' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reloads the board when the backend says it changed', async () => {
    render(<TasksView />);
    await act(async () => {});
    expect(screen.queryByText('Arrived')).toBeNull();
    tasks = [localTask('Arrived')];
    await act(async () => {
      socketHandlers.tasks_updated();
    });
    expect(screen.getByText('Arrived')).toBeInTheDocument();
  });

  it('asks for the fields a status requires before moving', async () => {
    tasks = [localTask('Close me')];
    statuses = [
      {
        id: '31',
        name: 'Done',
        column: 'done',
        fields: [
          {
            id: 'resolution',
            name: 'Resolution',
            kind: 'select',
            options: [{ id: '1', name: 'Fixed' }],
          },
        ],
      },
    ];
    render(<TasksView />);
    await act(async () => {});
    await drag('Close me', 'Done');
    const form = screen.getByRole('dialog', { name: 'Move to Done' });
    const move = within(form).getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    // Cancelling leaves the card where it was.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(column('To do')).getByText('Close me')).toBeInTheDocument();

    await drag('Close me', 'Done');
    fireEvent.change(screen.getByLabelText('Resolution'), {
      target: { value: '1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    });
    expect(movedWith).toEqual({ resolution: '1' });
    expect(within(column('Done')).getByText('Close me')).toBeInTheDocument();
  });

  it('hides and shows sources with the chips', async () => {
    connections = [
      {
        id: 4,
        provider: 'jira',
        name: 'Work',
        config: {},
        filters: {},
        mapping: {},
        task_count: 1,
      },
    ];
    tasks = [
      localTask('Mine'),
      {
        ...localTask('From Jira'),
        id: 'jira:4:P-1',
        source: 'jira',
        connection_id: 4,
        connection_name: 'Work',
      },
    ];
    render(<TasksView />);
    await act(async () => {});
    const chips = screen.getByRole('group', { name: 'Show tasks from' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Work' }));
    expect(screen.queryByText('From Jira')).toBeNull();
    expect(screen.getByText('Mine')).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole('button', { name: 'Work' }));
    fireEvent.click(within(chips).getByRole('button', { name: 'Local' }));
    expect(screen.getByText('From Jira')).toBeInTheDocument();
    expect(screen.queryByText('Mine')).toBeNull();
  });
});
