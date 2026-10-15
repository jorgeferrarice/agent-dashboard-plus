import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import {
  Bell,
  BellOff,
  Columns2,
  LayoutDashboard,
  Rows2,
  Settings,
  X,
} from 'lucide-react';
import { getOpenTabs, renameSession, saveOpenTabs } from '../api';
import type { Agent } from '../api';
import { getSocket } from '../socket';
import Dashboard from './Dashboard';
import Terminal from './Terminal';
import ThemeSelector from './ThemeSelector';
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

/** Two sessions shown at once. `row` puts them side by side,
 *  `col` stacks them. Tab clicks land in the `focus` pane. */
interface Split {
  ids: [string, string];
  dir: 'row' | 'col';
  focus: 0 | 1;
}

interface StoredTabs {
  tabs: SessionTab[];
  active: string;
  split: Split | null;
}

/** Whether both panes still have a tab, on distinct sessions. */
const splitValid = (split: Split, tabs: SessionTab[]) =>
  split.ids[0] !== split.ids[1] &&
  split.ids.every((id) => tabs.some((t) => t.id === id));

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
      const s = raw.split;
      const split: Split | null =
        Array.isArray(s?.ids) &&
        s.ids.length === 2 &&
        (s.dir === 'row' || s.dir === 'col') &&
        (s.focus === 0 || s.focus === 1) &&
        (active === DASHBOARD || s.ids[s.focus] === active) &&
        splitValid(s, tabs)
          ? { ids: [s.ids[0], s.ids[1]], dir: s.dir, focus: s.focus }
          : null;
      return { tabs, active, split };
    }
  } catch {
    // Unreadable storage: start with the dashboard only.
  }
  return { tabs: [], active: DASHBOARD, split: null };
}

const ATTENTION_DOT: Record<Attention, string> = {
  permission: 'bg-red-500 animate-pulse',
  done: 'bg-sky-400',
  ended: 'bg-amber-400',
};

/** Whether the user is looking at this page right now. */
const pageInFocus = () => !document.hidden && document.hasFocus();

const notificationsSupported = () => typeof Notification !== 'undefined';

// Phones in landscape are wide but short.
const NARROW_QUERY = '(max-width: 767px), (max-height: 500px)';

/** Whether the screen is phone-sized, in either orientation. */
function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.(NARROW_QUERY).matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY);
    if (!mq) return;
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** Where a dragged tab would land: beside which tab. */
interface DropTarget {
  id: string;
  after: boolean;
}

/**
 * Returns the tabs with one moved next to another.
 *
 * Args:
 *   tabs: The tabs in their current order.
 *   fromId: The tab being moved.
 *   target: The tab it is dropped on, and on which side.
 *
 * Returns:
 *   The reordered tabs, or the same array when nothing moves.
 */
function moveTab(
  tabs: SessionTab[],
  fromId: string,
  target: DropTarget,
): SessionTab[] {
  const moved = tabs.find((t) => t.id === fromId);
  if (!moved || fromId === target.id) return tabs;
  const rest = tabs.filter((t) => t.id !== fromId);
  const at = rest.findIndex((t) => t.id === target.id);
  if (at < 0) return tabs;
  rest.splice(at + (target.after ? 1 : 0), 0, moved);
  return rest.every((t, i) => t === tabs[i]) ? tabs : rest;
}

/**
 * Whether tabs can be dragged: only with a mouse or trackpad.
 * On a touch screen a drag is how the tab bar scrolls.
 */
const canDragTabs = () =>
  !(window.matchMedia?.('(pointer: coarse)').matches ?? false);

/** Opens a native popover at the given viewport position. */
function showPopoverAt(id: string, left: number, top: number) {
  const pop = document.getElementById(id);
  if (!pop) return;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.showPopover?.();
}

/**
 * Inline editor that replaces a tab's label while renaming.
 * Enter or blur saves, Escape cancels.
 */
const TabNameInput: React.FC<{
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}> = ({ initial, onSave, onCancel }) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Set once saved or cancelled, so the blur that follows
  // does not save a second time.
  const finished = useRef(false);
  // Focus on mount, synchronously: phones only raise the
  // on-screen keyboard for a focus() made inside the tap that
  // started the rename. See startRename.
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save) onSave(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={60}
      aria-label="Session name"
      placeholder="Name (blank for default)"
      enterKeyHint="done"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className="mx-2 my-1.5 w-40 md:w-56 rounded border border-accent-muted bg-slate-900 px-1.5 py-1 text-xs font-mono text-slate-100 outline-none focus:border-accent"
    />
  );
};

/**
 * The tabbed workspace: a fixed Dashboard tab plus one tab
 * per opened session, all in one window.
 *
 * Only the active session tab has a terminal and receives
 * output, plus a second one while the view is split in two
 * panes. Every other tab is a label with an attention mark
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
  const [split, setSplit] = useState<Split | null>(stored.split);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  // Agents that finished working while unwatched.
  const [done, setDone] = useState<Set<string>>(new Set());
  // Tabs whose session ended, and which of those were seen.
  const [ended, setEnded] = useState<Set<string>>(new Set());
  const [endedSeen, setEndedSeen] = useState<Set<string>>(new Set());
  const narrow = useNarrow();
  // Tab whose label is being edited, and the tab the
  // right-click menu was opened on.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Tab being dragged to a new position, and where it would
  // land if dropped now.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [draggable] = useState(canDragTabs);
  const [menuFor, setMenuFor] = useState<string | null>(null);
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
  const splitRef = useRef(split);
  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = active;
    splitRef.current = split;
  }, [tabs, active, split]);

  const activate = useCallback((id: string) => {
    setActive(id);
    // While split, a session already in a pane takes the
    // focus; any other one replaces the focused pane.
    setSplit((prev) => {
      if (!prev || id === DASHBOARD) return prev;
      const index = prev.ids.indexOf(id);
      if (index === prev.focus) return prev;
      if (index !== -1) return { ...prev, focus: index as 0 | 1 };
      const ids: [string, string] = [...prev.ids];
      ids[prev.focus] = id;
      return { ...prev, ids };
    });
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
    const paneIndex = splitRef.current?.ids.indexOf(id) ?? -1;
    if (splitRef.current && paneIndex !== -1) {
      // Closing a pane's session leaves the other one alone.
      if (activeRef.current !== DASHBOARD) {
        setActive(splitRef.current.ids[1 - paneIndex]);
      }
      setSplit(null);
    } else if (activeRef.current === id) {
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
      setSplit(
        (prev) =>
          prev && {
            ...prev,
            ids: prev.ids.map((id) => (id === oldId ? newId : id)) as [
              string,
              string,
            ],
          },
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
        const options = {
          body: ATTENTION_LABELS[event.kind],
          icon: '/icons/icon-192.png',
          // One notification per session: a newer state
          // replaces the older one.
          tag: event.agentId,
        };
        // Mobile browsers only show notifications through the
        // service worker; its click handler posts back here.
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.ready
            .then((reg) => reg.showNotification(label, options))
            .catch(() => {});
          continue;
        }
        const notification = new Notification(label, options);
        notification.onclick = () => {
          window.focus();
          openTab(event.agentId);
          notification.close();
        };
      }
    },
    [openTab],
  );
  // Clicks on service worker notifications.
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'open-agent' && typeof e.data.agentId === 'string') {
        openTab(e.data.agentId);
      }
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [openTab]);
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
    setSplit((prev) => (prev && splitValid(prev, next) ? prev : null));
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

  // The open tabs and their order follow the user between
  // devices: read from the server once, then saved on every
  // change. The last device to write wins; another device sees
  // it on its next load. The active tab and the split stay
  // local, as a phone and a desktop want different ones.
  const [serverReady, setServerReady] = useState(false);
  // The list the server holds, to skip saves that change nothing.
  const savedTabs = useRef('');
  useEffect(() => {
    let cancelled = false;
    getOpenTabs()
      .then((ids) => {
        if (cancelled) return;
        if (ids) {
          setTabs((prev) => {
            const known = new Map(prev.map((t) => [t.id, t]));
            return ids.map((id) => known.get(id) ?? { id, label: 'session' });
          });
        }
        // Never saved before: the tabs of this browser become
        // the user's tabs, by the save below.
        savedTabs.current = JSON.stringify(ids);
        setServerReady(true);
      })
      .catch((err) => {
        // Offline or failing: keep working from this browser's
        // copy, and do not overwrite what the server has.
        console.error('Failed to load open tabs:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const tabIds = JSON.stringify(tabs.map((t) => t.id));
  useEffect(() => {
    if (!serverReady || savedTabs.current === tabIds) return;
    savedTabs.current = tabIds;
    saveOpenTabs(JSON.parse(tabIds)).catch((err) =>
      console.error('Failed to save open tabs:', err),
    );
  }, [tabIds, serverReady]);

  // Remember open tabs across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tabs, active, split }),
      );
    } catch {
      // Storage unavailable: tabs simply are not restored.
    }
  }, [tabs, active, split]);

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

  // Sessions without a tab that need attention still count
  // toward the page title.
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

  /**
   * Opens the inline name editor for a tab, from a menu item.
   * The menu is closed first, so the focus it hands back on
   * closing lands before the editor takes it. The editor then
   * mounts and focuses inside this same tap (flushSync), which
   * is what makes a phone show its keyboard.
   */
  const startRename = (id: string, menuId: string) => {
    document.getElementById(menuId)?.hidePopover?.();
    flushSync(() => setRenaming(id));
  };

  /** Saves a tab's new name. Blank restores the default. */
  const renameTab = async (id: string, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed === tabsRef.current.find((t) => t.id === id)?.label) return;
    try {
      await renameSession(id, trimmed);
    } catch (err) {
      console.error('Failed to rename session:', err);
      return;
    }
    // Live sessions relabel from the telemetry broadcast; an
    // ended one is no longer in the list, so set it here.
    if (trimmed) {
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, label: trimmed } : t)),
      );
    }
  };

  const requestNotifications = async () => {
    if (!notificationsSupported()) return;
    setNotifyPermission(await Notification.requestPermission());
  };

  const activeTab = tabs.find((t) => t.id === active);
  // Sessions on screen: both panes while split, else the
  // active one. None while the dashboard is showing. Phones
  // show one pane; the split comes back on a wider screen.
  const panes = !activeTab
    ? []
    : split && !narrow
      ? split.ids.flatMap((id) => tabs.find((t) => t.id === id) ?? [])
      : [activeTab];

  /** Splits in `dir`, or closes the split already in `dir`.
   *  The second pane starts on the next tab. */
  const toggleSplit = (dir: Split['dir']) => {
    if (split) {
      setSplit(split.dir === dir ? null : { ...split, dir });
      return;
    }
    const index = tabs.findIndex((t) => t.id === active);
    if (index === -1 || tabs.length < 2) return;
    const other = tabs[(index + 1) % tabs.length].id;
    setSplit({ ids: [active, other], dir, focus: 0 });
  };
  const canSplit = !!activeTab && (!!split || tabs.length > 1);

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
            className={`flex items-center gap-2 px-3 pointer-fine:px-4 py-3.5 pointer-fine:py-2 text-xs font-semibold border-r border-slate-800 shrink-0 transition-colors ${
              active === DASHBOARD
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <LayoutDashboard size={14} />
            <span className="hidden sm:inline">Dashboard</span>
          </button>
          {tabs.map((tab, i) => {
            const attention = tabAttention(tab.id);
            const isEnded = ended.has(tab.id);
            const selected = active === tab.id;
            return (
              <div
                key={tab.id}
                draggable={draggable && renaming !== tab.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  // Firefox only starts a drag that carries data.
                  e.dataTransfer.setData('text/plain', tab.label);
                  setDragging(tab.id);
                }}
                onDragOver={(e) => {
                  // Only tabs reorder: ignore files, text, etc.
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > box.left + box.width / 2;
                  if (dropTarget?.id !== tab.id || dropTarget.after !== after)
                    setDropTarget({ id: tab.id, after });
                }}
                onDrop={(e) => {
                  if (!dragging || !dropTarget) return;
                  e.preventDefault();
                  setTabs((prev) => moveTab(prev, dragging, dropTarget));
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(tab.id);
                  showPopoverAt('tab-menu', e.clientX, e.clientY);
                }}
                className={`flex items-center border-r border-slate-800 shrink-0 transition-colors ${
                  dragging === tab.id ? 'opacity-50 ' : ''
                }${
                  // Accent line on the edge the tab would land on.
                  dropTarget?.id === tab.id && dragging !== tab.id
                    ? dropTarget.after
                      ? 'shadow-[inset_-2px_0_0_0_var(--color-accent)] '
                      : 'shadow-[inset_2px_0_0_0_var(--color-accent)] '
                    : ''
                }${
                  selected
                    ? 'bg-slate-800 text-slate-50'
                    : split?.ids.includes(tab.id)
                      ? 'bg-slate-900 text-slate-200'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                {renaming === tab.id ? (
                  <TabNameInput
                    initial={tab.label}
                    onSave={(name) => renameTab(tab.id, name)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    role="tab"
                    aria-selected={selected}
                    onClick={() => activate(tab.id)}
                    title={
                      (attention ? `${ATTENTION_LABELS[attention]} — ` : '') +
                      tab.label +
                      (i < 8 ? ` (Alt+${i + 2})` : '')
                    }
                    className="flex items-center gap-2 pl-3 pointer-fine:pl-4 pr-1 pointer-fine:pr-2 py-3.5 pointer-fine:py-2 text-xs font-mono max-w-40 md:max-w-56"
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
                )}
                <button
                  onClick={() => closeTab(tab.id)}
                  aria-label={`Close tab ${tab.label}`}
                  title="Close tab (the session keeps running)"
                  // Full tab height on touch screens.
                  className="self-stretch px-2.5 pointer-fine:self-center pointer-fine:p-1 pointer-fine:mr-2 rounded text-slate-500 hover:text-slate-50 hover:bg-slate-700"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div
          id="tab-menu"
          popover="auto"
          role="menu"
          aria-label="Tab actions"
          className="fixed inset-auto m-0 min-w-36 rounded-lg border border-slate-700 bg-slate-800 py-1 text-xs text-slate-200 shadow-xl"
        >
          <button
            role="menuitem"
            onClick={() => menuFor && startRename(menuFor, 'tab-menu')}
            className="block w-full px-3 py-1.5 text-left hover:bg-slate-700"
          >
            Rename session
          </button>
        </div>
        {/* Splitting a phone screen leaves two unusable panes. */}
        {!narrow &&
          (['row', 'col'] as const).map((dir) => {
            const on = split?.dir === dir;
            const label = on
              ? 'Close split'
              : dir === 'row'
                ? 'Split side by side'
                : 'Split top and bottom';
            return (
              <button
                key={dir}
                onClick={() => toggleSplit(dir)}
                disabled={!canSplit}
                aria-label={label}
                aria-pressed={on}
                title={
                  canSplit ? label : 'Open two session tabs to split the view'
                }
                className={`px-3 shrink-0 border-l border-slate-800 ${
                  on
                    ? 'text-accent'
                    : canSplit
                      ? 'text-slate-400 hover:text-slate-50'
                      : 'text-slate-600'
                }`}
              >
                {dir === 'row' ? <Columns2 size={14} /> : <Rows2 size={14} />}
              </button>
            );
          })}
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
        <button
          popoverTarget="workspace-settings"
          // Opens the native popover under this button.
          onClick={(e) => {
            const pop = document.getElementById('workspace-settings');
            if (!pop) return;
            const r = e.currentTarget.getBoundingClientRect();
            pop.style.top = `${r.bottom + 4}px`;
            pop.style.right = `${window.innerWidth - r.right + 4}px`;
          }}
          aria-label="Settings"
          title="Settings"
          className="px-3 shrink-0 border-l border-slate-800 text-slate-400 hover:text-slate-50"
        >
          <Settings size={14} />
        </button>
        <div
          id="workspace-settings"
          popover="auto"
          className="fixed inset-auto m-0 rounded-xl border border-slate-700 bg-slate-800 p-4 text-slate-200 shadow-xl"
        >
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Theme
          </p>
          <ThemeSelector />
          {activeTab && (
            <>
              <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Session
              </p>
              <button
                onClick={() => startRename(activeTab.id, 'workspace-settings')}
                className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-left text-xs hover:bg-slate-700"
              >
                Rename session
              </button>
            </>
          )}
        </div>
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

      {panes.length > 0 && (
        <div
          className={`flex-1 min-h-0 flex ${
            split?.dir === 'row' ? 'flex-row' : 'flex-col'
          }`}
        >
          {panes.map((pane) => (
            <div
              key={pane.id}
              role="tabpanel"
              aria-label={pane.label}
              // Clicking or typing in a pane makes it the one
              // tab clicks land in.
              onMouseDownCapture={() => activate(pane.id)}
              onFocusCapture={() => activate(pane.id)}
              className={`flex-1 min-w-0 min-h-0 flex flex-col ${
                panes.length < 2
                  ? ''
                  : pane.id === active
                    ? 'border border-accent/60'
                    : 'border border-slate-800'
              }`}
            >
              <Terminal
                agentId={pane.id}
                socket={socket}
                ended={ended.has(pane.id)}
                onClose={() => closeTab(pane.id)}
                onOpenAgent={openTab}
                onReplace={(newId) => replaceTab(pane.id, newId)}
                onDetach={() => detachTab(pane.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Workspace;
