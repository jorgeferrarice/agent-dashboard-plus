import type { MessageKey } from '../../i18n';
import type { Agent } from '../../api';

/**
 * Why a session wants the user's attention, most urgent
 * first: it ended, it waits for a permission answer, or it
 * finished working while the user was not looking.
 */
export type Attention = 'ended' | 'permission' | 'done';

/** Message key of the short label of each attention kind. */
export const ATTENTION_LABELS: Record<Attention, MessageKey> = {
  ended: 'attention.ended',
  permission: 'attention.permission',
  done: 'attention.done',
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

/** How long a session waits for the user before the sound plays. */
export const SOUND_DELAY_MS = 60_000;

/** How long each session has needed attention, for the sound. */
export interface SoundClock {
  /** When each session started needing attention (ms). */
  since: Map<string, number>;
  /** Sessions whose sound already played in this wait. */
  played: Set<string>;
}

/**
 * Folds the sessions that need attention now into the clock and
 * says whether the notification sound is due: some session has
 * waited `delay` ms or more and has not sounded during this
 * wait. Each wait sounds once; a session that stops needing
 * attention starts over the next time. Several sessions coming
 * due together make one sound.
 *
 * @param clock Updated in place.
 * @param waiting Sessions that need attention now.
 * @param now The current time (ms).
 */
export function soundDue(
  clock: SoundClock,
  waiting: Iterable<string>,
  now: number,
  delay = SOUND_DELAY_MS,
): boolean {
  const current = new Set(waiting);
  for (const id of [...clock.since.keys()]) {
    if (!current.has(id)) {
      clock.since.delete(id);
      clock.played.delete(id);
    }
  }
  let due = false;
  for (const id of current) {
    const start = clock.since.get(id);
    if (start === undefined) {
      clock.since.set(id, now);
    } else if (now - start >= delay && !clock.played.has(id)) {
      clock.played.add(id);
      due = true;
    }
  }
  return due;
}

/** Tab label for a session: the name the user gave it, else
 *  tool and project. */
export function tabLabel(agent: Agent): string {
  if (agent.telemetry?.session_name) return agent.telemetry.session_name;
  const dir =
    agent.telemetry?.git_project ||
    agent.telemetry?.project_dir?.split('/').filter(Boolean).pop();
  const tool = agent.tool_name || 'agent';
  return dir ? `${tool} · ${dir}` : tool;
}
