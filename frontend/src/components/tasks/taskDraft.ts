import type {
  Column,
  LocalTaskFields,
  Priority,
  TaskItem,
} from '../../tasksApi';
import { parseTags } from './taskMeta';

/** The fields of a local task as the form edits them: tags are
 *  the text typed, split only when saved. */
export interface TaskDraft {
  title: string;
  description: string;
  column: Column;
  priority: Priority | '';
  due_date: string;
  tags: string;
}

export const EMPTY_DRAFT: TaskDraft = {
  title: '',
  description: '',
  column: 'todo',
  priority: '',
  due_date: '',
  tags: '',
};

/** What the API takes for a draft. */
export const draftFields = (
  draft: TaskDraft,
): LocalTaskFields & { title: string } => ({
  title: draft.title,
  description: draft.description,
  column: draft.column,
  priority: draft.priority || null,
  due_date: draft.due_date || null,
  tags: parseTags(draft.tags),
});

export const fieldClass =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-accent';

/** A draft holding a task's current values. */
export const taskDraft = (task: TaskItem): TaskDraft => ({
  title: task.title,
  description: task.description,
  column: task.column,
  priority: task.priority ?? '',
  due_date: task.due_date ?? '',
  tags: task.tags.join(', '),
});
