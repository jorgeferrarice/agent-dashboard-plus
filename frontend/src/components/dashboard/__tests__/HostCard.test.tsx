import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Host } from '../../../api';
import { restartHost } from '../../../api';
import HostCard from '../HostCard';

vi.mock('../../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api')>()),
  restartHost: vi.fn(async () => {}),
}));

const host = (over: Partial<Host> = {}): Host => ({
  id: 7,
  name: 'laptop',
  status: 'online',
  created_at: '2026-01-01T00:00:00Z',
  projects: {
    projects_root: '/p',
    available_projects: [],
    available_tools: [
      { name: 'claude', display_name: 'Claude' },
      { name: 'claude-work', display_name: 'Claude (work)' },
      { name: 'codex', display_name: 'Codex', authenticated: false },
    ],
  },
  ...over,
});

const show = (h: Host, onToolSetting = vi.fn(async () => {})) => {
  const onSpawnClick = vi.fn();
  render(
    <HostCard
      host={h}
      agents={[]}
      onAttach={vi.fn()}
      onStop={vi.fn()}
      onSpawnClick={onSpawnClick}
      onDeleteHost={vi.fn()}
      onToolSetting={onToolSetting}
    />,
  );
  return { onSpawnClick, onToolSetting };
};

describe('HostCard tools', () => {
  it('hides disabled tools and shows custom names', () => {
    const { onSpawnClick } = show(
      host({
        tool_settings: [
          { tool: 'claude', enabled: false, label: null },
          { tool: 'claude-work', enabled: true, label: 'Trabalho' },
        ],
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Claude' }),
    ).not.toBeInTheDocument();
    // The custom name replaces the default; the tool started
    // is still the one the daemon knows.
    fireEvent.click(screen.getByRole('button', { name: /Trabalho/ }));
    expect(onSpawnClick).toHaveBeenCalledWith(7, 'claude-work');
  });

  it('warns on a tool that is installed but not signed in', () => {
    show(host());
    const codex = screen.getByRole('button', { name: /Codex/ });
    expect(within(codex).getByLabelText('Not signed in')).toBeInTheDocument();
    const claude = screen.getByRole('button', { name: 'Claude' });
    expect(within(claude).queryByLabelText('Not signed in')).toBeNull();
  });

  it('edits tools from the Settings dialog next to Delete', async () => {
    const { onToolSetting } = show(
      host({
        tool_settings: [
          { tool: 'claude', enabled: false, label: null },
          // Saved for a tool the daemon no longer detects.
          { tool: 'grok', enabled: true, label: 'Old Grok' },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    const dialog = screen.getByRole('dialog', { name: 'Settings for laptop' });

    // A disabled tool is still listed, switched off.
    const claude = within(dialog).getByRole('switch', {
      name: 'Offer Claude on this host',
    });
    expect(claude).not.toBeChecked();
    fireEvent.click(claude);
    expect(onToolSetting).toHaveBeenCalledWith(7, 'claude', { enabled: true });

    // Renaming saves when focus leaves the field; blank is sent
    // as blank, which restores the default.
    const name = within(dialog).getByRole('textbox', {
      name: 'Button name for Codex',
    });
    fireEvent.change(name, { target: { value: ' GPT ' } });
    fireEvent.blur(name);
    expect(onToolSetting).toHaveBeenCalledWith(7, 'codex', { label: 'GPT' });

    // The undetected tool keeps its row and its name.
    expect(within(dialog).getByText('Not detected')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('textbox', { name: 'Button name for grok' }),
    ).toHaveValue('Old Grok');
    expect(within(dialog).getByText(/Not signed in/)).toBeInTheDocument();
  });

  it('says so when a setting cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    show(
      host(),
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    fireEvent.click(
      screen.getByRole('switch', { name: 'Offer Claude on this host' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save',
    );
  });
});

describe('HostCard limits', () => {
  const withLimits = (usage: NonNullable<Host['projects']>['usage']) =>
    host({
      projects: {
        projects_root: '/p',
        available_projects: [],
        available_tools: [
          { name: 'bash', display_name: 'Bash' },
          { name: 'claude', display_name: 'Claude', has_limits: true },
          { name: 'grok', display_name: 'Grok', has_limits: true },
        ],
        usage,
      },
    });
  const windows = [
    { label: 'Current session', used_percent: 3, resets: '12:40pm' },
    { label: 'Current week (all models)', used_percent: 91, resets: 'Oct 8' },
    { label: 'Current week (Fable)', used_percent: 2, resets: 'Oct 8' },
  ];

  it('shows a 5h and a weekly bar per account, with details', () => {
    show(
      withLimits({
        claude: { windows, updated_at: Date.now() / 1000, ok: true },
      }),
    );
    expect(
      screen.getByRole('meter', { name: 'Current session' }),
    ).toHaveAttribute('aria-valuenow', '3');
    // The weekly bar is the all-models one, not a per-model limit.
    expect(
      screen.getByRole('meter', { name: 'Current week (all models)' }),
    ).toHaveAttribute('aria-valuenow', '91');
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    // Every limit, its reset and the age are in the details.
    expect(
      screen.getByText('Current week (Fable): 2% used · resets Oct 8'),
    ).toBeInTheDocument();
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
  });

  it('says unavailable for a tool whose limits cannot be read', () => {
    show(withLimits({}));
    // Claude (not read yet) and Grok (no way to read) say so;
    // bash has no limits at all and gets no line.
    expect(screen.getAllByText(/limit unavailable/)).toHaveLength(2);
  });

  it('keeps the last reading, dimmed with its age, after a failure', () => {
    show(
      withLimits({
        claude: { windows, updated_at: Date.now() / 1000 - 23 * 60, ok: false },
      }),
    );
    expect(screen.getByText('23 min ago')).toBeInTheDocument();
    expect(
      screen.getByText(/Could not refresh. Last read 23 min ago/),
    ).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Current session' })).toBeTruthy();
  });
});

describe('HostCard restart', () => {
  it('restarts only after the warning is confirmed', async () => {
    show(host());
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('every session');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(restartHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Nuke & restart' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(restartHost).toHaveBeenCalledWith(7);
  });

  it('is disabled while the host is offline', () => {
    show(host({ status: 'offline' }));
    expect(screen.getByRole('button', { name: /Restart/ })).toBeDisabled();
  });
});
