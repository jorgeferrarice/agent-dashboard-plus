import React, { useState } from 'react';
import { AlertTriangle, Settings, X } from 'lucide-react';
import type { Host, ToolInfo, ToolSetting } from '../../api';

/** Props for the HostSettingsModal component. */
interface HostSettingsModalProps {
  host: Host;
  /** Tools the host's daemon detects right now. */
  tools: ToolInfo[];
  /** Saves a change to one tool. Rejects if it cannot be saved. */
  onChange: (
    tool: string,
    change: { enabled?: boolean; label?: string },
  ) => Promise<void>;
  onClose: () => void;
}

/** One line of the dialog: a tool and what is known about it. */
interface Row {
  name: string;
  /** Name the tool's profile gives it. */
  defaultName: string;
  setting?: ToolSetting;
  /** Whether the daemon finds the tool on the host. */
  detected: boolean;
  signedIn: boolean;
}

/**
 * Name field of one tool. Saves on Enter or when focus leaves;
 * Escape puts the saved name back.
 */
const LabelInput: React.FC<{
  row: Row;
  onSave: (label: string) => void;
}> = ({ row, onSave }) => {
  const saved = row.setting?.label ?? '';
  const [value, setValue] = useState(saved);
  const commit = () => {
    if (value.trim() !== saved) onSave(value.trim());
  };
  return (
    <input
      type="text"
      value={value}
      maxLength={40}
      aria-label={`Button name for ${row.defaultName}`}
      placeholder={row.defaultName}
      enterKeyHint="done"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setValue(saved);
      }}
      className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-accent"
    />
  );
};

/**
 * Per-host settings: which AI tools are offered on the host and
 * what their spawn buttons are called.
 *
 * Lists every tool the daemon detects, plus tools that have
 * saved settings but are no longer detected (uninstalled, or an
 * account directory that went away). Those are shown muted and
 * keep their settings, so they come back as they were.
 */
const HostSettingsModal: React.FC<HostSettingsModalProps> = ({
  host,
  tools,
  onChange,
  onClose,
}) => {
  const [error, setError] = useState<string | null>(null);
  const settings = host.tool_settings || [];
  const rows: Row[] = [
    ...tools.map((tool) => ({
      name: tool.name,
      defaultName: tool.display_name,
      setting: settings.find((s) => s.tool === tool.name),
      detected: true,
      signedIn: tool.authenticated !== false,
    })),
    ...settings
      .filter((s) => !tools.some((t) => t.name === s.tool))
      .map((s) => ({
        name: s.tool,
        defaultName: s.tool,
        setting: s,
        detected: false,
        signedIn: true,
      })),
  ];

  const save = async (
    tool: string,
    change: { enabled?: boolean; label?: string },
  ) => {
    try {
      await onChange(tool, change);
      setError(null);
    } catch (err) {
      console.error('Failed to save tool settings:', err);
      setError('Could not save. Check your connection and try again.');
    }
  };

  return (
    <div className="app-root fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center sm:p-4">
      {/* Full screen on phones, a centered dialog elsewhere. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Settings for ${host.name}`}
        className="bg-slate-800 sm:border border-slate-700 sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-md shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex justify-between items-center px-4 py-3 sm:p-6 border-b border-slate-700 bg-slate-800/50 shrink-0">
          <h3 className="text-lg sm:text-xl font-bold text-slate-50 flex items-center gap-2 min-w-0 truncate">
            <Settings size={22} className="text-accent shrink-0" />
            <span className="truncate">{host.name}</span>
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-50 transition-colors p-2 -m-2"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-4 sm:p-6 flex-1 min-h-0 sm:flex-none sm:max-h-[70vh] overflow-y-auto">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
            AI tools
          </p>
          <p className="text-xs text-slate-400 mb-4">
            Turn a tool off to hide its button on this host. Type a name to
            rename its button; leave it blank for the default.
          </p>
          {error && (
            <p role="alert" className="mb-3 text-xs text-red-400">
              {error}
            </p>
          )}
          {rows.length === 0 && (
            <p className="text-sm text-slate-400">
              No tools detected on this host yet.
            </p>
          )}
          <ul className="space-y-3">
            {rows.map((row) => {
              const enabled = row.setting?.enabled ?? true;
              return (
                <li
                  key={row.name}
                  className={`flex items-center gap-3${row.detected ? '' : ' opacity-50'}`}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={enabled}
                    aria-label={`Offer ${row.defaultName} on this host`}
                    onChange={(e) =>
                      save(row.name, { enabled: e.target.checked })
                    }
                    className="h-5 w-5 shrink-0 accent-accent cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    {/* Keyed by the saved name, so a change made
                        elsewhere replaces what is typed here. */}
                    <LabelInput
                      key={row.setting?.label ?? ''}
                      row={row}
                      onSave={(label) => save(row.name, { label })}
                    />
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span className="font-mono truncate">{row.name}</span>
                      {!row.detected && <span>Not detected</span>}
                      {!row.signedIn && (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <AlertTriangle size={11} /> Not signed in
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default HostSettingsModal;
