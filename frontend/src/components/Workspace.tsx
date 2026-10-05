import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Bell, BellOff, LayoutDashboard, X } from 'lucide-react';
import type { Agent } from '../api';
import { getSocket } from '../socket';
import Dashboard from './Dashboard';
import Terminal from './Terminal';
import { openTerminalWindow } from './terminalWindow';
import {
  ATTENTION_LABELS,
  attentionOf,
  stepAttention,
  tabLabel,
} from './tabs/attention';
import type { Attention, AttentionEvent } from './tabs/attention';

/** ID of the fixed first tab. */
const DASHBOARD = 'dashboard';
const STORAGE_KEY = 'agentDashboard.tabs';
const BASE_TITLE = 'Agent Dashboard';

/** An open session tab. The label is kept with the tab so it
 *  survives the agent leaving the active list. */
interface SessionTab {
  id: string;
  label: string;
}

interface StoredTabs {
  tabs: SessionTab[];
  active: string;
}

/** Reads the tabs saved by a previous page load. */
function loadStoredTabs(): StoredTabs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.filter(
        (t: SessionTab) =>
          typeof t?.id === 'string' && typeof t?.label === 'string',
      );
      const active = tabs.some((t: SessionTab) => t.id === raw.active)
        ? raw.active
        : DASHBOARD;
      return { tabs, active };
    }
  } catch {
    // Unreadable storage: start with the dashboard only.
  }
  return { tabs: [], active: DASHBOARD };
}

const ATTENTION_DOT: Record<Attention, string> = {
  permission: 'bg-red-500 animate-pulse',
  done: 'bg-sky-400',
  ended: 'bg-amber-400',
};

/** Whether the user is looking at this page right now. */
const pageInFocus = () => !document.hidden && document.hasFocus();

const notificationsSupported = () => typeof Notification !== 'undefined';

/**
 * The tabbed workspace: a fixed Dashboard tab plus one tab
 * per opened session, all in one window.
 *
 * Only the active session tab has a terminal and receives
 * output. Every other tab is a label with an attention mark
 * computed from the telemetry the dashboard already receives,
 * so the cost in the browser and on the wire does not grow
 * with the number of open tabs. The whole page uses a single
 * Socket.IO connection.
 */
const Workspace: React.FC = () => {
  const socket = useMemo(() => getSocket(), []);
  const [stored] = useState(loadStoredTabs);
  const [tabs, setTabs] = useState<SessionTab[]>(stored.tabs);
  const [active, setActive] = useState<string>(stored.active);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  // Agents that finished working while unwatched.
  const [done, setDone] = useState<Set<string>>(new Set());
  // Tabs whose session ended, and which of those were seen.
  const [ended, setEnded] = useState<Set<string>>(new Set());
  const [endedSeen, setEndedSeen] = useState<Set<string>>(new Set());
  const [notifyPermission, setNotifyPermission] = useState<string>(
    notificationsSupported() ? Notification.permission : 'unsupported',
  );

  const statusesRef = useRef<Record<string, string | undefined>>({});
  // Agents that have appeared in the active list. A tab is
  // dropped once its agent was known and is gone; a tab
  // opened for a just-spawned agent is kept until the list
  // catches up. Restored tabs count as known.
  const knownRef = useRef<Set<string>>(new Set(stored.tabs.map((t) => t.id)));
  // Latest values for event handlers that must not be
  // re-created (and re-subscribed) on every change.
  const tabsRef = useRef(tabs);
  const activeRef = useRef(active);
  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = active;
  }, [tabs, active]);

  const activate = useCallback((id: string) => {
    setActive(id);
    // Looking at a session acknowledges what it reported.
    setDone((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEndedSeen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const openTab = useCallback(
    (id: string) => {
      setTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, label: 'session' }],
      );
      activate(id);
    },
    [activate],
  );

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((t) => t.id === id);
    if (index === -1) return;
    setTabs(current.filter((t) => t.id !== id));
    if (activeRef.current === id) {
      // Fall back to the neighbour on the left.
      setActive(index > 0 ? current[index - 1].id : DASHBOARD);
    }
    setEnded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /** Swaps a tab's session for its resumed replacement. */
  const replaceTab = useCallback(
    (oldId: string, newId: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === oldId ? { ...t, id: newId } : t)),
      );
      setEnded((prev) => {
        const next = new Set(prev);
        next.delete(oldId);
        return next;
      });
      activate(newId);
    },
    [activate],
  );

  const detachTab = useCallback(
    (id: string) => {
      // One viewer per session: two would fight over the
      // terminal size.
      closeTab(id);
      openTerminalWindow(id);
    },
    [closeTab],
  );

  const notify = useCallback(
    (events: AttentionEvent[]) => {
      if (!notificationsSupported() || Notification.permission !== 'granted') {
        return;
      }
      if (pageInFocus()) return;
      for (const event of events) {
        const label =
          tabsRef.current.find((t) => t.id === event.agentId)?.label ||
          'Session';
        const notification = new Notification(label, {
          body: ATTENTION_LABELS[event.kind],
          // One notification per session: a newer state
          // replaces the older one.
          tag: event.agentId,
        });
        notification.onclick = () => {
          window.focus();
          openTab(event.agentId);
          notification.close();
        };
      }
    },
    [openTab],
  );
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  // Fold every agent list update into the attention tracker,
  // refresh tab labels and drop tabs whose session is gone.
  const handleAgentsChange = useCallback((list: Agent[]) => {
    setAgents(list);
    setAgentsLoaded(true);
    const watching = pageInFocus() ? activeRef.current : null;
    setDone((prevDone) => {
      const step = stepAttention(statusesRef.current, prevDone, list, watching);
      statusesRef.current = step.statuses;
      if (step.events.length > 0) {
        // Defer: this runs inside a state updater.
        queueMicrotask(() => notifyRef.current(step.events));
      }
      const same =
        step.done.size === prevDone.size &&
        [...step.done].every((id) => prevDone.has(id));
      return same ? prevDone : step.done;
    });
    for (const agent of list) knownRef.current.add(agent.agent_id);
  }, []);

  useEffect(() => {
    if (!agentsLoaded) return;
    const byId = new Map(agents.map((a) => [a.agent_id, a]));
    const current = tabs;
    const next = current
      .filter(
        (t) => byId.has(t.id) || ended.has(t.id) || !knownRef.current.has(t.id),
      )
      .map((t) => {
        const agent = byId.get(t.id);
        const label = agent ? tabLabel(agent) : t.label;
        return label === t.label ? t : { ...t, label };
      });
    const changed =
      next.length !== current.length || next.some((t, i) => t !== current[i]);
    if (changed) setTabs(next);
    if (
      activeRef.current !== DASHBOARD &&
      !next.some((t) => t.id === activeRef.current)
    ) {
      setActive(DASHBOARD);
    }
  }, [agents, agentsLoaded, ended, tabs]);

  // Lifecycle events: a session the user stopped closes its
  // tab; one that ended on the host stays, marked as ended.
  useEffect(() => {
    const onStatus = (data: { agent_id: string; status: string }) => {
      const hasTab = tabsRef.current.some((t) => t.id === data.agent_id);
      if (!hasTab) return;
      if (data.status === 'stopped') {
        closeTab(data.agent_id);
      } else if (data.status === 'closed') {
        setEnded((prev) => new Set(prev).add(data.agent_id));
        // Having looked at the tab earlier does not count:
        // the ending is seen only if it is on screen now.
        const watched = pageInFocus() && activeRef.current === data.agent_id;
        setEndedSeen((prev) => {
          const next = new Set(prev);
          if (watched) next.add(data.agent_id);
          else next.delete(data.agent_id);
          return next;
        });
        notifyRef.current([{ agentId: data.agent_id, kind: 'ended' }]);
      }
    };
    socket.on('agent_status_update', onStatus);
    return () => {
      socket.off('agent_status_update', onStatus);
    };
  }, [socket, closeTab]);

  // Remember open tabs across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, active }));
    } catch {
      // Storage unavailable: tabs simply are not restored.
    }
  }, [tabs, active]);

  // Alt+1..9 switches tabs. Caught in the capture phase so
  // it works while the terminal has focus, and stopped there
  // so the key never reaches the agent. Alt+arrows are left
  // alone: they are word navigation in the terminal.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const match = /^Digit([1-9])$/.exec(e.code);
      if (!match) return;
      const index = Number(match[1]) - 1;
      const target = index === 0 ? DASHBOARD : tabsRef.current[index - 1]?.id;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      activate(target);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activate]);

  const agentsById = useMemo(
    () => new Map(agents.map((a) => [a.agent_id, a])),
    [agents],
  );
  const tabAttention = (id: string): Attention | null =>
    attentionOf(agentsById.get(id), done, ended.has(id) && !endedSeen.has(id));

  // Sessions without a tab that need attention show up as a
  // count on the Dashboard tab.
  const openIds = new Set(tabs.map((t) => t.id));
  const untabbedCount = agents.filter(
    (a) => !openIds.has(a.agent_id) && attentionOf(a, done, false),
  ).length;
  const attentionCount =
    untabbedCount + tabs.filter((t) => tabAttention(t.id)).length;

  useEffect(() => {
    document.title =
      attentionCount > 0 ? `(${attentionCount}) ${BASE_TITLE}` : BASE_TITLE;
  }, [attentionCount]);

  const requestNotifications = async () => {
    if (!notificationsSupported()) return;
    setNotifyPermission(await Notification.requestPermission());
  };

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="flex items-stretch bg-slate-950 border-b border-slate-700 shrink-0">
        <div
          role="tablist"
          aria-label="Sessions"
          className="flex items-stretch flex-1 min-w-0 overflow-x-auto"
        >
          <button
            role="tab"
            aria-selected={active === DASHBOARD}
            onClick={() => activate(DASHBOARD)}
            title="Dashboard (Alt+1)"
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold border-r border-slate-800 shrink-0 transition-colors ${
              active === DASHBOARD
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <LayoutDashboard size={14} />
            Dashboard
            {untabbedCount > 0 && (
              <span
                aria-label={`${untabbedCount} sessions need attention`}
                className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 leading-4"
              >
                {untabbedCount}
              </span>
            )}
          </button>
          {tabs.map((tab, i) => {
            const attention = tabAttention(tab.id);
            const isEnded = ended.has(tab.id);
            const selected = active === tab.id;
            return (
              <div
                key={tab.id}
                className={`flex items-center border-r border-slate-800 shrink-0 transition-colors ${
                  selected
                    ? 'bg-slate-800 text-slate-50'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  onClick={() => activate(tab.id)}
                  title={
                    (attention ? `${ATTENTION_LABELS[attention]} — ` : '') +
                    tab.label +
                    (i < 8 ? ` (Alt+${i + 2})` : '')
                  }
                  className="flex items-center gap-2 pl-4 pr-2 py-2 text-xs font-mono max-w-56"
                >
                  {attention && (
                    <span
                      role="status"
                      aria-label={ATTENTION_LABELS[attention]}
                      className={`h-2 w-2 rounded-full shrink-0 ${ATTENTION_DOT[attention]}`}
                    />
                  )}
                  <span
                    className={`truncate ${isEnded ? 'line-through opacity-60' : ''}`}
                  >
                    {tab.label}
                  </span>
                </button>
                <button
                  onClick={() => closeTab(tab.id)}
                  aria-label={`Close tab ${tab.label}`}
                  title="Close tab (the session keeps running)"
                  className="p-1 mr-2 rounded text-slate-500 hover:text-slate-50 hover:bg-slate-700"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {notifyPermission !== 'unsupported' && (
          <button
            onClick={requestNotifications}
            disabled={notifyPermission !== 'default'}
            aria-label={
              notifyPermission === 'granted'
                ? 'Notifications are on'
                : notifyPermission === 'denied'
                  ? 'Notifications are blocked in the browser settings'
                  : 'Turn on notifications'
            }
            title={
              notifyPermission === 'granted'
                ? 'Notifications are on: sessions that need attention notify you while this page is in the background'
                : notifyPermission === 'denied'
                  ? 'Notifications are blocked in the browser settings for this site'
                  : 'Notify me when a session needs attention'
            }
            className={`px-3 shrink-0 border-l border-slate-800 ${
              notifyPermission === 'granted'
                ? 'text-accent'
                : notifyPermission === 'denied'
                  ? 'text-slate-600'
                  : 'text-slate-400 hover:text-slate-50'
            }`}
          >
            {notifyPermission === 'granted' ? (
              <Bell size={14} />
            ) : (
              <BellOff size={14} />
            )}
          </button>
        )}
      </div>

      {/* The dashboard stays mounted while hidden: it owns the
          agent list every tab's status is derived from. */}
      <div
        role="tabpanel"
        className={
          active === DASHBOARD ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'
        }
      >
        <Dashboard onAttach={openTab} onAgentsChange={handleAgentsChange} />
      </div>

      {activeTab && (
        <div role="tabpanel" className="flex-1 min-h-0 flex flex-col">
          <Terminal
            key={activeTab.id}
            agentId={activeTab.id}
            socket={socket}
            ended={ended.has(activeTab.id)}
            onClose={() => closeTab(activeTab.id)}
            onOpenAgent={openTab}
            onReplace={(newId) => replaceTab(activeTab.id, newId)}
            onDetach={() => detachTab(activeTab.id)}
          />
        </div>
      )}
    </div>
  );
};

export default Workspace;
