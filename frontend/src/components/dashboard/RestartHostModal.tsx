import React, { useState } from 'react';
import { Radiation } from 'lucide-react';
import type { Host } from '../../api';
import { restartHost } from '../../api';

/** Props for the RestartHostModal component. */
interface RestartHostModalProps {
  host: Host;
  /** Sessions running on the host, all of which end. */
  sessions: number;
  onClose: () => void;
}

/** A mushroom cloud, drawn inline so the dialog needs no asset. */
const MushroomCloud: React.FC = () => (
  <svg
    viewBox="0 0 120 120"
    role="img"
    aria-label="Nuclear explosion"
    className="w-32 h-32 mx-auto motion-safe:animate-pulse"
  >
    <defs>
      <radialGradient id="nuke-fire" cx="50%" cy="40%" r="60%">
        <stop offset="0%" stopColor="#fef08a" />
        <stop offset="45%" stopColor="#f97316" />
        <stop offset="100%" stopColor="#7c2d12" />
      </radialGradient>
    </defs>
    <ellipse cx="60" cy="110" rx="52" ry="7" fill="#f97316" opacity="0.5" />
    <path d="M52 110 L55 56 H65 L68 110 Z" fill="url(#nuke-fire)" />
    <ellipse cx="60" cy="80" rx="20" ry="5" fill="#ea580c" />
    <circle cx="38" cy="44" r="18" fill="url(#nuke-fire)" />
    <circle cx="82" cy="44" r="18" fill="url(#nuke-fire)" />
    <circle cx="60" cy="32" r="24" fill="url(#nuke-fire)" />
    <ellipse cx="60" cy="56" rx="40" ry="8" fill="#9a3412" />
  </svg>
);

/**
 * Confirms a restart of a host's daemon. The restart ends every
 * session on the host, so the dialog says so loudly. Cancel has
 * the focus: Enter alone never restarts.
 */
const RestartHostModal: React.FC<RestartHostModalProps> = ({
  host,
  sessions,
  onClose,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await restartHost(host.id);
      onClose();
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })
        .response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Restart failed.');
      setBusy(false);
    }
  };

  return (
    <div
      className="app-root fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restart-host-title"
        aria-describedby="restart-host-text"
        className="bg-slate-900 border border-red-500/50 rounded-2xl w-full max-w-sm shadow-2xl shadow-red-900/40 p-6 text-center"
      >
        <MushroomCloud />
        <h3
          id="restart-host-title"
          className="mt-3 text-xl font-bold text-red-400 flex items-center justify-center gap-2"
        >
          <Radiation size={22} /> Restart {host.name}?
        </h3>
        <p id="restart-host-text" className="mt-2 text-sm text-slate-300">
          This nukes <strong className="text-red-300">every session</strong> on
          this host
          {sessions > 0 && ` (${sessions} running right now)`}. Anything a
          session is doing stops. Conversations can be resumed afterwards.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            autoFocus
            onClick={onClose}
            className="flex-1 px-3 py-2 rounded-md border border-slate-600 bg-slate-700/60 hover:bg-slate-600 text-slate-200 text-sm cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={restart}
            disabled={busy}
            className="flex-1 px-3 py-2 rounded-md bg-red-600 hover:bg-red-500 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Restarting…' : 'Nuke & restart'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RestartHostModal;
