import axios from 'axios';

const baseURL =
  import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`;

const api = axios.create({
  baseURL,
  withCredentials: true, // Required for session cookies from OIDC
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
}

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
  };
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
  };
}

export const getHosts = async (): Promise<Host[]> => {
  const response = await api.get('/hosts');
  return response.data;
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
