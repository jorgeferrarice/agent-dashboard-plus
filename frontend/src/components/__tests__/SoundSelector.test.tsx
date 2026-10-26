import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const played: string[] = [];
vi.mock('../tabs/sound', async (importActual) => ({
  ...(await importActual<typeof import('../tabs/sound')>()),
  playSound: (kind: string) => played.push(kind),
}));

import SoundSelector from '../SoundSelector';
import { loadSound } from '../tabs/sound';

beforeEach(() => {
  // Node's own localStorage global is unusable here: use an
  // in-memory one.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  played.length = 0;
});

describe('SoundSelector', () => {
  it('starts on the default sound and plays it on ▶', () => {
    render(<SoundSelector />);
    expect(screen.getByLabelText('Notification sound')).toHaveValue('chime');
    fireEvent.click(screen.getByLabelText('Play the sound'));
    expect(played).toEqual(['chime']);
  });

  it('saves the choice and plays it as a preview', () => {
    render(<SoundSelector />);
    fireEvent.change(screen.getByLabelText('Notification sound'), {
      target: { value: 'double' },
    });
    expect(loadSound()).toBe('double');
    expect(played).toEqual(['double']);
  });

  it('can be turned off', () => {
    render(<SoundSelector />);
    fireEvent.change(screen.getByLabelText('Notification sound'), {
      target: { value: 'off' },
    });
    expect(loadSound()).toBe('off');
    expect(screen.getByLabelText('Play the sound')).toBeDisabled();
    expect(played).toEqual([]);
  });
});
