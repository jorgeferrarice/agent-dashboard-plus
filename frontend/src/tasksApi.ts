import api from './api';
import { isLanguage, translate } from './i18n';
import type { MessageKey } from './i18n';

/** Board columns, left to right. */
export const COLUMNS = ['todo', 'in_progress', 'review', 'done'] as const;
export type Column = (typeof COLUMNS)[number];

/** Message key of each column's name. */
export const COLUMN_LABELS: Record<Column, MessageKey> = {
  todo: 'tasks.column.todo',
  in_progress: 'tasks.column.in_progress',
  review: 'tasks.column.review',
  done: 'tasks.column.done',
};

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

/** A task as the board shows it, whatever its source. */
export interface TaskItem {
  /** `<source>:<id within the source>`, e.g. `local:12`. */
  id: string;
  source: 'local' | 'jira' | 'shortcut' | 'huly';
  connection_id?: number | null;
  connection_name?: string | null;
  /** The tracker's own key, e.g. `PROJ-12`. */
  key?: string | null;
  title: string;
  description: string;
  column: Column;
  /** The tracker's own status name. */
  status: string;
  priority?: Priority | null;
  /** `YYYY-MM-DD`. */
  due_date?: string | null;
  tags: string[];
  assignee?: string | null;
  url?: string | null;
  updated_at?: string | null;
}

/** A value to pick: an allowed field value, or a person. */
export interface Choice {
  id: string;
  name: string;
}

/** A field a tracker requires when moving to a status. */
export interface StatusField {
  id: string;
  name: string;
  kind:
    | 'select'
    | 'multiselect'
    | 'text'
    | 'richtext'
    | 'user'
    | 'date'
    | 'number'
    | 'unsupported';
  options: Choice[];
}

/** A status a task can be moved to. */
export interface StatusOption {
  id: string;
  name: string;
  column: Column;
  /** Required fields to fill on the way; empty when none. */
  fields?: StatusField[];
}

/** Fields of a local task. */
export interface LocalTaskFields {
  title: string;
  description: string;
  column: Column;
  priority: Priority | null;
  due_date: string | null;
  tags: string[];
}

export const getTasks = async (): Promise<TaskItem[]> =>
  (await api.get('/tasks')).data;

export const createLocalTask = async (
  fields: Partial<LocalTaskFields> & { title: string },
): Promise<TaskItem> => (await api.post('/tasks/local', fields)).data;

/** Changes the given fields; the others keep their value. */
export const updateLocalTask = async (
  taskId: string,
  fields: Partial<LocalTaskFields>,
): Promise<TaskItem> =>
  (await api.patch(`/tasks/local/${taskId.replace(/^local:/, '')}`, fields))
    .data;

export const deleteLocalTask = async (taskId: string): Promise<void> => {
  await api.delete(`/tasks/local/${taskId.replace(/^local:/, '')}`);
};

/** The statuses a task can move to right now. */
export const getStatuses = async (taskId: string): Promise<StatusOption[]> =>
  (await api.get(`/tasks/${encodeURIComponent(taskId)}/statuses`)).data;

/** Moves a task; `fields` fills what the status requires. */
export const changeStatus = async (
  taskId: string,
  statusId: string,
  fields?: Record<string, unknown>,
): Promise<TaskItem> =>
  (
    await api.post(`/tasks/${encodeURIComponent(taskId)}/status`, {
      status_id: statusId,
      fields: fields ?? {},
    })
  ).data;

/** People a tracker's task can be assigned to, by name. */
export const searchUsers = async (
  taskId: string,
  query: string,
): Promise<Choice[]> =>
  (
    await api.get(`/tasks/${encodeURIComponent(taskId)}/users`, {
      params: { query },
    })
  ).data;

/** Fixed backend error messages that have a translation. The
 *  messages of the trackers themselves are shown as they come. */
const DETAIL_KEYS: Record<string, MessageKey> = {
  'Task not found': 'tasks.err.0',
  'Title is required': 'tasks.err.1',
  'Unknown status': 'tasks.err.2',
  'Connection not found': 'tasks.err.3',
  'Name is required': 'tasks.err.4',
  'Token is required': 'tasks.err.5',
  'Comment is empty': 'tasks.err.6',
  'Enter the token again when changing these settings': 'tasks.err.7',
  'The tracker answered in an unexpected way.': 'tasks.err.8',
  'Login has no email address': 'tasks.err.9',
  'Email address is not verified': 'tasks.err.10',
  'Not authenticated': 'tasks.err.11',
  'This issue cannot move to that status': 'tasks.err.12',
  'At most 20 tags of up to 40 characters': 'tasks.err.13',
};

/** The reason a request failed, from the API or the network,
 *  in the page's language where a translation exists. */
export function errorMessage(err: unknown): string {
  // Outside React: the page's language is on <html lang>.
  const lang = document.documentElement.lang;
  const language = isLanguage(lang) ? lang : 'en';
  const detail = (err as { response?: { data?: { detail?: unknown } } })
    ?.response?.data?.detail;
  if (typeof detail === 'string') {
    const key = DETAIL_KEYS[detail];
    return key ? translate(language, key) : detail;
  }
  if (err instanceof Error && err.message) return err.message;
  return translate(language, 'tasks.requestFailed');
}

/** Trackers a connection can be made to. */
export type ProviderName = 'jira' | 'shortcut' | 'huly';

/** A connection to a tracker account. The token never comes back. */
export interface Connection {
  id: number;
  provider: ProviderName;
  name: string;
  /** Settings that are not secret, plus `account`: who the
   *  token belongs to. */
  config: Record<string, string>;
  filters: Record<string, unknown>;
  /** Board column per status name, as the user set it. */
  mapping: Record<string, Column>;
  last_sync_at?: string | null;
  /** Why the last read failed; null when it worked. */
  last_error?: string | null;
  task_count: number;
}

export interface ConnectionChange {
  name?: string;
  config?: Record<string, string>;
  /** Blank keeps the saved token. */
  secret?: string;
  filters?: Record<string, unknown>;
  mapping?: Record<string, Column>;
}

export const getConnections = async (): Promise<Connection[]> =>
  (await api.get('/tasks/connections')).data;

/** Adds a connection; the server checks the token first. */
export const createConnection = async (fields: {
  provider: ProviderName;
  name: string;
  config: Record<string, string>;
  secret: string;
}): Promise<Connection> => (await api.post('/tasks/connections', fields)).data;

export const updateConnection = async (
  id: number,
  change: ConnectionChange,
): Promise<Connection> =>
  (await api.patch(`/tasks/connections/${id}`, change)).data;

export const deleteConnection = async (id: number): Promise<void> => {
  await api.delete(`/tasks/connections/${id}`);
};

/** Reads the trackers again (one connection, or all) and
 *  returns the whole board. */
export const refreshTasks = async (
  connectionId?: number,
): Promise<TaskItem[]> =>
  (await api.post('/tasks/refresh', { connection_id: connectionId ?? null }))
    .data;

/** Where one status of a connection goes on the board. */
export interface StatusColumn {
  name: string;
  category: 'todo' | 'in_progress' | 'done';
  /** The column it gets unless the user chooses one. */
  auto_column: Column;
  column: Column;
}

/** The statuses known for a connection and their columns. */
export const getStatusColumns = async (
  connectionId: number,
): Promise<StatusColumn[]> =>
  (await api.get(`/tasks/connections/${connectionId}/statuses`)).data;

/** A comment on a tracker's task. */
export interface TaskComment {
  id: string;
  author: string;
  body: string;
  created?: string | null;
}

/** A tracker's task's comments, oldest first. */
export const getComments = async (taskId: string): Promise<TaskComment[]> =>
  (await api.get(`/tasks/${encodeURIComponent(taskId)}/comments`)).data;

export const addComment = async (
  taskId: string,
  body: string,
): Promise<TaskComment> =>
  (await api.post(`/tasks/${encodeURIComponent(taskId)}/comments`, { body }))
    .data;

/** Assigns a tracker's task; null leaves it unassigned. */
export const setAssignee = async (
  taskId: string,
  userId: string | null,
): Promise<TaskItem> =>
  (
    await api.put(`/tasks/${encodeURIComponent(taskId)}/assignee`, {
      user_id: userId,
    })
  ).data;

/** What a new task in a tracker can be put in. */
export interface CreateOptions {
  projects: Choice[];
  priorities: Choice[];
  /** Where to create it in the tracker itself. */
  create_url?: string | null;
}

/** A task to create in a tracker. */
export interface NewExternalTask {
  project: string;
  type?: string | null;
  priority?: string | null;
  title: string;
  description: string;
}

export const getCreateOptions = async (
  connectionId: number,
): Promise<CreateOptions> =>
  (await api.get(`/tasks/connections/${connectionId}/create-options`)).data;

/** The kinds of task a project allows, e.g. Jira issue types. */
export const getTaskTypes = async (
  connectionId: number,
  project: string,
): Promise<Choice[]> =>
  (
    await api.get(`/tasks/connections/${connectionId}/types`, {
      params: { project },
    })
  ).data;

/** Creates a task in a tracker, assigned to the connection's
 *  account. */
export const createExternalTask = async (
  connectionId: number,
  task: NewExternalTask,
): Promise<TaskItem> =>
  (await api.post(`/tasks/connections/${connectionId}/tasks`, task)).data;
