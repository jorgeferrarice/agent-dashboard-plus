import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import SpawnModal from '../SpawnModal';
import type { SpawnModalProps } from '../SpawnModal';
import type { Host } from '../../../api';

const host = (projects?: Host['projects']): Host => ({
  id: 1,
  name: 'mac',
  status: 'online',
  created_at: '',
  projects,
});

const renderModal = (props: Partial<SpawnModalProps> = {}) => {
  const onSpawn = vi.fn();
  const onCreateProject = vi.fn();
  render(
    <SpawnModal
      host={host({
        projects_root: '/home/u',
        available_projects: ['/home/u/repo', '/home/u/notes'],
        non_git_projects: ['/home/u/notes'],
        new_projects_dir: '/home/u/git',
      })}
      tool="bash"
      onClose={() => {}}
      onSpawn={onSpawn}
      onCreateProject={onCreateProject}
      onRefresh={() => {}}
      {...props}
    />,
  );
  return { onSpawn, onCreateProject };
};

const worktreeToggle = () =>
  screen.getByRole('button', { name: 'Worktree isolation' });
const initialize = () =>
  screen.getByRole('button', { name: 'Initialize Agent' });

beforeEach(() => {
  // Node's own localStorage global shadows jsdom's and is
  // unusable without a backing file: use an in-memory one.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

describe('SpawnModal', () => {
  it('shows loading until the host reports projects', () => {
    renderModal({ host: host(undefined) });
    expect(screen.getByText(/Loading projects from/)).toBeInTheDocument();
    expect(initialize()).toBeDisabled();
  });

  it('says so when the scan found no projects', () => {
    renderModal({
      host: host({ projects_root: '/home/u', available_projects: [] }),
    });
    expect(
      screen.getByText('No projects found in /home/u'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading projects/)).not.toBeInTheDocument();
  });

  it('disables worktree isolation for a folder that is not a git repo', () => {
    renderModal();
    expect(worktreeToggle()).toBeEnabled();
    fireEvent.click(screen.getByText('notes'));
    expect(worktreeToggle()).toBeDisabled();
  });

  it('never requests a worktree for a non-git folder', () => {
    const { onSpawn } = renderModal();
    fireEvent.click(worktreeToggle());
    fireEvent.click(screen.getByText('notes'));
    fireEvent.click(initialize());
    expect(onSpawn).toHaveBeenCalledWith(
      '/home/u/notes',
      '',
      'resume',
      false,
      undefined,
      undefined,
    );
  });

  it('creates the new folder and starts the session in it', async () => {
    const { onSpawn, onCreateProject } = renderModal();
    onCreateProject.mockResolvedValue('/home/u/git/fresh');
    fireEvent.change(screen.getByLabelText(/Or Start in a New Folder/), {
      target: { value: 'fresh' },
    });
    fireEvent.click(screen.getByLabelText('Run git init in the new folder'));
    fireEvent.click(initialize());
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    expect(onCreateProject).toHaveBeenCalledWith('fresh', true);
    expect(onSpawn).toHaveBeenCalledWith(
      '/home/u/git/fresh',
      '',
      'new',
      false,
      undefined,
      undefined,
    );
  });

  it('shows the host error and does not spawn when creation fails', async () => {
    const { onSpawn, onCreateProject } = renderModal();
    onCreateProject.mockRejectedValue({
      response: { data: { detail: 'A folder with that name already exists.' } },
    });
    fireEvent.change(screen.getByLabelText(/Or Start in a New Folder/), {
      target: { value: 'repo' },
    });
    fireEvent.click(initialize());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A folder with that name already exists.',
    );
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('passes the trimmed session name, or none when left empty', () => {
    const { onSpawn } = renderModal();
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[0][5]).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Session Name (Optional)'), {
      target: { value: '  login fix ' },
    });
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[1][5]).toBe('login fix');
  });

  it('hides the model selector for tools without models', () => {
    renderModal();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('spawns with the default model, or the one the user picked', () => {
    const { onSpawn } = renderModal({
      models: ['auto', 'General Usage'],
      defaultModel: 'auto',
    });
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[0][4]).toBe('auto');
    fireEvent.click(screen.getByRole('option', { name: 'General Usage' }));
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[1][4]).toBe('General Usage');
  });

  it('offers the last five spawned models as quick picks', () => {
    const models = ['a', 'b', 'c', 'd', 'e', 'f', 'gone'];
    renderModal({ models, defaultModel: 'a' });
    expect(screen.queryByRole('group', { name: 'Recent models' })).toBeNull();
    for (const m of ['gone', 'a', 'b', 'c', 'd', 'e', 'f', 'e']) {
      fireEvent.click(screen.getByRole('option', { name: m }));
      fireEvent.click(initialize());
    }
    cleanup();

    // Newest first, deduplicated, capped at five, and without
    // models the host no longer offers.
    const { onSpawn } = renderModal({
      models: models.filter((m) => m !== 'gone'),
      defaultModel: 'a',
    });
    const recent = within(screen.getByRole('group', { name: 'Recent models' }));
    expect(recent.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'e',
      'f',
      'd',
      'c',
      'b',
    ]);
    fireEvent.click(recent.getByRole('button', { name: 'd' }));
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[0][4]).toBe('d');
  });

  it('replaces the model choices with the live list on open', async () => {
    const onLoadModels = vi.fn().mockResolvedValue({
      models: ['auto', 'General Usage', 'claude/claude-opus-5'],
      default_model: 'auto',
      error: null,
    });
    const { onSpawn } = renderModal({
      models: ['auto'],
      defaultModel: 'auto',
      onLoadModels,
    });
    expect(
      await screen.findByRole('option', { name: 'claude/claude-opus-5' }),
    ).toBeInTheDocument();
    expect(onLoadModels).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.click(
      screen.getByRole('option', { name: 'claude/claude-opus-5' }),
    );
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[0][4]).toBe('claude/claude-opus-5');
  });

  it('narrows the model list as the user types', () => {
    renderModal({
      models: ['auto', 'General Usage', 'claude/claude-opus-5'],
      defaultModel: 'auto',
    });
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'OPUS' },
    });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'claude/claude-opus-5',
    ]);
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'zzz' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it('keeps the reported choices when the live fetch fails', async () => {
    renderModal({
      models: ['auto'],
      defaultModel: 'auto',
      onLoadModels: vi.fn().mockRejectedValue(new Error('offline')),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh the model list.',
    );
    expect(initialize()).toBeEnabled();
  });

  it('warns when the live model list is unavailable', () => {
    renderModal({
      models: ['auto'],
      defaultModel: 'auto',
      modelsError: 'Model list is unreachable.',
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Model list is unreachable.',
    );
    expect(initialize()).toBeEnabled();
  });
});
