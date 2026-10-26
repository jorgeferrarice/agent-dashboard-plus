import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { Agent } from '../../api';

// The workspace is tested around its two heavy children: the
// dashboard (data source) and the terminal (xterm + stream).
type DashboardProps = {
  onAttach: (id: string) => void;
  onAgentsChange?: (agents: Agent[]) => void;
  onOpenTasks?: () => void;
  onOpenGit?: () => void;
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
vi.mock('../tasks/TasksView', () => ({
  default: () => <div>tasks-board</div>,
}));
vi.mock('../git/GitView', () => ({
  default: () => <div>git-lists</div>,
}));
const renamed: [string, string][] = [];
// What the server holds as the user's open tabs.
const server: { tabs: string[] | null } = { tabs: null };
vi.mock('../../api', () => ({
  getOpenTabs: async () => server.tabs,
  saveOpenTabs: async (ids: string[]) => {
    server.tabs = ids;
  },
  renameSession: async (id: string, name: string) => {
    renamed.push([id, name]);
  },
}));
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

const played: string[] = [];
vi.mock('../tabs/sound', async (importActual) => ({
  ...(await importActual<typeof import('../tabs/sound')>()),
  playSound: (kind: string) => played.push(kind),
  unlockAudio: () => {},
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
  played.length = 0;
  opened.length = 0;
  server.tabs = null;
  document.title = '';
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('Workspace', () => {
  it('opens the Tasks tab from the dashboard and keeps it across agent updates and reloads', async () => {
    const first = render(<Workspace />);
    report([agent('a')]);
    act(() => dashboard.onOpenTasks?.());
    expect(tab(/Tasks/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('tasks-board')).toBeInTheDocument();
    expect(screen.queryByText(/terminal:/)).not.toBeInTheDocument();

    // An agent list without a "tasks" agent does not drop it.
    report([agent('b')]);
    expect(tab(/Tasks/)).toBeInTheDocument();

    // Opening it again focuses the same tab.
    attach('b');
    act(() => dashboard.onOpenTasks?.());
    expect(screen.getAllByRole('tab', { name: /Tasks/ })).toHaveLength(1);

    // It is restored, by its ID, after a reload.
    await act(async () => {});
    expect(server.tabs).toContain('tasks');
    first.unmount();
    render(<Workspace />);
    report([agent('b')]);
    expect(tab(/Tasks/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close tab Tasks' }));
    expect(screen.queryByRole('tab', { name: /Tasks/ })).toBeNull();
  });

  it('opens the Git tab from the dashboard and keeps it like the Tasks tab', async () => {
    render(<Workspace />);
    report([agent('a')]);
    act(() => dashboard.onOpenGit?.());
    expect(tab(/Git/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('git-lists')).toBeInTheDocument();
    // An agent list without a "git" agent does not drop it.
    report([agent('b')]);
    expect(tab(/Git/)).toBeInTheDocument();
    await act(async () => {});
    expect(server.tabs).toContain('git');
    fireEvent.click(screen.getByRole('button', { name: 'Close tab Git' }));
    expect(screen.queryByRole('tab', { name: /Git/ })).toBeNull();
  });

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

  it('splits the view in two panes and sends tab clicks to the focused one', () => {
    const first = render(<Workspace />);
    const shown = () =>
      screen
        .getAllByText(/terminal:/)
        .map((el) => /terminal:./.exec(el.textContent ?? '')?.[0]);
    const sideBySide = () =>
      screen.queryByRole('button', { name: 'Split side by side' });
    report([agent('a'), agent('b'), agent('c')]);
    attach('a');
    // One tab is not enough to split.
    expect(sideBySide()).toBeDisabled();
    attach('b');
    attach('c');

    // The second pane starts on the next tab, wrapping around.
    fireEvent.click(sideBySide()!);
    expect(shown()).toEqual(['terminal:c', 'terminal:a']);

    // A tab click replaces the focused pane; clicking inside
    // the other pane moves the focus there.
    fireEvent.mouseDown(screen.getByText(/terminal:a/));
    expect(tab(/bash · a/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab(/bash · b/));
    expect(shown()).toEqual(['terminal:c', 'terminal:b']);
    // A session already in a pane is focused, not duplicated.
    fireEvent.click(tab(/bash · c/));
    expect(shown()).toEqual(['terminal:c', 'terminal:b']);

    // The other direction keeps both panes, and the split
    // survives the dashboard tab and a reload.
    fireEvent.click(
      screen.getByRole('button', { name: 'Split top and bottom' }),
    );
    fireEvent.click(tab(/Dashboard/));
    expect(screen.queryByText(/terminal:/)).not.toBeInTheDocument();
    fireEvent.click(tab(/bash · c/));
    first.unmount();
    render(<Workspace />);
    report([agent('a'), agent('b'), agent('c')]);
    expect(shown()).toEqual(['terminal:c', 'terminal:b']);

    // Closing a pane's tab leaves the other session alone.
    fireEvent.click(screen.getByRole('button', { name: 'Close tab bash · c' }));
    expect(shown()).toEqual(['terminal:b']);
    expect(tab(/bash · b/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Close split' })).toBeNull();
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

  it('counts sessions without a tab in the title, not on the Dashboard tab', () => {
    render(<Workspace />);
    report([agent('a', 'waiting_permission')]);
    expect(screen.queryByLabelText(/need attention/)).toBeNull();
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

  it('renames a session from the settings menu and the tab menu', async () => {
    renamed.length = 0;
    render(<Workspace />);
    report([agent('a'), agent('b')]);
    attach('b');
    attach('a');

    // Settings menu renames the active tab.
    // Closed popovers are hidden from the accessibility tree.
    const fromSettings = screen.getByRole('button', {
      name: 'Rename session',
      hidden: true,
    });
    const fromMenu = screen.getByRole('menuitem', {
      name: 'Rename session',
      hidden: true,
    });
    fireEvent.click(fromSettings);
    const input = screen.getByRole('textbox', { name: 'Session name' });
    // Focused inside the click itself, not a frame later: a
    // phone only shows its keyboard for a focus made in the tap.
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '  api work ' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(renamed).toEqual([['a', 'api work']]);
    report([
      { ...agent('a'), telemetry: { session_name: 'api work' } },
      agent('b'),
    ]);
    expect(tab('api work')).toBeInTheDocument();

    // Right-click renames the tab clicked on, not the active one.
    fireEvent.contextMenu(tab(/bash · b/));
    fireEvent.click(fromMenu);
    const other = screen.getByRole('textbox', { name: 'Session name' });
    expect(other).toHaveValue('bash · b');
    // Escape cancels without saving.
    fireEvent.keyDown(other, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(renamed).toHaveLength(1);
  });

  it('reorders tabs by drag and drop, keeping the order', () => {
    render(<Workspace />);
    report([agent('a'), agent('b'), agent('c')]);
    attach('a');
    attach('b');
    attach('c');
    const order = () =>
      screen
        .getAllByRole('tab')
        .map((t) => t.textContent)
        .join('|');
    expect(order()).toBe('Dashboard|bash · a|bash · b|bash · c');

    // The fixed Dashboard tab cannot be dragged.
    expect(tab(/Dashboard/)).not.toHaveAttribute('draggable', 'true');

    const drag = (from: RegExp, to: RegExp, clientX: number) => {
      const source = tab(from).parentElement!;
      const target = tab(to).parentElement!;
      const dataTransfer = { setData: vi.fn() };
      fireEvent.dragStart(source, { dataTransfer });
      // jsdom boxes are all zero: any x > 0 is the right half.
      // jsdom has no DragEvent, so the pointer position has to
      // be put on the event by hand.
      const over = createEvent.dragOver(target, { dataTransfer });
      Object.defineProperty(over, 'clientX', { value: clientX });
      fireEvent(target, over);
      fireEvent.drop(target, { dataTransfer });
      fireEvent.dragEnd(source, { dataTransfer });
    };
    drag(/bash · c/, /bash · a/, 0);
    expect(order()).toBe('Dashboard|bash · c|bash · a|bash · b');
    drag(/bash · c/, /bash · b/, 5);
    expect(order()).toBe('Dashboard|bash · a|bash · b|bash · c');
    drag(/bash · a/, /bash · b/, 5);
    expect(order()).toBe('Dashboard|bash · b|bash · a|bash · c');

    // The order is what a reload reads back.
    const saved = JSON.parse(localStorage.getItem('agentDashboard.tabs')!);
    expect(saved.tabs.map((t: { id: string }) => t.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('follows the open tabs the server holds for the user', async () => {
    // Another device left b and a open, in that order; this
    // browser only remembers a tab for c.
    server.tabs = ['b', 'a'];
    localStorage.setItem(
      'agentDashboard.tabs',
      JSON.stringify({ tabs: [{ id: 'c', label: 'old' }], active: 'c' }),
    );
    render(<Workspace />);
    await act(async () => {});
    report([agent('a'), agent('b'), agent('c')]);
    const order = () =>
      screen
        .getAllByRole('tab')
        .map((t) => t.textContent)
        .join('|');
    expect(order()).toBe('Dashboard|bash · b|bash · a');

    // Opening a tab here is saved for the other devices.
    attach('c');
    await act(async () => {});
    expect(server.tabs).toEqual(['b', 'a', 'c']);
  });

  it("gives the server this browser's tabs when it has none", async () => {
    localStorage.setItem(
      'agentDashboard.tabs',
      JSON.stringify({ tabs: [{ id: 'a', label: 'x' }], active: 'a' }),
    );
    render(<Workspace />);
    await act(async () => {});
    expect(server.tabs).toEqual(['a']);
  });

  describe('notification sound', () => {
    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    it('plays once after a session waits a minute for the user', () => {
      vi.useFakeTimers();
      try {
        render(<Workspace />);
        report([agent('a', 'waiting_permission')]);
        wait(55_000);
        expect(played).toEqual([]);
        wait(15_000);
        expect(played).toEqual(['chime']);
        wait(120_000);
        expect(played).toEqual(['chime']);
        // Answered, then waiting again: a new minute.
        report([agent('a', 'working')]);
        wait(5_000);
        report([agent('a', 'waiting_permission')]);
        wait(70_000);
        expect(played).toEqual(['chime', 'chime']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('plays the chosen sound, and none when turned off', () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem('agentDashboard.sound', 'ping');
        const { unmount } = render(<Workspace />);
        report([agent('a', 'waiting_permission')]);
        wait(70_000);
        expect(played).toEqual(['ping']);
        unmount();

        localStorage.setItem('agentDashboard.sound', 'off');
        render(<Workspace />);
        report([agent('b', 'waiting_permission')]);
        wait(70_000);
        expect(played).toEqual(['ping']);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
