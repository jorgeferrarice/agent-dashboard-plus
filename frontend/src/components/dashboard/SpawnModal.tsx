import React, { useEffect, useMemo, useState } from 'react';
import {
  PlusCircle,
  X,
  RefreshCw,
  Folder,
  FolderPlus,
  GitFork,
  Search,
} from 'lucide-react';
import type { Agent, Host, ToolModels } from '../../api';

const RECENT_MODELS_KEY = 'agentDashboard.recentModels';
const RECENT_MODELS_MAX = 5;

/** Reads the models last spawned with `tool`, newest first. */
function loadRecentModels(tool: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || '{}')?.[
      tool
    ];
    return Array.isArray(list)
      ? list.filter((m: unknown) => typeof m === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Moves `model` to the front of the tool's recent list. */
function saveRecentModel(tool: string, model: string) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || '{}');
    all[tool] = [
      model,
      ...loadRecentModels(tool).filter((m) => m !== model),
    ].slice(0, RECENT_MODELS_MAX);
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (e.g. incognito).
  }
}

/** Props for the SpawnModal component. */
export interface SpawnModalProps {
  host: Host;
  tool: string;
  /** Human-readable tool name from the profile. */
  displayName?: string;
  /** Whether the tool supports resuming sessions. */
  supportsResume?: boolean;
  /** Active agents on this host, used to compute the
   *  smart default for the worktree isolation toggle. */
  activeAgents?: Agent[];
  /** Model names the user may pick. When set, the modal
   *  shows a model selector. */
  models?: string[];
  /** Model preselected in the selector. */
  defaultModel?: string;
  /** Why the live model list could not be fetched. */
  modelsError?: string;
  /** Fetches the tool's current model list from the host.
   *  Called once when the modal opens; `models` is shown
   *  until it answers. */
  onLoadModels?: () => Promise<ToolModels>;
  onClose: () => void;
  onSpawn: (
    dir: string,
    task: string,
    sessionMode: string,
    useWorktree: boolean,
    model?: string,
    sessionName?: string,
  ) => void;
  /** Creates an empty project folder on the host and
   *  resolves to its absolute path. */
  onCreateProject: (name: string, gitInit: boolean) => Promise<string>;
  onRefresh: () => void;
}

/**
 * Modal dialog for spawning a new agent session on a host.
 * Allows selecting a project directory, entering a task
 * description, choosing resume vs. new session mode, and
 * optionally isolating the session in a git worktree. The
 * session can also start in a new empty folder, and tools
 * with a model picker let the user choose the model.
 */
const SpawnModal: React.FC<SpawnModalProps> = ({
  host,
  tool,
  displayName,
  supportsResume: supportsResumeProp,
  activeAgents = [],
  models: initialModels,
  defaultModel,
  modelsError: initialModelsError,
  onLoadModels,
  onClose,
  onSpawn,
  onCreateProject,
  onRefresh,
}) => {
  // The host has not reported yet until `projects` exists;
  // after that an empty list means the scan found nothing.
  const projectsLoaded = host.projects != null;
  const projects = useMemo(
    () => host.projects?.available_projects || [],
    [host.projects?.available_projects],
  );

  // Compute display labels by stripping the common prefix
  // from absolute paths for readability.
  const projectsRoot = host.projects?.projects_root;
  const roots = useMemo(
    () =>
      Array.isArray(projectsRoot)
        ? projectsRoot
        : projectsRoot
          ? [projectsRoot]
          : ['/git'],
    [projectsRoot],
  );
  const stripPrefix = useMemo(() => {
    if (roots.length === 1) return roots[0] + '/';
    return '';
  }, [roots]);
  const displayLabel = (p: string) =>
    stripPrefix && p.startsWith(stripPrefix) ? p.slice(stripPrefix.length) : p;

  const [selectedProject, setSelectedProject] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [task, setTask] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [resumeSession, setResumeSession] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [newName, setNewName] = useState('');
  const [gitInit, setGitInit] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  // Model choices start from what the host reported at its
  // last scan and are replaced by a live fetch on open.
  const [models, setModels] = useState(initialModels);
  const [modelsError, setModelsError] = useState(initialModelsError);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState(defaultModel || initialModels?.[0] || '');
  const hasModelPicker = initialModels != null;

  useEffect(() => {
    if (!hasModelPicker || !onLoadModels) return;
    let cancelled = false;
    setModelsLoading(true);
    onLoadModels()
      .then((live) => {
        if (cancelled) return;
        setModels(live.models);
        setModelsError(live.error || undefined);
      })
      .catch(() => {
        if (!cancelled) setModelsError('Could not refresh the model list.');
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per modal open
  }, []);

  // Filter models by search query (case-insensitive
  // substring match), like the project list.
  const [modelSearch, setModelSearch] = useState('');
  const filteredModels = useMemo(() => {
    const all = models || [];
    const q = modelSearch.trim().toLowerCase();
    return q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  }, [models, modelSearch]);
  // Quick picks: recent models the host still offers.
  const [recentModels] = useState(() => loadRecentModels(tool));
  const recentShown = useMemo(
    () => recentModels.filter((m) => (models || []).includes(m)),
    [recentModels, models],
  );
  const showResume = supportsResumeProp ?? false;

  // A typed folder name takes over from the list selection:
  // the session starts in a new folder.
  const creatingNew = newName.trim() !== '';
  const nonGit = useMemo(
    () => new Set(host.projects?.non_git_projects || []),
    [host.projects?.non_git_projects],
  );
  // Worktrees need a git repository with at least one
  // commit, so they are unavailable for plain folders and
  // for folders created here.
  const canWorktree = !creatingNew && !nonGit.has(selectedProject);
  const newProjectsDir = host.projects?.new_projects_dir;

  // Filter projects by search query (case-insensitive
  // substring match against the full path).
  const filteredProjects = useMemo(() => {
    if (!projectSearch) return projects;
    const q = projectSearch.toLowerCase();
    return projects.filter((p) => p.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  // Auto-select first project when list arrives
  useEffect(() => {
    if (projects.length > 0 && !selectedProject) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize from async data
      setSelectedProject(projects[0]);
    }
  }, [projects, selectedProject]);

  // Smart default: enable worktree isolation when another
  // agent is already active on the selected project.
  // Only runs when the project selection changes — not
  // on activeAgents updates — so it doesn't override
  // user manual toggles.
  useEffect(() => {
    if (!selectedProject) return;
    const fullPath = selectedProject.startsWith('/')
      ? selectedProject
      : `${roots[0]}/${selectedProject}`;
    const hasActiveAgent = activeAgents.some(
      (a) =>
        a.telemetry?.project_dir === selectedProject ||
        a.telemetry?.project_dir === fullPath,
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derive from props
    setUseWorktree(hasActiveAgent);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit activeAgents to avoid overriding user toggles
  }, [selectedProject, roots]);

  // When worktree is enabled, force session mode to "new"
  // since the worktree has no prior session state. A new
  // folder has no prior session either.
  const effectiveWorktree = canWorktree && useWorktree;
  const effectiveResume =
    effectiveWorktree || creatingNew ? false : resumeSession;
  const sessionModeLocked = effectiveWorktree || creatingNew;

  // Starts the session, creating the folder first when the
  // user typed a new folder name.
  const handleInitialize = async () => {
    let dir = selectedProject;
    if (creatingNew) {
      setCreating(true);
      setCreateError('');
      try {
        dir = await onCreateProject(newName.trim(), gitInit);
      } catch (err) {
        const detail = (err as { response?: { data?: { detail?: unknown } } })
          ?.response?.data?.detail;
        setCreateError(
          typeof detail === 'string' ? detail : 'Could not create the folder.',
        );
        setCreating(false);
        return;
      }
      setCreating(false);
    }
    if (models && model) saveRecentModel(tool, model);
    onSpawn(
      dir,
      task,
      effectiveResume ? 'resume' : 'new',
      effectiveWorktree,
      models ? model : undefined,
      sessionName.trim() || undefined,
    );
  };
  const canInitialize = (creatingNew || !!selectedProject) && !creating;

  return (
    <div className="app-root fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center sm:p-4">
      {/* Full screen on phones, a centered dialog elsewhere. */}
      <div className="bg-slate-800 sm:border border-slate-700 sm:rounded-2xl w-full h-full sm:h-auto sm:max-w-md shadow-2xl overflow-hidden flex flex-col">
        <div className="flex justify-between items-center px-4 py-3 sm:p-6 border-b border-slate-700 bg-slate-800/50 shrink-0">
          <h3 className="text-lg sm:text-xl font-bold text-slate-50 flex items-center gap-2 min-w-0 truncate">
            <PlusCircle size={24} className="text-accent" />
            Spawn {displayName || tool.toUpperCase()}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-50 transition-colors p-2 -m-2"
          >
            <X size={24} />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-5 sm:space-y-6 flex-1 min-h-0 sm:flex-none sm:max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">
              Host
            </label>
            <p className="text-slate-50 font-medium bg-slate-900/50 p-3 rounded-lg border border-slate-700">
              {host.name}
            </p>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs font-bold uppercase tracking-widest text-accent">
                Select Project
              </label>
              <button
                onClick={onRefresh}
                className="-my-2 py-2 text-[10px] text-accent font-bold uppercase tracking-tighter transition-colors flex items-center gap-1 cursor-pointer hover:text-accent-hover hover:underline"
              >
                <RefreshCw size={10} className="animate-spin-slow" /> Force
                Refresh
              </button>
            </div>
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                size={14}
              />
              <input
                // A phone keyboard would cover the list.
                autoFocus={!window.matchMedia?.('(pointer: coarse)').matches}
                type="text"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="Search projects..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm text-slate-50 focus:outline-none focus:border-accent transition-colors"
              />
            </div>
            <div className="mt-1.5 max-h-48 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg">
              {!projectsLoaded ? (
                <p className="text-sm text-slate-500 px-3 py-2 italic">
                  Loading projects from {roots.join(', ')}...
                </p>
              ) : projects.length === 0 ? (
                <p className="text-sm text-slate-500 px-3 py-2 italic">
                  No projects found in {roots.join(', ')}
                </p>
              ) : filteredProjects.length === 0 ? (
                <p className="text-sm text-slate-500 px-3 py-2 italic">
                  No projects match &ldquo;{projectSearch}&rdquo;
                </p>
              ) : (
                filteredProjects.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSelectedProject(p)}
                    className={`w-full text-left px-3 py-2.5 sm:py-1.5 text-sm font-mono flex items-center gap-2 transition-colors ${
                      selectedProject === p && !creatingNew
                        ? 'bg-accent/20 text-accent'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Folder size={12} className="shrink-0" />
                    {displayLabel(p)}
                  </button>
                ))
              )}
            </div>
            <p className="text-[10px] text-slate-500 mt-1 italic">
              {roots.length === 1 ? (
                <>
                  Projects from{' '}
                  <code className="bg-slate-900 px-1 rounded">{roots[0]}</code>
                </>
              ) : (
                <>Projects from {roots.length} directories</>
              )}
            </p>
          </div>

          <div>
            <label
              htmlFor="new-folder-name"
              className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5"
            >
              <FolderPlus size={12} />
              Or Start in a New Folder
            </label>
            <input
              id="new-folder-name"
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setCreateError('');
              }}
              placeholder="new-folder-name"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-4 text-sm font-mono text-slate-50 focus:outline-none focus:border-accent transition-colors"
            />
            <label className="mt-1 py-1 flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={gitInit}
                onChange={(e) => setGitInit(e.target.checked)}
                disabled={!creatingNew}
              />
              Run git init in the new folder
            </label>
            {createError ? (
              <p role="alert" className="text-xs text-red-400 mt-1">
                {createError}
              </p>
            ) : (
              creatingNew && (
                <p className="text-[10px] text-slate-500 mt-1 italic">
                  Creates{' '}
                  <code className="bg-slate-900 px-1 rounded">
                    {newProjectsDir ? `${newProjectsDir}/` : ''}
                    {newName.trim()}
                  </code>{' '}
                  and starts the session there
                </p>
              )
            )}
          </div>

          {models && (
            <div>
              <label
                htmlFor="session-model"
                className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2"
              >
                Model
              </label>
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                  size={14}
                />
                <input
                  id="session-model"
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search models..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm text-slate-50 focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              <div
                role="listbox"
                aria-label="Models"
                className="mt-1.5 max-h-40 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg"
              >
                {filteredModels.length === 0 ? (
                  <p className="text-sm text-slate-500 px-3 py-2 italic">
                    No models match &ldquo;{modelSearch}&rdquo;
                  </p>
                ) : (
                  filteredModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={model === m}
                      onClick={() => setModel(m)}
                      className={`w-full text-left px-3 py-2.5 sm:py-1.5 text-sm font-mono break-all transition-colors ${
                        model === m
                          ? 'bg-accent/20 text-accent'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {m}
                    </button>
                  ))
                )}
              </div>
              {recentShown.length > 0 && (
                <div
                  role="group"
                  aria-label="Recent models"
                  className="mt-1.5 flex flex-wrap gap-1.5"
                >
                  {recentShown.map((m) => (
                    <button
                      key={m}
                      type="button"
                      title={m}
                      aria-pressed={model === m}
                      onClick={() => setModel(m)}
                      className={`max-w-full truncate px-2 py-0.5 text-xs font-mono rounded-md border transition-colors ${
                        model === m
                          ? 'bg-accent/20 text-accent border-accent/40'
                          : 'text-slate-300 border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-slate-500 mt-1 italic">
                {modelsLoading ? (
                  'Refreshing model list...'
                ) : (
                  <>
                    Selected:{' '}
                    <code className="bg-slate-900 px-1 rounded">{model}</code>{' '}
                    &middot; {filteredModels.length} of {models.length} shown
                  </>
                )}
              </p>
              {modelsError && (
                <p role="alert" className="text-xs text-amber-400 mt-1">
                  {modelsError} The list may be incomplete.
                </p>
              )}
            </div>
          )}

          {showResume && (
            <div
              className={`flex items-center gap-3 ${sessionModeLocked ? 'opacity-50' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Session Mode
                </label>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {creatingNew
                    ? 'New session (the folder is new)'
                    : effectiveWorktree
                      ? 'New session (required for worktree isolation)'
                      : effectiveResume
                        ? 'Continue the most recent session in this project'
                        : 'Start a fresh session'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResumeSession(!resumeSession)}
                disabled={sessionModeLocked}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors after:absolute after:-inset-2 after:content-[''] ${
                  effectiveResume ? 'bg-accent' : 'bg-slate-600'
                } ${sessionModeLocked ? 'cursor-not-allowed' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    effectiveResume ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
              <span className="text-xs text-slate-300 font-medium w-16 shrink-0">
                {effectiveResume ? 'Resume' : 'New'}
              </span>
            </div>
          )}

          <div
            className={`flex items-center gap-3 ${canWorktree ? '' : 'opacity-50'}`}
          >
            <div className="flex-1 min-w-0">
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                <GitFork size={12} />
                Worktree Isolation
              </label>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {!canWorktree
                  ? 'Not a git repository: agent works directly in the folder'
                  : effectiveWorktree
                    ? 'Create a separate working copy for this agent'
                    : 'Agent works directly in the project directory'}
              </p>
            </div>
            <button
              type="button"
              aria-label="Worktree isolation"
              onClick={() => setUseWorktree(!useWorktree)}
              disabled={!canWorktree}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors after:absolute after:-inset-2 after:content-[''] ${
                effectiveWorktree ? 'bg-accent' : 'bg-slate-600'
              } ${canWorktree ? '' : 'cursor-not-allowed'}`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  effectiveWorktree ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-xs text-slate-300 font-medium w-16 shrink-0">
              {effectiveWorktree ? 'Isolated' : 'Shared'}
            </span>
          </div>

          <div>
            <label
              htmlFor="session-name"
              className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2"
            >
              Session Name (Optional)
            </label>
            <input
              id="session-name"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              maxLength={60}
              autoComplete="off"
              placeholder="Shown on the tab instead of tool · project"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-4 text-sm text-slate-50 focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">
              Task Description (Optional)
            </label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2.5 px-4 text-slate-50 focus:outline-none focus:border-accent transition-colors min-h-[100px] resize-none"
              placeholder="Describe the objective for this session..."
            />
          </div>
        </div>

        <div className="p-4 sm:p-6 bg-slate-900/50 border-t border-slate-700 flex gap-3 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl font-bold text-slate-400 hover:text-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleInitialize}
            disabled={!canInitialize}
            className={`flex-1 font-bold py-2.5 rounded-xl transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2 ${
              canInitialize
                ? 'bg-accent hover:bg-accent-hover text-accent-text'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed border border-slate-600'
            }`}
          >
            Initialize Agent
          </button>
        </div>
      </div>
    </div>
  );
};

export default SpawnModal;
