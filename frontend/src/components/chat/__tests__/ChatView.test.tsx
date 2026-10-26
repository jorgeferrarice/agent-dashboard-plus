import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import type { ChatMessage } from '../chat';

const uploadFile = vi.fn();
vi.mock('../../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api')>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

import ChatView from '../ChatView';

/** A socket whose server side the test plays. */
function fakeSocket() {
  const handlers: Record<string, ((data?: unknown) => void)[]> = {};
  return {
    connected: true,
    on: vi.fn((event: string, fn: (data?: unknown) => void) => {
      (handlers[event] ??= []).push(fn);
    }),
    off: vi.fn((event: string, fn: (data?: unknown) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn);
    }),
    emit: vi.fn(),
    serve(event: string, data: unknown) {
      act(() => (handlers[event] ?? []).forEach((h) => h(data)));
    },
  };
}

const text = (id: string, role: ChatMessage['role'], value: string) =>
  ({ id, ts: null, role, blocks: [{ type: 'text', text: value }] }) as const;

const bashCall: ChatMessage = {
  id: 'a2',
  ts: null,
  role: 'assistant',
  blocks: [
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } },
  ],
};
const bashResult: ChatMessage = {
  id: 'u2',
  ts: null,
  role: 'user',
  blocks: [
    {
      type: 'tool_result',
      tool_use_id: 'tu1',
      text: 'README.md',
      is_error: false,
      truncated: true,
      images: [],
    },
  ],
};

let socket: ReturnType<typeof fakeSocket>;
const send = vi.fn();
const onShowTerminal = vi.fn();

const renderChat = (status?: string, readScreen?: () => string[]) =>
  render(
    <ChatView
      agentId="a1"
      socket={socket as unknown as Socket}
      status={status}
      send={send}
      readScreen={readScreen}
      onShowTerminal={onShowTerminal}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  // Node's own localStorage global shadows jsdom's and is
  // unusable without a backing file: use an in-memory one.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  socket = fakeSocket();
});

afterEach(() => vi.useRealTimers());

describe('ChatView', () => {
  it('joins the chat, shows, merges and replaces messages, then leaves', () => {
    const { unmount } = renderChat();
    expect(socket.emit).toHaveBeenCalledWith('chat_join', { agent_id: 'a1' });
    expect(screen.getByText('Waiting for the first message…')).toBeTruthy();

    socket.serve('chat_messages', {
      agent_id: 'a1',
      replace: true,
      messages: [text('u1', 'user', 'Oi'), text('a1', 'assistant', 'Olá')],
    });
    expect(screen.getByText('Oi')).toBeTruthy();
    expect(screen.getByText('Olá')).toBeTruthy();

    // Same ID replaces; new ID appends; other sessions ignored.
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [
        text('a1', 'assistant', 'Olá!'),
        text('a3', 'assistant', 'Fim'),
      ],
    });
    socket.serve('chat_messages', {
      agent_id: 'other',
      messages: [text('x', 'assistant', 'Alheio')],
    });
    expect(screen.queryByText('Olá')).toBeNull();
    expect(screen.getByText('Olá!')).toBeTruthy();
    expect(screen.getByText('Fim')).toBeTruthy();
    expect(screen.queryByText('Alheio')).toBeNull();

    socket.serve('chat_messages', {
      agent_id: 'a1',
      replace: true,
      messages: [text('n1', 'user', 'Nova conversa')],
    });
    expect(screen.queryByText('Oi')).toBeNull();
    expect(screen.getByText('Nova conversa')).toBeTruthy();

    unmount();
    expect(socket.emit).toHaveBeenCalledWith('chat_leave', { agent_id: 'a1' });
    expect(socket.off).toHaveBeenCalledWith(
      'chat_messages',
      expect.any(Function),
    );
  });

  it('shows a tool result on its call card, not as a message', () => {
    const { container } = renderChat();
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [bashCall, bashResult],
    });
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText(/Cut short/)).toBeTruthy();
    expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(0);
  });

  it('answers a menu on the screen with arrows and Enter', () => {
    vi.useFakeTimers();
    let screenRows = [
      ' Bash command',
      ' rm -f probe_file.txt',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend',
    ];
    renderChat('waiting_permission', () => screenRows);
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('Do you want to proceed?');
    fireEvent.click(screen.getByText('No'));
    vi.advanceTimersByTime(200);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['\x1b[B', '\r']);
    // The menu is gone from the screen: so is the card.
    screenRows = ['❯ '];
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText('Do you want to proceed?')).toBeNull();
  });

  it('cancels a menu with Esc and points to the terminal', () => {
    const rows = [
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to cancel',
    ];
    renderChat(undefined, () => rows);
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('Yes, I trust this folder');
    fireEvent.click(within(card).getByText('Cancel (Esc)'));
    expect(send).toHaveBeenLastCalledWith('\x1b');
    fireEvent.click(within(card).getByText('See in the terminal'));
    expect(onShowTerminal).toHaveBeenCalled();
  });

  it('waiting without a menu on screen points to the terminal', () => {
    renderChat('waiting_permission', () => []);
    socket.serve('chat_messages', { agent_id: 'a1', messages: [bashCall] });
    expect(screen.getByRole('alert').textContent).toContain('Bash: ls -la');
    expect(screen.queryByText('Cancel (Esc)')).toBeNull();
  });

  it('folds tool calls in a row into one counted group', () => {
    const second: ChatMessage = {
      ...bashCall,
      id: 'a3',
      blocks: [
        {
          type: 'tool_use',
          id: 'tu2',
          name: 'Read',
          input: { file_path: 'x' },
        },
      ],
    };
    renderChat('working');
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [bashCall, bashResult, second],
    });
    expect(screen.getByText('1 command running, 1 done')).toBeTruthy();
    expect(screen.getByText('Read: x')).toBeTruthy();
  });

  it('keeps the draft when the chat closes and opens again', () => {
    const { unmount } = renderChat();
    fireEvent.change(screen.getByLabelText('Message to Claude'), {
      target: { value: 'texto longo' },
    });
    unmount();
    renderChat();
    expect(
      (screen.getByLabelText('Message to Claude') as HTMLTextAreaElement).value,
    ).toBe('texto longo');
  });

  it('hides the permission warning once the user sends a message', () => {
    const view = renderChat('waiting_permission');
    expect(screen.getByRole('alert')).toBeTruthy();
    const field = screen.getByLabelText('Message to Claude');
    fireEvent.change(field, { target: { value: 'sim' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.queryByRole('alert')).toBeNull();
    // A new prompt later shows it again.
    view.rerender(
      <ChatView
        agentId="a1"
        socket={socket as unknown as Socket}
        status="idle"
        send={send}
        onShowTerminal={onShowTerminal}
      />,
    );
    view.rerender(
      <ChatView
        agentId="a1"
        socket={socket as unknown as Socket}
        status="waiting_permission"
        send={send}
        onShowTerminal={onShowTerminal}
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('queues messages while Claude works and sends them one at a time', () => {
    vi.useFakeTimers();
    const chat = (status: string) => (
      <ChatView
        agentId="a1"
        socket={socket as unknown as Socket}
        status={status}
        send={send}
        onShowTerminal={onShowTerminal}
      />
    );
    const view = render(chat('working'));
    const field = screen.getByLabelText('Message to Claude');
    for (const value of ['primeira', 'segunda']) {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    expect(send).not.toHaveBeenCalled();
    const queue = screen.getByLabelText('Queued: sent when Claude finishes');
    expect(within(queue).getByText('primeira')).toBeTruthy();
    expect(within(queue).getByText('segunda')).toBeTruthy();

    // Claude stops: the first goes, the second waits for Claude
    // to work on it and stop again.
    view.rerender(chat('idle'));
    act(() => vi.advanceTimersByTime(100));
    expect(send.mock.calls).toEqual([['primeira'], ['\r']]);
    view.rerender(chat('working'));
    view.rerender(chat('idle'));
    act(() => vi.advanceTimersByTime(100));
    expect(send).toHaveBeenLastCalledWith('\r');
    expect(send).toHaveBeenCalledWith('segunda');
    expect(
      screen.queryByLabelText('Queued: sent when Claude finishes'),
    ).toBeNull();
  });

  it('a queued message can be removed or sent now', () => {
    renderChat('working');
    const field = screen.getByLabelText('Message to Claude');
    for (const value of ['tirar', 'já']) {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    fireEvent.click(screen.getAllByLabelText('Remove from queue')[0]);
    expect(screen.queryByText('tirar')).toBeNull();
    fireEvent.click(screen.getByLabelText('Send now'));
    expect(send).toHaveBeenCalledWith('já');
    expect(screen.queryByText('já')).toBeNull();
  });

  it('shows working only after the user sends something', () => {
    renderChat('working');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByLabelText('Stop')).toBeNull();
  });

  it('follows the end when content grows, not after scrolling up', () => {
    const { container } = renderChat();
    const list = container.querySelector('.overflow-y-auto') as HTMLElement;
    let height = 1000;
    Object.defineProperty(list, 'scrollHeight', { get: () => height });
    Object.defineProperty(list, 'clientHeight', { value: 400 });
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [text('m1', 'user', 'oi')],
    });
    expect(list.scrollTop).toBe(1000);
    // An image loads: the end moves away without the user scrolling.
    height = 1500;
    fireEvent.scroll(list);
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [text('m2', 'assistant', 'olá')],
    });
    expect(list.scrollTop).toBe(1500);
    // The user scrolls up to read: stay there.
    list.scrollTop = 200;
    fireEvent.scroll(list);
    height = 2000;
    socket.serve('chat_messages', {
      agent_id: 'a1',
      messages: [text('m3', 'assistant', 'mais')],
    });
    expect(list.scrollTop).toBe(200);
  });

  it('shows no permission card while the agent works; Stop presses Esc', () => {
    renderChat('working');
    fireEvent.change(screen.getByLabelText('Message to Claude'), {
      target: { value: 'faça' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message to Claude'), {
      key: 'Enter',
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/working/);
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(send).toHaveBeenCalledWith('\x1b');
  });

  it('types a multi-line message as one paste, then Enter', () => {
    vi.useFakeTimers();
    renderChat();
    const field = screen.getByLabelText('Message to Claude');
    fireEvent.change(field, { target: { value: 'linha 1\nlinha 2' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('\x1b[200~linha 1\nlinha 2\x1b[201~');
    expect(send).not.toHaveBeenCalledWith('\r');
    vi.advanceTimersByTime(80);
    expect(send).toHaveBeenLastCalledWith('\r');
    expect((field as HTMLTextAreaElement).value).toBe('');
  });

  it('adds the paths of attached and pasted files to the message', async () => {
    uploadFile
      .mockResolvedValueOnce('/tmp/up/a.png')
      .mockResolvedValueOnce('/tmp/up/b.png');
    renderChat();
    const field = screen.getByLabelText(
      'Message to Claude',
    ) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'veja' } });
    fireEvent.change(screen.getByTestId('chat-file-input'), {
      target: { files: [new File(['x'], 'a.png')] },
    });
    await waitFor(() => expect(field.value).toBe('veja /tmp/up/a.png '));
    fireEvent.paste(field, {
      clipboardData: { files: [new File(['y'], 'b.png')] },
    });
    await waitFor(() =>
      expect(field.value).toBe('veja /tmp/up/a.png /tmp/up/b.png '),
    );
    expect(uploadFile).toHaveBeenCalledWith('a1', expect.any(File));
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps dropped files away from the terminal underneath', async () => {
    uploadFile.mockResolvedValueOnce('/tmp/up/c.png');
    const parentDrop = vi.fn();
    render(
      <div onDrop={parentDrop}>
        <ChatView
          agentId="a1"
          socket={socket as unknown as Socket}
          send={send}
          onShowTerminal={onShowTerminal}
        />
      </div>,
    );
    fireEvent.drop(screen.getByLabelText('Message to Claude'), {
      dataTransfer: { types: ['Files'], files: [new File(['z'], 'c.png')] },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Message to Claude') as HTMLTextAreaElement)
          .value,
      ).toBe('/tmp/up/c.png '),
    );
    expect(parentDrop).not.toHaveBeenCalled();
  });
});
