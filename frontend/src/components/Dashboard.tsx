import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  getHosts,
  getAgents,
  spawnAgent,
  createProject,
  getToolModels,
  stopAgent,
  deleteHost,
  getVersion,
  updateToolSetting,
} from '../api';
import type {
  Host,
  Agent,
  ToolSetting,
  ToolSettingChange,
  VersionInfo,
} from '../api';
import { normalizeToolInfo } from '../api';
import { Cpu, Activity, GitPullRequest, ListTodo } from 'lucide-react';
import { getSocket } from '../socket';
import LogoSvg from './LogoSvg';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import SpawnModal from './dashboard/SpawnModal';
import HostCard from './dashboard/HostCard';

interface DashboardProps {
  onAttach: (agentId: string) => void;
  /** Reports the active agents whenever they change, so the
   *  workspace can label tabs and track attention without
   *  fetching or subscribing a second time. */
  onAgentsChange?: (agents: Agent[]) => void;
  /** Opens the Tasks tab. */
  onOpenTasks?: () => void;
  /** Opens the Git tab. */
  onOpenGit?: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({
  onAttach,
  onAgentsChange,
  onOpenTasks,
  onOpenGit,
}) => {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  // The message key, so the error follows a language change.
  const [error, setError] = useState<MessageKey | null>(null);

  const [activeSpawn, setActiveSpawn] = useState<{
    hostId: number;
    tool: string;
  } | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);

  // Fetch version info on mount
  const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';
  useEffect(() => {
    getVersion()
      .then(setVersionInfo)
      .catch(() => {}); // Degrade gracefully
  }, []);

  const projectsCache = useRef<Record<number, Host['projects']>>({});

  const fetchData = async () => {
    try {
      const [h, a] = await Promise.all([getHosts(), getAgents()]);
      const enrichedHosts = h.map((host) => ({
        ...host,
        projects: projectsCache.current[host.id] || host.projects,
      }));
      setHosts(enrichedHosts);
      setAgents(a);
      setError(null);
    } catch (err) {
      setError('dashboard.fetchFailed');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSpawn = async (
    hostId: number,
    toolName: string,
    projectDir?: string,
    taskDescription?: string,
    sessionMode?: string,
    useWorktree?: boolean,
    model?: string,
    sessionName?: string,
  ) => {
    try {
      const newAgent = await spawnAgent(
        hostId,
        toolName,
        projectDir,
        taskDescription,
        sessionMode,
        useWorktree,
        undefined,
        undefined,
        model,
        sessionName,
      );
      setActiveSpawn(null);
      await fetchData();
      onAttach(newAgent.agent_id);
    } catch (err) {
      console.error('Failed to spawn agent:', err);
      // Say why when the server gave a reason (for example a
      // tool that was disabled on the host from another browser).
      const detail = (err as { response?: { data?: { detail?: unknown } } })
        .response?.data?.detail;
      alert(typeof detail === 'string' ? detail : t('dashboard.spawnFailed'));
    }
  };

  const handleStop = async (agentId: string) => {
    if (!window.confirm(t('dashboard.confirmStop'))) return;
    try {
      // An open tab or window for this agent closes itself
      // on the resulting "stopped" status event.
      await stopAgent(agentId);
      setTimeout(fetchData, 500);
    } catch (err) {
      console.error('Failed to stop agent:', err);
    }
  };

  /** Saves a tool's setting on a host and shows the result.
   *  Rejects when it cannot be saved, for the dialog to say so. */
  const handleToolSetting = async (
    hostId: number,
    tool: string,
    change: ToolSettingChange,
  ) => {
    const toolSettings = await updateToolSetting(hostId, tool, change);
    setHosts((prev) =>
      prev.map((h) =>
        h.id === hostId ? { ...h, tool_settings: toolSettings } : h,
      ),
    );
  };

  const handleDeleteHost = async (hostId: number) => {
    if (!window.confirm(t('dashboard.confirmDeleteHost'))) return;
    try {
      await deleteHost(hostId);
      await fetchData();
    } catch (err) {
      console.error('Failed to delete host:', err);
      alert(t('dashboard.deleteHostFailed'));
    }
  };

  const requestProjects = () => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('request_projects', {});
    }
  };

  useEffect(() => {
    fetchData();
    // One connection for the whole page, shared with the
    // terminal of the active tab.
    const socket = getSocket();
    socketRef.current = socket;

    const onConnect = () => {
      socket.emit('request_projects', {});
    };

    const onStatusUpdate = (data: { agent_id: string; status: string }) => {
      if (data.status === 'closed' || data.status === 'stopped') {
        setAgents((prev) => prev.filter((a) => a.agent_id !== data.agent_id));
      } else {
        setAgents((prev) =>
          prev.map((a) =>
            a.agent_id === data.agent_id ? { ...a, status: data.status } : a,
          ),
        );
      }
    };

    const onTelemetryUpdate = (data: {
      agent_id: string;
      telemetry: Agent['telemetry'];
    }) => {
      setAgents((prev) => {
        const exists = prev.some((a) => a.agent_id === data.agent_id);
        if (!exists) {
          // Agent not in state — likely spawned after
          // a daemon reconnect cleared old records.
          // Trigger a full fetch to pick up the new agent.
          fetchData();
          return prev;
        }
        return prev.map((a) =>
          a.agent_id === data.agent_id
            ? { ...a, telemetry: data.telemetry }
            : a,
        );
      });
    };

    const onHostTelemetryUpdate = (data: {
      host_id: number;
      telemetry: Host['projects'];
    }) => {
      projectsCache.current[data.host_id] = data.telemetry;
      setHosts((prev) =>
        prev.map((h) =>
          h.id === data.host_id ? { ...h, projects: data.telemetry } : h,
        ),
      );
    };

    // Another browser enabled, disabled or renamed a tool.
    const onHostSettingsUpdate = (data: {
      host_id: number;
      tool_settings: ToolSetting[];
    }) => {
      setHosts((prev) =>
        prev.map((h) =>
          h.id === data.host_id
            ? { ...h, tool_settings: data.tool_settings }
            : h,
        ),
      );
    };

    socket.on('connect', onConnect);
    socket.on('agent_status_update', onStatusUpdate);
    socket.on('agent_telemetry_update', onTelemetryUpdate);
    socket.on('host_telemetry_update', onHostTelemetryUpdate);
    socket.on('host_settings_update', onHostSettingsUpdate);
    if (socket.connected) onConnect();

    // Poll as a safety net for missed socket events.
    // Socket.IO handles real-time updates; this catches
    // edge cases like agents spawned by other UI clients.
    const interval = setInterval(fetchData, 30000);
    return () => {
      clearInterval(interval);
      socket.off('connect', onConnect);
      socket.off('agent_status_update', onStatusUpdate);
      socket.off('agent_telemetry_update', onTelemetryUpdate);
      socket.off('host_telemetry_update', onHostTelemetryUpdate);
      socket.off('host_settings_update', onHostSettingsUpdate);
    };
  }, []);

  // Sort hosts: online first, then alphabetical by name
  const activeAgents = useMemo(
    () => agents.filter((a) => a.status === 'active'),
    [agents],
  );

  useEffect(() => {
    if (!loading) onAgentsChange?.(activeAgents);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback identity is irrelevant
  }, [activeAgents, loading]);

  const sortedHosts = [...hosts].sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return a.name.localeCompare(b.name);
  });

  if (loading)
    return <div className="p-8 text-slate-50">{t('dashboard.loading')}</div>;
  if (error)
    return (
      <div className="p-4 sm:p-8 max-w-md mx-auto">
        <div
          className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative"
          role="alert"
        >
          <strong className="font-bold">{t('dashboard.error')} </strong>
          <span className="block sm:inline">{t(error)}</span>
          <div className="mt-3">
            <a
              href={
                import.meta.env.VITE_API_URL
                  ? `${import.meta.env.VITE_API_URL}/login`
                  : `http://${window.location.hostname}:8000/login`
              }
              className="block text-center bg-red-700 hover:bg-red-600 text-white font-bold py-3 rounded-lg"
            >
              {t('dashboard.login')}
            </a>
          </div>
        </div>
      </div>
    );

  return (
    <div className="max-w-7xl mx-auto p-3 sm:p-8">
      <header className="mb-4 sm:mb-8 flex flex-col gap-3 sm:gap-4">
        <div className="flex items-start gap-3">
          <h1 className="flex-1 text-xl sm:text-3xl font-bold flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-50 min-w-0">
            <LogoSvg className="w-7 h-7 sm:w-9 sm:h-9" />
            {t('dashboard.title')}
            <span className="text-xs font-normal text-slate-500 font-mono self-end mb-0.5">
              {appVersion}
              {versionInfo?.update_available && versionInfo.latest && (
                <>
                  {' '}
                  <span className="text-slate-600">→</span>{' '}
                  <a
                    href={versionInfo.latest_url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {t('dashboard.available', { version: versionInfo.latest })}
                  </a>
                </>
              )}
              {!versionInfo?.update_available &&
                versionInfo?.is_dev &&
                versionInfo?.latest && (
                  <>
                    {' '}
                    <span className="text-slate-600">·</span>{' '}
                    <a
                      href={versionInfo.latest_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-500 hover:underline"
                    >
                      {t('dashboard.latest', { version: versionInfo.latest })}
                    </a>
                  </>
                )}
            </span>
          </h1>
          {onOpenTasks && (
            <button
              onClick={onOpenTasks}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 hover:border-accent-muted hover:text-slate-50"
            >
              <ListTodo size={16} className="text-accent" />
              {t('tabs.tasks')}
            </button>
          )}
          {onOpenGit && (
            <button
              onClick={onOpenGit}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-200 hover:border-accent-muted hover:text-slate-50"
            >
              <GitPullRequest size={16} className="text-accent" />
              {t('tabs.git')}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-4">
          <div className="bg-slate-800 p-2 sm:p-3 rounded-lg flex items-center gap-2 sm:gap-3">
            <Cpu className="text-accent w-5 h-5 sm:w-6 sm:h-6" />
            <div>
              <p className="text-[10px] sm:text-xs text-slate-400">
                <span className="sm:hidden">{t('dashboard.hostsShort')}</span>
                <span className="hidden sm:inline">{t('dashboard.hosts')}</span>
              </p>
              <p className="font-bold text-slate-50">{hosts.length}</p>
            </div>
          </div>
          <div className="bg-slate-800 p-2 sm:p-3 rounded-lg flex items-center gap-2 sm:gap-3">
            <Activity className="text-green-400 w-5 h-5 sm:w-6 sm:h-6" />
            <div>
              <p className="text-[10px] sm:text-xs text-slate-400">
                <span className="sm:hidden">{t('dashboard.agentsShort')}</span>
                <span className="hidden sm:inline">
                  {t('dashboard.agents')}
                </span>
              </p>
              <p className="font-bold text-slate-50">{activeAgents.length}</p>
            </div>
          </div>
        </div>
      </header>

      <section>
        <div className="flex justify-between items-center mb-3 sm:mb-6">
          <h2 className="text-base sm:text-xl font-semibold text-slate-300">
            {t('dashboard.section')}
          </h2>
          <span className="hidden sm:inline text-xs text-slate-500 italic">
            {t('dashboard.live')}
          </span>
        </div>
        <div className="space-y-4 sm:space-y-6">
          {sortedHosts.map((host) => (
            <HostCard
              key={host.id}
              host={host}
              agents={activeAgents.filter((a) => a.host_id === host.id)}
              onAttach={onAttach}
              onStop={handleStop}
              onSpawnClick={(hostId, tool) => setActiveSpawn({ hostId, tool })}
              onDeleteHost={handleDeleteHost}
              onToolSetting={handleToolSetting}
            />
          ))}
        </div>
      </section>

      {activeSpawn &&
        (() => {
          const spawnHost = hosts.find((h) => h.id === activeSpawn.hostId);
          const toolInfo = spawnHost?.projects?.available_tools
            ?.map(normalizeToolInfo)
            .find((t) => t.name === activeSpawn.tool);
          return (
            <SpawnModal
              host={spawnHost!}
              tool={activeSpawn.tool}
              displayName={
                spawnHost?.tool_settings?.find(
                  (s) => s.tool === activeSpawn.tool,
                )?.label || toolInfo?.display_name
              }
              supportsResume={toolInfo?.supports_resume}
              models={toolInfo?.models}
              defaultModel={toolInfo?.default_model}
              modelsError={toolInfo?.models_error}
              onLoadModels={() =>
                getToolModels(activeSpawn.hostId, activeSpawn.tool)
              }
              onCreateProject={(name, gitInit) =>
                createProject(activeSpawn.hostId, name, gitInit)
              }
              activeAgents={activeAgents.filter(
                (a) => a.host_id === activeSpawn.hostId,
              )}
              onClose={() => setActiveSpawn(null)}
              onSpawn={(dir, task, sessionMode, useWorktree, model, name) =>
                handleSpawn(
                  activeSpawn.hostId,
                  activeSpawn.tool,
                  dir,
                  task,
                  sessionMode,
                  useWorktree,
                  model,
                  name,
                )
              }
              onRefresh={requestProjects}
            />
          );
        })()}
    </div>
  );
};

export default Dashboard;
