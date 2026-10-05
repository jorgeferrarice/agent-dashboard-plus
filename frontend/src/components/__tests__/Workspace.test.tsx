import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Agent } from '../../api';

// The workspace is tested around its two heavy children: the
// dashboard (data source) and the terminal (xterm + stream).
type DashboardProps = {
  onAttach: (id: string) => void;
  onAgentsChange?: (agents: Agent[]) => void;
};
let dashboard: DashboardProps;
const terminalMounts: string[] = [];
const terminalUnmounts: string[] = [];
const opened: string[] = [];
const handlers: Record<string, (data: unknown) => void> = {};

vi.mock('../Dashboard', () => ({
  default: (props: DashboardProps) => {
    dashboard = props;
    return <div>dashboard-content</div>;
  },
}));
vi.mock('../Terminal', async () => {
  const { useEffect } = await import('react');
  return {
    default: function TerminalStub(props: {
      agentId: string;
      ended?: boolean;
      onDetach?: () => void;
      onReplace?: (id: string) => void;
    }) {
      useEffect(() => {
        terminalMounts.push(props.agentId);
        return () => {
          terminalUnmounts.push(props.agentId);
        };
      }, [props.agentId]);
      return (
        <div>
          terminal:{props.agentId}
          {props.ended ? ':ended' : ''}
          <button onClick={props.onDetach}>detach</button>
          <button onClick={() => props.onReplace?.('resumed')}>resume</button>
        </div>
      );
    },
  };
});
vi.mock('../terminalWindow', () => ({
  openTerminalWindow: (id: string) => opened.push(id),
}));
vi.mock('../../socket', () => ({
  getSocket: () => ({
    on: (event: string, fn: (data: unknown) => void) => {
      handlers[event] = fn;
    },
    off: () => {},
  }),
}));

import Workspace from '../Workspace';

const agent = (id: string, status = 'idle', project = id): Agent => ({
  id: 1,
  agent_id: id,
  host_id: 1,
  status: 'active',
  tool_name: 'bash',
  started_at: '',
  telemetry: { agent_status: status, git_project: project },
});

const report = (agents: Agent[]) =>
  act(() => dashboard.onAgentsChange?.(agents));
const attach = (id: string) => act(() => dashboard.onAttach(id));
const tab = (name: RegExp | string) => screen.getByRole('tab', { name });

beforeEach(() => {
  // Node's own localStorage global shadows jsdom's and is
  // unusable without a backing file: use an in-memory one.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  terminalMounts.length = 0;
  terminalUnmounts.length = 0;
  opened.length = 0;
  document.title = '';
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('Workspace', () => {
  it('opens a session in a tab and mounts only the active terminal', () => {
    render(<Workspace />);
    report([agent('a'), agent('b')]);
    expect(screen.queryByText(/terminal:/)).not.toBeInTheDocument();

    attach('a');
    expect(tab(/bash · a/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/terminal:a/)).toBeInTheDocument();

    attach('b');
    expect(screen.getByText(/terminal:b/)).toBeInTheDocument();
    expect(screen.queryByText(/terminal:a/)).not.toBeInTheDocument();
    expect(terminalUnmounts).toEqual(['a']);

    // Attaching an already open session focuses its tab.
    attach('a');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(tab(/bash · a/)).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the dashboard mounted behind a session tab', () => {
    render(<Workspace />);
    report([agent('a')]);
    attach('a');
    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
    fireEvent.click(tab(/Dashboard/));
    expect(screen.queryByText(/terminal:/)).not.toBeInTheDocument();
  });

  it('closing a tab falls back to its neighbour and keeps the session', () => {
    render(<Workspace />);
    report([agent('a'), agent('b')]);
    attach('a');
    attach('b');
    fireEvent.click(screen.getByRole('button', { name: 'Close tab bash · b' }));
    expect(tab(/bash · a/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /bash · b/ })).toBeNull();
  });

  it('restores open tabs after a reload and drops ended sessions', () => {
    const first = render(<Workspace />);
    report([agent('a'), agent('b')]);
    attach('a');
    attach('b');
    first.unmount();

    render(<Workspace />);
    expect(tab(/bash · b/)).toHaveAttribute('aria-selected', 'true');
    report([agent('b')]);
    expect(screen.queryByRole('tab', { name: /bash · a/ })).toBeNull();
    expect(tab(/bash · b/)).toBeInTheDocument();
  });

  it('marks a background tab that finished working, until it is opened', () => {
    render(<Workspace />);
    report([agent('a', 'working'), agent('b')]);
    attach('a');
    attach('b');
    report([agent('a', 'idle'), agent('b')]);
    expect(
      screen.getByRole('status', { name: 'Finished working' }),
    ).toBeVisible();
    expect(document.title).toBe('(1) Agent Dashboard');

    fireEvent.click(tab(/bash · a/));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.title).toBe('Agent Dashboard');
  });

  it('does not mark the tab being watched', () => {
    render(<Workspace />);
    report([agent('a', 'working')]);
    attach('a');
    report([agent('a', 'idle')]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows permission on the tab until the agent leaves that state', () => {
    render(<Workspace />);
    report([agent('a'), agent('b')]);
    attach('a');
    attach('b');
    report([agent('a', 'waiting_permission'), agent('b')]);
    fireEvent.click(tab(/bash · a/));
    expect(
      screen.getByRole('status', { name: 'Waiting for permission' }),
    ).toBeVisible();
    report([agent('a', 'working'), agent('b')]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('counts sessions without a tab on the Dashboard tab', () => {
    render(<Workspace />);
    report([agent('a', 'waiting_permission')]);
    expect(screen.getByLabelText('1 sessions need attention')).toBeVisible();
    expect(document.title).toBe('(1) Agent Dashboard');
  });

  it('keeps an ended session as a marked tab and closes a stopped one', () => {
    render(<Workspace />);
    report([agent('a'), agent('b'), agent('c')]);
    attach('a');
    attach('b');
    attach('c');

    act(() =>
      handlers.agent_status_update({ agent_id: 'a', status: 'closed' }),
    );
    report([agent('b'), agent('c')]);
    expect(screen.getByRole('status', { name: 'Session ended' })).toBeVisible();
    fireEvent.click(tab(/bash · a/));
    expect(screen.getByText(/terminal:a:ended/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();

    act(() =>
      handlers.agent_status_update({ agent_id: 'b', status: 'stopped' }),
    );
    expect(screen.queryByRole('tab', { name: /bash · b/ })).toBeNull();
  });

  it('swaps the tab to the resumed session', () => {
    render(<Workspace />);
    report([agent('a')]);
    attach('a');
    act(() =>
      handlers.agent_status_update({ agent_id: 'a', status: 'closed' }),
    );
    fireEvent.click(screen.getByText('resume'));
    expect(screen.getByText(/terminal:resumed/)).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('detaching moves the session to a window and closes the tab', () => {
    render(<Workspace />);
    report([agent('a')]);
    attach('a');
    fireEvent.click(screen.getByText('detach'));
    expect(opened).toEqual(['a']);
    expect(screen.queryByRole('tab', { name: /bash · a/ })).toBeNull();
    expect(tab(/Dashboard/)).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs with Alt+digit and leaves Alt+arrows alone', () => {
    render(<Workspace />);
    report([agent('a'), agent('b')]);
    attach('a');
    attach('b');
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    };

    expect(press({ code: 'Digit2', altKey: true }).defaultPrevented).toBe(true);
    expect(tab(/bash · a/)).toHaveAttribute('aria-selected', 'true');
    press({ code: 'Digit1', altKey: true });
    expect(tab(/Dashboard/)).toHaveAttribute('aria-selected', 'true');

    expect(press({ code: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(press({ code: 'Digit3' }).defaultPrevented).toBe(false);
    expect(tab(/Dashboard/)).toHaveAttribute('aria-selected', 'true');
  });

  it('notifies only while the page is out of focus, once per transition', async () => {
    const shown: { title: string; body?: string; tag?: string }[] = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body, tag: options?.tag });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    const focus = vi.spyOn(document, 'hasFocus');

    render(<Workspace />);
    report([agent('a', 'working')]);
    attach('a');

    focus.mockReturnValue(true);
    report([agent('a', 'waiting_permission')]);
    await Promise.resolve();
    expect(shown).toEqual([]);

    focus.mockReturnValue(false);
    report([agent('a', 'working')]);
    report([agent('a', 'idle')]);
    report([agent('a', 'idle')]);
    await Promise.resolve();
    expect(shown).toEqual([
      { title: 'bash · a', body: 'Finished working', tag: 'a' },
    ]);
  });
});
