import type { Agent } from '../../api';

/**
 * Why a session wants the user's attention, most urgent
 * first: it ended, it waits for a permission answer, or it
 * finished working while the user was not looking.
 */
export type Attention = 'ended' | 'permission' | 'done';

/** Short label for each attention kind. */
export const ATTENTION_LABELS: Record<Attention, string> = {
  ended: 'Session ended',
  permission: 'Waiting for permission',
  done: 'Finished working',
};

/** A status change worth telling the user about. */
export interface AttentionEvent {
  agentId: string;
  kind: Attention;
}

/** Result of folding a new agent list into the tracker. */
export interface AttentionStep {
  /** Last seen `agent_status` per agent. */
  statuses: Record<string, string | undefined>;
  /** Agents that finished working unseen. */
  done: Set<string>;
  /** Transitions that happened in this step. */
  events: AttentionEvent[];
}

/**
 * Folds the latest agent list into the attention tracker.
 *
 * "Finished working" is the one state the telemetry does not
 * carry: it is the transition from `working` to `idle`, and
 * it only counts when the user is not watching that session.
 * It clears when the agent starts working again. Everything
 * here is computed from telemetry the dashboard already
 * receives, so tracking attention needs no terminal stream.
 *
 * @param statuses Last seen status per agent (previous step).
 * @param done Agents flagged as finished (previous step).
 * @param agents Current active agents.
 * @param watchingId Agent the user is looking at right now,
 *   or null when none is on screen or the page is unfocused.
 */
export function stepAttention(
  statuses: Record<string, string | undefined>,
  done: ReadonlySet<string>,
  agents: Agent[],
  watchingId: string | null,
): AttentionStep {
  const nextStatuses: Record<string, string | undefined> = {};
  const nextDone = new Set<string>();
  const events: AttentionEvent[] = [];
  for (const agent of agents) {
    const id = agent.agent_id;
    const cur = agent.telemetry?.agent_status;
    const prev = statuses[id];
    nextStatuses[id] = cur;
    if (prev === 'working' && cur === 'idle' && id !== watchingId) {
      nextDone.add(id);
      events.push({ agentId: id, kind: 'done' });
    } else if (done.has(id) && cur !== 'working') {
      nextDone.add(id);
    }
    if (cur === 'waiting_permission' && prev !== 'waiting_permission') {
      events.push({ agentId: id, kind: 'permission' });
    }
  }
  return { statuses: nextStatuses, done: nextDone, events };
}

/**
 * Attention state of one session, or null when it needs none.
 *
 * @param agent The agent, or undefined once it is gone.
 * @param done Agents flagged as finished working.
 * @param ended Whether the session ended and was not seen yet.
 */
export function attentionOf(
  agent: Agent | undefined,
  done: ReadonlySet<string>,
  ended: boolean,
): Attention | null {
  if (ended) return 'ended';
  if (!agent) return null;
  if (agent.telemetry?.agent_status === 'waiting_permission') {
    return 'permission';
  }
  return done.has(agent.agent_id) ? 'done' : null;
}

/** Tab label for a session: tool and project. */
export function tabLabel(agent: Agent): string {
  const dir =
    agent.telemetry?.git_project ||
    agent.telemetry?.project_dir?.split('/').filter(Boolean).pop();
  const tool = agent.tool_name || 'agent';
  return dir ? `${tool} · ${dir}` : tool;
}
