import React from 'react';
import {
  Terminal,
  Activity,
  Square,
  GitBranch,
  Plug,
  Clock,
  FolderOpen,
  FolderGit2,
  ChevronRight,
  GitFork,
  TriangleAlert,
} from 'lucide-react';
import type { Agent, ToolInfo } from '../../api';
import {
  getContextWindow,
  getToolColors,
  getToolColorsByKeyword,
  getProgressColor,
  formatDuration,
  estimateCost,
  formatCost,
  formatTokenCount,
  isModelRecognized,
} from './utils';
import StatusIndicator from './StatusIndicator';
import { useI18n } from '../../i18n';
import EditableTaskDescription from './EditableTaskDescription';

/** Props for the AgentSessionCard component. */
interface AgentSessionCardProps {
  agent: Agent;
  /** Tool metadata from the host's available_tools list. */
  availableTools?: ToolInfo[];
  onAttach: (agentId: string) => void;
  onStop: (agentId: string) => void;
}

/**
 * Renders a single active agent session as a card.
 * Compact by default: header, meta row and
 * attach/stop buttons; task, model, context, cost and MCP
 * details live in a collapsible <details>.
 */
const AgentSessionCard: React.FC<AgentSessionCardProps> = ({
  agent,
  availableTools,
  onAttach,
  onStop,
}) => {
  const { t, language } = useI18n();
  const tel = agent.telemetry || {};
  // Prefer profile color from available_tools metadata,
  // falling back to name-based inference.
  const toolInfo = availableTools?.find((ti) => ti.name === agent.tool_name);
  const toolColors = toolInfo?.color
    ? getToolColorsByKeyword(toolInfo.color)
    : getToolColors(agent.tool_name);
  // Use context_tokens (per-call input tokens) for the
  // progress bar — reflects current context window usage
  // after compression. Do NOT fall back to cumulative
  // tokens, which would cause the dynamic scaling to keep
  // expanding and make the bar useless.
  const ctxTokens = tel.context_tokens || 0;
  const contextMax = getContextWindow(tel.model, ctxTokens);
  const tokenPct = ctxTokens
    ? Math.min((ctxTokens / contextMax) * 100, 100)
    : 0;
  // Use OTLP-reported cost (Claude) or estimate from
  // pricing tables (Gemini / other).
  const displayCost =
    tel.cost_usd && tel.cost_usd > 0
      ? tel.cost_usd
      : estimateCost(
          tel.model,
          tel.input_tokens,
          tel.output_tokens,
          tel.cache_read_tokens,
          tel.cache_creation_tokens,
        );
  const costSource =
    tel.cost_usd && tel.cost_usd > 0
      ? t('session.costReported')
      : t('session.costEstimated');
  const mcpServers = tel.mcp_servers || [];
  const project = tel.git_project || t('session.titleFallback');
  const title = tel.session_name || project;
  const projectInMeta = !!tel.session_name;
  const showModel = !!(
    toolInfo?.has_model ??
    (tel.model && tel.model !== 'detecting...')
  );
  const summaryParts = [
    ctxTokens ? t('session.ctxSummary', { pct: Math.round(tokenPct) }) : '',
    displayCost ? formatCost(displayCost) : '',
  ].filter(Boolean);
  const activityCls = `text-[10px] text-slate-500 font-mono truncate${tel.task_description ? ' mt-1 pt-1 border-t border-slate-700/30' : ''}`;

  return (
    <div
      className={`bg-slate-800 rounded-2xl p-3 sm:p-4 border border-slate-700 ${toolColors.border} transition-all shadow-lg flex flex-col h-full group`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="flex gap-2 items-center min-w-0">
          <span
            className={`shrink-0 text-[10px] px-2 py-0.5 rounded font-bold uppercase border ${toolColors.badge}`}
          >
            {agent.tool_name || t('session.toolFallback')}
          </span>
          {!projectInMeta && tel.git_remote_url ? (
            <a
              href={tel.git_remote_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-sm text-slate-50 truncate hover:underline"
            >
              {title}
            </a>
          ) : (
            <h3
              className="font-bold text-sm text-slate-50 truncate"
              title={title}
            >
              {title}
            </h3>
          )}
        </div>
        <StatusIndicator status={tel.agent_status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 ml-0.5 min-w-0 text-[10px] font-mono">
        {projectInMeta && (
          <span className="flex items-center gap-1 text-slate-400 min-w-0 max-w-full">
            <FolderGit2 size={10} className="shrink-0" />
            {tel.git_remote_url ? (
              <a
                href={tel.git_remote_url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate hover:underline"
              >
                {project}
              </a>
            ) : (
              <span className="truncate">{project}</span>
            )}
          </span>
        )}
        {tel.git_branch && (
          <span className="flex items-center gap-1.5 text-slate-400 min-w-0 max-w-full">
            <GitBranch size={10} className="shrink-0" />
            <span className="truncate">{tel.git_branch}</span>
          </span>
        )}
        {tel.worktree_path && (
          <span
            className="flex items-center gap-1 text-amber-400/70"
            title={t('session.worktreeTitle', { path: tel.worktree_path })}
          >
            <GitFork size={10} /> worktree
          </span>
        )}
        {(tel.run_time_seconds || agent.started_at) && (
          <span
            className="flex items-center gap-1 text-slate-500"
            title={
              tel.run_time_seconds
                ? t('session.activeTime')
                : t('session.elapsed')
            }
          >
            <Clock size={10} />{' '}
            {formatDuration(tel.run_time_seconds, agent.started_at)}
          </span>
        )}
      </div>

      <details className="group/details mt-1">
        <summary className="flex items-center justify-between gap-2 py-2 pointer-fine:py-1 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-[11px] text-slate-400 hover:text-slate-200">
          <span className="flex items-center gap-1">
            <ChevronRight
              size={12}
              className="shrink-0 transition-transform group-open/details:rotate-90"
            />
            {t('session.viewDetails')}
          </span>
          {summaryParts.length > 0 && (
            <span className="text-[10px] font-mono text-slate-500 truncate">
              {summaryParts.join(' · ')}
            </span>
          )}
        </summary>
        <div className="pb-1">
          <div className="bg-slate-900/50 p-2 rounded-lg mb-1.5 border border-slate-700/50">
            <EditableTaskDescription
              agentId={agent.agent_id}
              description={tel.task_description || ''}
            />
            {tel.last_cmd !== undefined || tel.last_exit_code !== undefined ? (
              <>
                {tel.current_activity && (
                  <p className={activityCls}>
                    <FolderOpen size={9} className="inline mr-1" />
                    {tel.current_activity}
                  </p>
                )}
                {tel.last_cmd && (
                  <p className="text-[10px] text-slate-500 font-mono truncate mt-0.5 flex items-center gap-0.5">
                    <ChevronRight size={9} className="shrink-0" />
                    <span className="truncate">{tel.last_cmd}</span>
                    {tel.last_exit_code != null && tel.last_exit_code !== 0 && (
                      <span className="ml-1 px-1 py-px bg-red-500/20 text-red-400 text-[10px] font-bold rounded shrink-0">
                        E{tel.last_exit_code}
                      </span>
                    )}
                  </p>
                )}
              </>
            ) : (
              tel.current_activity && (
                <p className={activityCls}>
                  <Activity size={9} className="inline mr-1 text-slate-500" />
                  {tel.current_activity}
                </p>
              )
            )}
          </div>
          {showModel && (
            <>
              <div className="flex items-center gap-1">
                <p className="text-[11px] text-slate-300 font-mono truncate">
                  {tel.model && tel.model !== 'detecting...'
                    ? tel.model
                    : '...'}
                </p>
                {tel.model && !isModelRecognized(tel.model) && (
                  <span title={t('session.unrecognizedModel')}>
                    <TriangleAlert
                      size={12}
                      className="text-amber-400 shrink-0"
                    />
                  </span>
                )}
              </div>
              <div className="mt-1">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-tight">
                    {t('session.context')}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {ctxTokens ? ctxTokens.toLocaleString(language) : '—'} /{' '}
                    {contextMax >= 1000000
                      ? `${(contextMax / 1000000).toFixed(1).replace('.0', '')}M`
                      : `${(contextMax / 1000).toFixed(0)}k`}
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${getProgressColor(tokenPct)}`}
                    style={{
                      width: `${Math.max(tokenPct, 1)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-between items-center mt-1.5">
                <span
                  className="text-[10px] text-slate-400 font-mono"
                  title={costSource}
                >
                  {formatCost(displayCost)}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  {tel.input_tokens
                    ? t('session.tokensIn', {
                        count: formatTokenCount(tel.input_tokens),
                      })
                    : ''}
                  {tel.input_tokens && tel.output_tokens ? ' / ' : ''}
                  {tel.output_tokens
                    ? t('session.tokensOut', {
                        count: formatTokenCount(tel.output_tokens),
                      })
                    : ''}
                </span>
              </div>
              {!!(tel.cache_read_tokens || tel.cache_creation_tokens) && (
                <p className="text-[10px] text-slate-500 font-mono text-right mt-0.5">
                  {tel.cache_read_tokens
                    ? t('session.cacheRead', {
                        count: formatTokenCount(tel.cache_read_tokens),
                      })
                    : ''}
                  {tel.cache_read_tokens && tel.cache_creation_tokens
                    ? ' / '
                    : ''}
                  {tel.cache_creation_tokens
                    ? t('session.cacheWrite', {
                        count: formatTokenCount(tel.cache_creation_tokens),
                      })
                    : ''}
                </p>
              )}
            </>
          )}
          {mcpServers.length > 0 && (
            <div
              className={`flex items-center gap-1.5 text-[10px] text-slate-400${showModel ? ' mt-1.5' : ''}`}
            >
              <Plug size={10} className="text-slate-500 shrink-0" />
              <span className="truncate">MCP: {mcpServers.join(', ')}</span>
            </div>
          )}
        </div>
      </details>

      <div className="flex gap-2 pt-2 mt-auto">
        <button
          onClick={() => onAttach(agent.agent_id)}
          className="flex-1 bg-accent hover:bg-accent-hover text-accent-text font-bold py-2.5 sm:py-2 rounded-xl transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 text-sm cursor-pointer"
        >
          <Terminal size={16} /> {t('session.attach')}
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onStop(agent.agent_id);
          }}
          className="w-12 sm:w-10 bg-red-600 hover:bg-red-500 text-slate-50 rounded-xl transition-colors flex items-center justify-center shadow-md active:scale-90 cursor-pointer"
          title={t('session.stop')}
          aria-label={t('session.stop')}
        >
          <Square size={14} fill="currentColor" />
        </button>
      </div>
    </div>
  );
};

export default AgentSessionCard;
