import { describe, it, expect } from 'vitest';
import type { TaskItem } from '../../../tasksApi';
import { compareTasks, isOverdue, parseTags, sortTasks } from '../taskMeta';

const task = (id: string, fields: Partial<TaskItem> = {}): TaskItem => ({
  id,
  source: 'local',
  title: id,
  description: '',
  column: 'todo',
  status: 'todo',
  tags: [],
  ...fields,
});

describe('compareTasks', () => {
  it('orders by priority, then deadline, then latest update', () => {
    const tasks = [
      task('none-old', { updated_at: '2026-01-01T00:00:00' }),
      task('none-new', { updated_at: '2026-02-01T00:00:00' }),
      task('low', { priority: 'low' }),
      task('high-late', { priority: 'high', due_date: '2026-12-01' }),
      task('high-soon', { priority: 'high', due_date: '2026-11-01' }),
      task('high-nodate', { priority: 'high' }),
      task('urgent', { priority: 'urgent' }),
    ];
    expect(tasks.sort(compareTasks).map((t) => t.id)).toEqual([
      'urgent',
      'high-soon',
      'high-late',
      'high-nodate',
      'low',
      'none-new',
      'none-old',
    ]);
  });
});

describe('isOverdue', () => {
  it('flags only unfinished tasks past their deadline', () => {
    const now = '2026-10-21';
    expect(isOverdue(task('a', { due_date: '2026-10-20' }), now)).toBe(true);
    expect(isOverdue(task('b', { due_date: '2026-10-21' }), now)).toBe(false);
    expect(
      isOverdue(task('c', { due_date: '2026-10-01', column: 'done' }), now),
    ).toBe(false);
    expect(isOverdue(task('d'), now)).toBe(false);
  });
});

describe('parseTags', () => {
  it('splits, trims and drops blanks and repeats', () => {
    expect(parseTags(' a, b ,, a,c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('sortTasks', () => {
  const tasks = [
    task('b', { key: 'P-10', due_date: '2026-11-02' }),
    task('a', { key: 'P-9' }),
    task('c', { key: 'P-2', due_date: '2026-11-01' }),
  ];
  const ids = (list: TaskItem[]) => list.map((t) => t.id);

  it('sorts keys naturally in both directions', () => {
    expect(ids(sortTasks(tasks, { key: 'key', desc: false }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(ids(sortTasks(tasks, { key: 'key', desc: true }))).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('keeps tasks without a value last', () => {
    expect(ids(sortTasks(tasks, { key: 'due_date', desc: true }))).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('falls back to the board order without a sort', () => {
    expect(ids(sortTasks(tasks, null))).toEqual(
      ids([...tasks].sort(compareTasks)),
    );
  });
});
