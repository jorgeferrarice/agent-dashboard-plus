/**
 * The notification sound played when a session has waited for
 * the user for a while (see `soundDue` in attention.ts).
 *
 * Sounds are made with the Web Audio API, so there are no audio
 * files to ship. The user's choice is kept in this browser, like
 * the theme: a phone and a desktop can differ.
 */

/** The sounds on offer, in menu order; the first is the default. */
export const SOUNDS = ['chime', 'ping', 'double', 'soft'] as const;
export type SoundKind = (typeof SOUNDS)[number];
/** What the user picked: a sound, or none. */
export type SoundChoice = SoundKind | 'off';

export const DEFAULT_SOUND: SoundChoice = 'chime';
const STORAGE_KEY = 'agentDashboard.sound';

/** Loudness of every sound (0 to 1): clear but not startling. */
const VOLUME = 0.25;

/** Each sound's notes: [frequency in Hz, start s, length s]. */
const TONES: Record<SoundKind, { wave: OscillatorType; notes: number[][] }> = {
  // Two bell-like notes going up: the default.
  chime: {
    wave: 'sine',
    notes: [
      [880, 0, 0.6],
      [1318.5, 0.12, 0.8],
    ],
  },
  ping: { wave: 'sine', notes: [[1568, 0, 0.5]] },
  double: {
    wave: 'triangle',
    notes: [
      [987.8, 0, 0.18],
      [987.8, 0.22, 0.25],
    ],
  },
  soft: {
    wave: 'sine',
    notes: [
      [523.3, 0, 0.5],
      [659.3, 0.18, 0.7],
    ],
  },
};

/** The sound this browser plays; the default when none was set. */
export function loadSound(): SoundChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'off' || SOUNDS.includes(stored as SoundKind)) {
      return stored as SoundChoice;
    }
  } catch {
    // Storage blocked (private window): use the default.
  }
  return DEFAULT_SOUND;
}

/** Remembers the user's choice in this browser. */
export function saveSound(choice: SoundChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

let context: AudioContext | null = null;

/** The page's audio output, made on first use; null without
 *  Web Audio. */
function audio(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/**
 * Lets the page play sounds later. Browsers keep a page silent
 * until the user clicks or types in it; calling this from such
 * an event switches the audio on for the rest of the visit.
 */
export function unlockAudio(): void {
  const ctx = audio();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

/** Plays a sound now. Does nothing where audio is unavailable. */
export function playSound(kind: SoundKind): void {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const { wave, notes } = TONES[kind];
  const t0 = ctx.currentTime + 0.01;
  for (const [frequency, start, length] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = frequency;
    // Quick fade in, slow fade out: a bell, not a click.
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(VOLUME, t0 + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + length + 0.05);
  }
}
