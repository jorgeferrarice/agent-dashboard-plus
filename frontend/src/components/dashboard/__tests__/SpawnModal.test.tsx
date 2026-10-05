import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'General Usage' },
    });
    fireEvent.click(initialize());
    expect(onSpawn.mock.calls[1][4]).toBe('General Usage');
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
