import React, { useState } from 'react';
import { AlertTriangle, Settings, X } from 'lucide-react';
import type { Host, ToolInfo, ToolSetting, ToolSettingChange } from '../../api';
import { useI18n } from '../../i18n';

/** Props for the HostSettingsModal component. */
interface HostSettingsModalProps {
  host: Host;
  /** Tools the host's daemon detects right now. */
  tools: ToolInfo[];
  /** Saves a change to one tool. Rejects if it cannot be saved. */
  onChange: (tool: string, change: ToolSettingChange) => Promise<void>;
  onClose: () => void;
}

/** One line of the dialog: a tool and what is known about it. */
interface Row {
  name: string;
  /** Name the tool's profile gives it. */
  defaultName: string;
  setting?: ToolSetting;
  /** Default command lines from the tool's profile. */
  commands?: ToolInfo['commands'];
  /** Whether the daemon finds the tool on the host. */
  detected: boolean;
  signedIn: boolean;
}

/**
 * Text field of one tool setting. Saves on Enter or when focus
 * leaves; Escape puts the saved value back.
 */
const SettingInput: React.FC<{
  saved: string;
  label: string;
  placeholder: string;
  maxLength: number;
  mono?: boolean;
  onSave: (value: string) => void;
}> = ({ saved, label, placeholder, maxLength, mono, onSave }) => {
  const [value, setValue] = useState(saved);
  const commit = () => {
    if (value.trim() !== saved) onSave(value.trim());
  };
  return (
    <input
      type="text"
      value={value}
      maxLength={maxLength}
      aria-label={label}
      placeholder={placeholder}
      enterKeyHint="done"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setValue(saved);
      }}
      className={`w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-accent ${mono ? 'font-mono text-xs' : 'text-sm'}`}
    />
  );
};

/**
 * Per-host settings: which AI tools are offered on the host,
 * what their spawn buttons are called, and the command lines
 * that start them (to add flags, or pick another binary).
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
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const settings = host.tool_settings || [];
  const rows: Row[] = [
    ...tools.map((tool) => ({
      name: tool.name,
      defaultName: tool.display_name,
      setting: settings.find((s) => s.tool === tool.name),
      commands: tool.commands,
      detected: true,
      signedIn: tool.authenticated !== false,
    })),
    ...settings
      .filter((s) => !tools.some((tool) => tool.name === s.tool))
      .map((s) => ({
        name: s.tool,
        defaultName: s.tool,
        setting: s,
        detected: false,
        signedIn: true,
      })),
  ];

  const save = async (tool: string, change: ToolSettingChange) => {
    try {
      await onChange(tool, change);
      setError(null);
    } catch (err) {
      console.error('Failed to save tool settings:', err);
      setError(t('hostSettings.saveFailed'));
    }
  };

  return (
    <div className="app-root fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center sm:p-4">
      {/* Full screen on phones, a centered dialog elsewhere. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('hostSettings.title', { host: host.name })}
        className="bg-slate-800 sm:border border-slate-700 sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-md shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex justify-between items-center px-4 py-3 sm:p-6 border-b border-slate-700 bg-slate-800/50 shrink-0">
          <h3 className="text-lg sm:text-xl font-bold text-slate-50 flex items-center gap-2 min-w-0 truncate">
            <Settings size={22} className="text-accent shrink-0" />
            <span className="truncate">{host.name}</span>
          </h3>
          <button
            onClick={onClose}
            aria-label={t('hostSettings.close')}
            className="text-slate-400 hover:text-slate-50 transition-colors p-2 -m-2"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-4 sm:p-6 flex-1 min-h-0 sm:flex-none sm:max-h-[70vh] overflow-y-auto">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
            {t('hostSettings.tools')}
          </p>
          <p className="text-xs text-slate-400 mb-4">
            {t('hostSettings.help')}
          </p>
          {error && (
            <p role="alert" className="mb-3 text-xs text-red-400">
              {error}
            </p>
          )}
          {rows.length === 0 && (
            <p className="text-sm text-slate-400">
              {t('hostSettings.noTools')}
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
                    aria-label={t('hostSettings.offer', {
                      tool: row.defaultName,
                    })}
                    onChange={(e) =>
                      save(row.name, { enabled: e.target.checked })
                    }
                    className="h-5 w-5 shrink-0 accent-accent cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    {/* Keyed by the saved name, so a change made
                        elsewhere replaces what is typed here. */}
                    <SettingInput
                      key={row.setting?.label ?? ''}
                      saved={row.setting?.label ?? ''}
                      label={t('hostSettings.buttonName', {
                        tool: row.defaultName,
                      })}
                      placeholder={row.defaultName}
                      maxLength={40}
                      onSave={(label) => save(row.name, { label })}
                    />
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span className="font-mono truncate">{row.name}</span>
                      {!row.detected && (
                        <span>{t('hostSettings.notDetected')}</span>
                      )}
                      {!row.signedIn && (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <AlertTriangle size={11} />{' '}
                          {t('hostSettings.notSignedIn')}
                        </span>
                      )}
                    </p>
                    <details
                      className="mt-1"
                      open={
                        !!(
                          row.setting?.command_new ||
                          row.setting?.command_resume
                        )
                      }
                    >
                      <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
                        {t('hostSettings.command')}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {(['new', 'resume'] as const).map((mode) => {
                          const field = `command_${mode}` as const;
                          const saved = row.setting?.[field] ?? '';
                          return (
                            <label key={mode} className="block">
                              <span className="text-[11px] text-slate-500">
                                {mode === 'new'
                                  ? t('hostSettings.newSession')
                                  : t('hostSettings.resumeSession')}
                              </span>
                              <SettingInput
                                key={saved}
                                saved={saved}
                                label={t(
                                  mode === 'new'
                                    ? 'hostSettings.newCommand'
                                    : 'hostSettings.resumeCommand',
                                  { tool: row.defaultName },
                                )}
                                placeholder={
                                  row.commands?.[mode] ||
                                  (mode === 'resume'
                                    ? t('hostSettings.sameAsNew')
                                    : row.name)
                                }
                                maxLength={2000}
                                mono
                                onSave={(value) =>
                                  save(row.name, { [field]: value })
                                }
                              />
                            </label>
                          );
                        })}
                        <p className="text-[11px] text-slate-500">
                          {t('hostSettings.commandHelp')}
                        </p>
                      </div>
                    </details>
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
