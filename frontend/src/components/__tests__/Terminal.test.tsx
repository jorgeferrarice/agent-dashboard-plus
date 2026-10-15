import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';

// xterm needs a real layout engine; the drop zone does not.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    scrollToBottom = vi.fn();
    onScroll = vi.fn();
    onData = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const uploadFile = vi.fn();
vi.mock('../../api', () => ({
  getAgentDetails: vi.fn(() => new Promise(() => {})),
  getCompanions: vi.fn(() => Promise.resolve([])),
  spawnAgent: vi.fn(),
  stopAgent: vi.fn(),
  normalizeToolInfo: vi.fn(),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

import Terminal from '../Terminal';

const socket = {
  connected: false,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
};

const renderTerminal = () => {
  const { container } = render(
    <Terminal
      agentId="a1"
      onClose={() => {}}
      socket={socket as unknown as Socket}
    />,
  );
  // The drop zone is the terminal's parent container.
  return container.querySelector('.terminal')!.parentElement!.parentElement!;
};

const file = (name: string) => new File(['x'], name);

describe('Terminal file drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('shows the drop overlay only while files are dragged over', () => {
    const zone = renderTerminal();
    fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText(/Drop files/)).toBeNull();
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText(/Drop files/)).toBeTruthy();
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(screen.queryByText(/Drop files/)).toBeNull();
  });

  it('uploads dropped files and pastes their paths without Enter', async () => {
    uploadFile
      .mockResolvedValueOnce('/tmp/up/a.png')
      .mockResolvedValueOnce('/tmp/up/b.txt');
    const zone = renderTerminal();
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [file('a.png'), file('b.txt')] },
    });
    await waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('terminal_input', {
        target_sid: 'a1',
        input: '\x1b[200~/tmp/up/a.png /tmp/up/b.txt \x1b[201~',
      }),
    );
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to items when files is empty', async () => {
    uploadFile.mockResolvedValueOnce('/tmp/up/a.png');
    const zone = renderTerminal();
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ['Files'],
        files: [],
        items: [{ kind: 'file', getAsFile: () => file('a.png') }],
      },
    });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
  });

  it('says so when the drop carries no file', () => {
    const zone = renderTerminal();
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [], items: [] },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/no file/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a file over the limit without sending it', () => {
    const zone = renderTerminal();
    const big = file('big.iso');
    Object.defineProperty(big, 'size', { value: 91 * 1024 * 1024 });
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [big] } });
    expect(screen.getByRole('alert').textContent).toBe(
      'big.iso: larger than 90 MB.',
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('explains a failure that has no server answer', async () => {
    uploadFile.mockRejectedValueOnce(new Error('Network Error'));
    const zone = renderTerminal();
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [file('dir')] },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/dir: could not be read or sent/);
  });

  it('shows the reason when an upload is refused', async () => {
    uploadFile.mockRejectedValueOnce({
      response: { data: { detail: 'File is larger than 25 MB.' } },
    });
    const zone = renderTerminal();
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], files: [file('big.bin')] },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('big.bin: File is larger than 25 MB.');
    expect(socket.emit).not.toHaveBeenCalledWith(
      'terminal_input',
      expect.anything(),
    );
  });
});
