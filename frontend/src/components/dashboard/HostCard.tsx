import React, { useState } from 'react';
import {
  AlertTriangle,
  Server,
  Settings,
  Wifi,
  WifiOff,
  PlusCircle,
  Radiation,
  Trash2,
} from 'lucide-react';
import type { Host, Agent, ToolSettingChange } from '../../api';
import { normalizeToolInfo } from '../../api';
import { useI18n } from '../../i18n';
import AgentSessionCard from './AgentSessionCard';
import HostLimits from './HostLimits';
import HostSettingsModal from './HostSettingsModal';
import RestartHostModal from './RestartHostModal';
import { getToolColorsByKeyword } from './utils';

/** Props for the HostCard component. */
interface HostCardProps {
  host: Host;
  /** Pre-filtered active agents for this host. */
  agents: Agent[];
  onAttach: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onSpawnClick: (hostId: number, tool: string) => void;
  onDeleteHost: (hostId: number) => void;
  /** Enables, disables or renames a tool on this host. */
  onToolSetting: (
    hostId: number,
    tool: string,
    change: ToolSettingChange,
  ) => Promise<void>;
}

/**
 * Unified host card that combines host info, spawn/delete
 * controls, and active agent session cards in one view.
 * Offline hosts are muted with disabled spawn buttons.
 */
const HostCard: React.FC<HostCardProps> = ({
  host,
  agents,
  onAttach,
  onStop,
  onSpawnClick,
  onDeleteHost,
  onToolSetting,
}) => {
  const { t, language } = useI18n();
  const isOnline = host.status === 'online';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const availableTools = (host.projects?.available_tools || []).map(
    normalizeToolInfo,
  );
  const settingOf = (tool: string) =>
    host.tool_settings?.find((s) => s.tool === tool);
  // Tools the user turned off for this host get no button.
  const offeredTools = availableTools.filter(
    (tool) => settingOf(tool.name)?.enabled ?? true,
  );

  return (
    <div
      className={`bg-slate-800/40 rounded-2xl border border-slate-700 overflow-hidden${isOnline ? '' : ' opacity-60'}`}
    >
      {/* Header */}
      <div className="px-3 sm:px-6 py-3 bg-slate-800/80 border-b border-slate-700/50">
        {/* Row 1: Host info */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Server size={16} className="text-slate-400" />
          <span className="font-semibold text-slate-50 text-sm">
            {host.name}
          </span>
          {isOnline ? (
            <span className="inline-flex items-center gap-1 text-green-400 text-[10px] font-semibold uppercase">
              <Wifi size={10} /> {t('host.online')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-slate-500 text-[10px] font-semibold uppercase">
              <WifiOff size={10} /> {t('host.offline')}
            </span>
          )}
          <span className="hidden sm:inline text-[10px] text-slate-500">
            {t('host.registered', {
              date: new Date(host.created_at).toLocaleDateString(language),
            })}
          </span>
          <span className="text-[10px] text-slate-500 ml-auto">
            {t(agents.length === 1 ? 'host.agentCount' : 'host.agentsCount', {
              count: agents.length,
            })}
          </span>
        </div>

        {/* Row 2: Spawn + Delete buttons */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {offeredTools.map((tool) => {
            const colors = getToolColorsByKeyword(tool.color);
            const label = settingOf(tool.name)?.label || tool.display_name;
            const signedOut = tool.authenticated === false;
            return (
              <button
                key={tool.name}
                title={
                  signedOut
                    ? t('host.spawnSignedOutTitle', { label })
                    : t('host.spawnTitle', { label })
                }
                onClick={() => onSpawnClick(host.id, tool.name)}
                disabled={!isOnline}
                className={`text-xs px-3 py-2 sm:py-1.5 rounded-md border transition-colors flex items-center gap-1.5 ${
                  isOnline
                    ? `${colors.button} ${colors.buttonHover} cursor-pointer`
                    : 'bg-slate-700/50 text-slate-500 border-slate-700 cursor-not-allowed'
                }`}
              >
                <PlusCircle size={14} /> {label}
                {signedOut && (
                  <AlertTriangle
                    size={12}
                    role="img"
                    aria-label={t('host.notSignedIn')}
                    className="text-amber-400"
                  />
                )}
              </button>
            );
          })}
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs px-3 py-2 sm:py-1.5 rounded-md border transition-colors flex items-center gap-1.5 bg-slate-700/50 hover:bg-slate-700 text-slate-300 border-slate-600 cursor-pointer ml-auto"
            title={t('host.settingsTitle')}
          >
            <Settings size={14} /> {t('host.settings')}
          </button>
          <button
            onClick={() => setRestartOpen(true)}
            disabled={!isOnline}
            className="text-xs px-3 py-2 sm:py-1.5 rounded-md border transition-colors flex items-center gap-1.5 bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border-amber-500/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('host.restartTitle')}
          >
            <Radiation size={14} /> {t('host.restart')}
          </button>
          <button
            onClick={() => onDeleteHost(host.id)}
            className="text-xs px-3 py-2 sm:py-1.5 rounded-md border transition-colors flex items-center gap-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-400 border-red-500/30 cursor-pointer"
            title={t('host.deleteTitle')}
          >
            <Trash2 size={14} /> {t('host.delete')}
          </button>
        </div>

        {/* Row 3: plan limits of the accounts offered here */}
        <HostLimits
          entries={offeredTools
            .filter((tool) => tool.has_limits)
            .map((tool) => ({
              name: tool.name,
              label: settingOf(tool.name)?.label || tool.display_name,
              usage: host.projects?.usage?.[tool.name],
            }))}
        />
      </div>

      {/* Body: Agent session cards or empty state */}
      {agents.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 p-3 sm:p-4">
          {agents.map((agent) => (
            <AgentSessionCard
              key={agent.id}
              agent={agent}
              availableTools={availableTools}
              onAttach={onAttach}
              onStop={onStop}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 sm:px-6 py-3 text-sm text-slate-500 italic">
          {t('host.noSessions')}
        </div>
      )}
      {settingsOpen && (
        <HostSettingsModal
          host={host}
          tools={availableTools}
          onChange={(tool, change) => onToolSetting(host.id, tool, change)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {restartOpen && (
        <RestartHostModal
          host={host}
          sessions={agents.length}
          onClose={() => setRestartOpen(false)}
        />
      )}
    </div>
  );
};

export default HostCard;
