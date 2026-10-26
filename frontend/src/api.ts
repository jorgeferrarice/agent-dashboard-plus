import axios from 'axios';

const baseURL =
  import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`;

const api = axios.create({
  baseURL,
  withCredentials: true, // Required for session cookies from OIDC
});

// The API only answers with JSON. An HTML answer is the
// frontend's index.html fallback: the route is not proxied to the
// backend (see frontend/nginx.conf). Fail with that, instead of
// handing a page of HTML to code that expects data.
api.interceptors.response.use((response) => {
  const type = String(response.headers?.['content-type'] ?? '');
  if (type.includes('text/html')) {
    throw new Error(
      `${response.config.url} returned HTML instead of JSON: is it proxied to the backend (frontend/nginx.conf)?`,
    );
  }
  return response;
});

/** Tool metadata reported by the daemon from profiles. */
export interface ToolInfo {
  name: string;
  display_name: string;
  color?: string;
  supports_resume?: boolean;
  has_model?: boolean;
  /** Model names the user may pick for a session. Present
   *  only for tools whose profile defines a model picker. */
  models?: string[];
  /** Model used when the user picks none. */
  default_model?: string;
  /** Why the live model list could not be fetched. */
  models_error?: string;
  /** False when the tool is installed but the daemon found no
   *  login for it. Missing on older daemons. */
  authenticated?: boolean;
  /** Whether the tool has plan limits at all (bash has none).
   *  They may still be unreadable: see Host.projects.usage. */
  has_limits?: boolean;
  /** Default command lines from the tool's profile, quoted as
   *  in a shell. Missing on older daemons. */
  commands?: { new: string; resume: string };
}

/** One plan limit of a tool, e.g. the five hour window. */
export interface UsageWindow {
  /** As the tool names it: "Current session", "Weekly", ... */
  label: string;
  /** 0 to 100. */
  used_percent: number;
  /** When it resets, in the tool's own words; may be empty. */
  resets: string;
}

/** A tool's plan limits, as last read by the host daemon. */
export interface ToolUsage {
  windows: UsageWindow[];
  /** Epoch seconds of the last successful reading. */
  updated_at?: number;
  /** False when the latest reading failed: `windows` is then
   *  the last good one, and may be old. */
  ok?: boolean;
}

/** What the user chose for one AI tool on one host. Only tools
 *  the user changed have one; the rest are enabled and keep
 *  their default name. */
export interface ToolSetting {
  /** Profile name the daemon reports for the tool. */
  tool: string;
  enabled: boolean;
  /** Name shown on the spawn button; null for the default. */
  label: string | null;
  /** Command line for new sessions; null for the profile's. */
  command_new?: string | null;
  /** Command line for resumed sessions; null for the profile's. */
  command_resume?: string | null;
}

/** Changes to a tool's settings. Fields left out keep their
 *  value; a blank string restores the default. */
export type ToolSettingChange = {
  enabled?: boolean;
  label?: string;
  command_new?: string;
  command_resume?: string;
};

/**
 * Normalizes a tool entry from available_tools into a
 * ToolInfo object. Handles both enriched dicts (new
 * daemons) and bare name strings (older daemons).
 */
export function normalizeToolInfo(tool: string | ToolInfo): ToolInfo {
  if (typeof tool === 'string') {
    return {
      name: tool,
      display_name: tool.charAt(0).toUpperCase() + tool.slice(1),
    };
  }
  return tool;
}

export interface Host {
  id: number;
  name: string;
  status: string;
  created_at: string;
  projects?: {
    projects_root: string | string[];
    available_projects: string[];
    /** Subset of available_projects that are plain folders,
     *  not git repositories. */
    non_git_projects?: string[];
    /** Directory where folders created from the UI land. */
    new_projects_dir?: string;
    available_tools?: (string | ToolInfo)[];
    /** Plan limits by tool name. A tool with limits and no
     *  entry here has not been read, or cannot be. */
    usage?: Record<string, ToolUsage>;
  };
  tool_settings?: ToolSetting[];
}

export interface Agent {
  id: number;
  agent_id: string;
  host_id: number;
  status: string;
  tool_name?: string;
  pid?: number;
  started_at: string;
  ended_at?: string;
  telemetry?: {
    project_dir?: string;
    task_description?: string;
    /** Name the user gave the session; shown on its tab. */
    session_name?: string;
    git_branch?: string;
    git_project?: string;
    git_remote_url?: string;
    model?: string;
    tokens?: number;
    context_tokens?: number;
    current_activity?: string;
    run_time_seconds?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cost_usd?: number;
    agent_status?: string;
    mcp_servers?: string[];
    last_exit_code?: number;
    last_cmd?: string;
    worktree_path?: string;
    /** Set when the session has a chat view: the transcript
     *  format the host daemon reads (e.g. "claude"). */
    chat?: string;
  };
}

export const getHosts = async (): Promise<Host[]> => {
  const response = await api.get('/hosts');
  return response.data;
};

/**
 * Enables, disables, renames or sets the command lines of an AI
 * tool on a host. Fields left out keep their value; a blank
 * one restores the default. Resolves to all the host's tool settings.
 */
export const updateToolSetting = async (
  hostId: number,
  tool: string,
  change: ToolSettingChange,
): Promise<ToolSetting[]> => {
  const response = await api.put(
    `/hosts/${hostId}/tools/${encodeURIComponent(tool)}/settings`,
    change,
  );
  return response.data;
};

/** Restarts a host's daemon. Ends every session on the host. */
export const restartHost = async (id: number): Promise<void> => {
  await api.post(`/hosts/${id}/restart`);
};

export const deleteHost = async (id: number): Promise<void> => {
  await api.delete(`/hosts/${id}`);
};

export const getAgents = async (): Promise<Agent[]> => {
  const response = await api.get('/agents', { params: { status: 'active' } });
  return response.data;
};

export const spawnAgent = async (
  hostId: number,
  toolName: string,
  projectDir?: string,
  taskDescription?: string,
  sessionMode?: string,
  useWorktree?: boolean,
  cols?: number,
  rows?: number,
  model?: string,
  sessionName?: string,
): Promise<Agent> => {
  const response = await api.post('/agents/spawn', {
    host_id: hostId,
    tool_name: toolName,
    project_dir: projectDir,
    task_description: taskDescription,
    session_mode: sessionMode || 'resume',
    use_worktree: useWorktree || false,
    cols: cols || 120,
    rows: rows || 40,
    model,
    session_name: sessionName || undefined,
  });
  return response.data;
};

/**
 * Creates an empty project folder on a host and returns its
 * absolute path. Rejects with the daemon's reason (invalid
 * name, folder already exists) in `response.data.detail`.
 */
export const createProject = async (
  hostId: number,
  name: string,
  gitInit: boolean,
): Promise<string> => {
  const response = await api.post(`/hosts/${hostId}/projects`, {
    name,
    git_init: gitInit,
  });
  return response.data.path;
};

export const stopAgent = async (agentId: string): Promise<void> => {
  await api.post(`/agents/${agentId}/stop`);
};

export const updateTaskDescription = async (
  agentId: string,
  taskDescription: string,
): Promise<void> => {
  await api.patch(`/agents/${agentId}/task-description`, {
    task_description: taskDescription,
  });
};

/**
 * Reads the session tabs the logged-in user has open, in order.
 * Resolves to null when the user has never saved any.
 */
export const getOpenTabs = async (): Promise<string[] | null> => {
  const response = await api.get('/me/tabs');
  return response.data.tabs ?? null;
};

/** Saves the logged-in user's open session tabs, in order. */
export const saveOpenTabs = async (agentIds: string[]): Promise<void> => {
  await api.put('/me/tabs', { tabs: agentIds });
};

/** Renames a session's tab. A blank name restores the
 *  default tool and project label. */
export const renameSession = async (
  agentId: string,
  sessionName: string,
): Promise<void> => {
  await api.patch(`/agents/${agentId}/session-name`, {
    session_name: sessionName,
  });
};

/**
 * Sends a file to the host a session runs on and resolves to
 * its absolute path there. Rejects with the reason (too large,
 * host offline) in `response.data.detail`.
 */
export const uploadFile = async (
  agentId: string,
  file: File,
): Promise<string> => {
  const form = new FormData();
  form.append('file', file);
  const response = await api.post(`/agents/${agentId}/files`, form);
  return response.data.path;
};

/**
 * Address of an image or video of a session, for `<img>` and
 * `<video>`: an image of the agent's transcript ("t:...") or a
 * file path on the session's host (relative to its folder).
 */
export const mediaUrl = (agentId: string, src: string): string =>
  `${baseURL}/agents/${encodeURIComponent(agentId)}/media?src=${encodeURIComponent(src)}`;

export interface AgentDetail extends Agent {
  host_name: string;
  available_tools?: (string | ToolInfo)[];
}

export const getAgentDetails = async (
  agentId: string,
): Promise<AgentDetail> => {
  const response = await api.get(`/agents/${agentId}/details`);
  return response.data;
};

export const getCompanions = async (agentId: string): Promise<Agent[]> => {
  const response = await api.get(`/agents/${agentId}/companions`);
  return response.data;
};

export const getMe = async () => {
  const response = await api.get('/me');
  return response.data;
};

export interface VersionInfo {
  current: string;
  is_dev: boolean;
  latest: string | null;
  latest_url: string | null;
  update_available: boolean;
}

export const getVersion = async (): Promise<VersionInfo> => {
  const response = await api.get('/version');
  return response.data;
};

export default api;

/** Live model list of a tool, as reported by its host. */
export interface ToolModels {
  models: string[];
  default_model?: string | null;
  /** Why the live list is incomplete, if it is. */
  error?: string | null;
}

/**
 * Fetches the models a tool offers right now. The host asks
 * the tool's model endpoint on every call.
 */
export const getToolModels = async (
  hostId: number,
  toolName: string,
): Promise<ToolModels> => {
  const response = await api.get(
    `/hosts/${hostId}/tools/${encodeURIComponent(toolName)}/models`,
  );
  return response.data;
};

/** Preferences that follow the user across devices. */
export interface Preferences {
  /** "pt-BR" or "en"; null until the user picks one. */
  language: string | null;
}

export const getPreferences = async (): Promise<Preferences> =>
  (await api.get('/me/preferences')).data;

export const savePreferences = async (
  prefs: Preferences,
): Promise<Preferences> => (await api.put('/me/preferences', prefs)).data;
