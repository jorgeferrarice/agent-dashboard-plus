import { describe, it, expect } from 'vitest';
import { attentionOf, stepAttention, tabLabel } from '../attention';
import type { Agent } from '../../../api';

const agent = (id: string, status?: string, extra = {}): Agent => ({
  id: 1,
  agent_id: id,
  host_id: 1,
  status: 'active',
  tool_name: 'claude',
  started_at: '',
  telemetry: { agent_status: status, ...extra },
});

describe('stepAttention', () => {
  it('flags an agent that goes from working to idle unwatched', () => {
    const first = stepAttention({}, new Set(), [agent('a', 'working')], null);
    expect(first.done.size).toBe(0);
    const second = stepAttention(
      first.statuses,
      first.done,
      [agent('a', 'idle')],
      null,
    );
    expect([...second.done]).toEqual(['a']);
    expect(second.events).toEqual([{ agentId: 'a', kind: 'done' }]);
  });

  it('does not flag the session the user is watching', () => {
    const step = stepAttention(
      { a: 'working' },
      new Set(),
      [agent('a', 'idle')],
      'a',
    );
    expect(step.done.size).toBe(0);
    expect(step.events).toEqual([]);
  });

  it('does not flag an agent first seen idle', () => {
    const step = stepAttention({}, new Set(), [agent('a', 'idle')], null);
    expect(step.done.size).toBe(0);
  });

  it('keeps the flag while idle and clears it when work resumes', () => {
    const kept = stepAttention(
      { a: 'idle' },
      new Set(['a']),
      [agent('a', 'idle')],
      null,
    );
    expect(kept.done.has('a')).toBe(true);
    expect(kept.events).toEqual([]);
    const cleared = stepAttention(
      kept.statuses,
      kept.done,
      [agent('a', 'working')],
      null,
    );
    expect(cleared.done.size).toBe(0);
  });

  it('reports permission once, on entering the state', () => {
    const entered = stepAttention(
      { a: 'working' },
      new Set(),
      [agent('a', 'waiting_permission')],
      null,
    );
    expect(entered.events).toEqual([{ agentId: 'a', kind: 'permission' }]);
    const still = stepAttention(
      entered.statuses,
      entered.done,
      [agent('a', 'waiting_permission')],
      null,
    );
    expect(still.events).toEqual([]);
  });

  it('forgets agents that left the list', () => {
    const step = stepAttention({ a: 'idle' }, new Set(['a']), [], null);
    expect(step.done.size).toBe(0);
    expect(step.statuses).toEqual({});
  });
});

describe('attentionOf', () => {
  it('ranks ended over permission over done', () => {
    const waiting = agent('a', 'waiting_permission');
    expect(attentionOf(waiting, new Set(['a']), true)).toBe('ended');
    expect(attentionOf(waiting, new Set(['a']), false)).toBe('permission');
    expect(attentionOf(agent('a', 'idle'), new Set(['a']), false)).toBe('done');
    expect(attentionOf(agent('a', 'idle'), new Set(), false)).toBeNull();
    expect(attentionOf(undefined, new Set(), false)).toBeNull();
  });
});

describe('tabLabel', () => {
  it('uses the tool and the project name', () => {
    expect(tabLabel(agent('a', 'idle', { git_project: 'vibn' }))).toBe(
      'claude · vibn',
    );
    expect(
      tabLabel(agent('a', 'idle', { project_dir: '/Users/u/git/notes/' })),
    ).toBe('claude · notes');
    expect(tabLabel(agent('a', 'idle'))).toBe('claude');
  });

  it('prefers the name the user gave the session', () => {
    expect(
      tabLabel(
        agent('a', 'idle', { git_project: 'vibn', session_name: 'login fix' }),
      ),
    ).toBe('login fix');
  });
});
