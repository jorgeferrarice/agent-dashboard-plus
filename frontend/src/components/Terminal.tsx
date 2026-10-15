import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io, Socket } from 'socket.io-client';
import {
  XCircle,
  GitBranch,
  GitFork,
  Monitor,
  TerminalSquare,
  ExternalLink,
  RefreshCw,
  SquareArrowOutUpRight,
  SendHorizontal,
  TextSelect,
  Copy,
  X,
  Upload,
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { AgentDetail, Agent, ToolInfo } from '../api';
import {
  getAgentDetails,
  getCompanions,
  spawnAgent,
  stopAgent,
  normalizeToolInfo,
  uploadFile,
} from '../api';
import { getToolColorsByKeyword } from './dashboard/utils';
import { openTerminalWindow } from './terminalWindow';

interface TerminalProps {
  agentId: string;
  onClose: () => void;
  /**
   * Shared Socket.IO connection. When given, the terminal
   * runs as an in-page tab: it joins and leaves the agent's
   * room on this connection instead of opening its own, and
   * leaves the page title and window alone.
   */
  socket?: Socket;
  /** The session is already known to have ended. */
  ended?: boolean;
  /** Opens another session (a companion). Defaults to a
   *  popup window. */
  onOpenAgent?: (agentId: string) => void;
  /** Called with the replacement session after a resume.
   *  Defaults to navigating this window to it. */
  onReplace?: (newAgentId: string) => void;
  /** Moves this session to its own window. Shows the
   *  detach button when given. */
  onDetach?: () => void;
}

/** Canonical tool type buckets */
type ToolCategory = 'gemini' | 'claude' | 'bash' | 'unknown';

function categorize(toolName?: string): ToolCategory {
  if (!toolName) return 'unknown';
  const t = toolName.toLowerCase();
  if (t.includes('gemini')) return 'gemini';
  if (t.includes('claude')) return 'claude';
  if (t.includes('bash') || t.includes('shell')) return 'bash';
  return 'unknown';
}

const TOOL_COLORS: Record<ToolCategory, string> = {
  gemini: 'bg-blue-500',
  claude: 'bg-purple-500',
  bash: 'bg-slate-500',
  unknown: 'bg-slate-500',
};

const TOOL_LABELS: Record<ToolCategory, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  bash: 'Bash',
  unknown: 'Agent',
};

/** Largest file a session accepts. Keep in sync with
 *  MAX_UPLOAD_BYTES in backend/app/main.py. */
const MAX_UPLOAD_MB = 90;

/** Why an upload failed, in words the user can act on. */
function uploadErrorText(err: unknown): string {
  const res = (
    err as { response?: { status?: number; data?: { detail?: unknown } } }
  ).response;
  if (typeof res?.data?.detail === 'string') return res.data.detail;
  if (res?.status === 413) return `larger than ${MAX_UPLOAD_MB} MB.`;
  if (res?.status) return `the server answered ${res.status}.`;
  // No answer at all: the browser could not read the item
  // (a folder, or a file it has no access to) or the
  // connection dropped.
  return 'could not be read or sent. Folders are not supported.';
}

/** Whether the primary input is a finger. */
const isTouch = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/** Keys a phone keyboard lacks, as sent to the PTY. */
const MOBILE_KEYS: { label: string; input: string; title: string }[] = [
  { label: 'Esc', input: '\x1b', title: 'Escape' },
  { label: 'Tab', input: '\t', title: 'Tab' },
  { label: '⇧Tab', input: '\x1b[Z', title: 'Shift+Tab' },
  { label: '↑', input: '\x1b[A', title: 'Up' },
  { label: '↓', input: '\x1b[B', title: 'Down' },
  { label: '←', input: '\x1b[D', title: 'Left' },
  { label: '→', input: '\x1b[C', title: 'Right' },
  { label: '^C', input: '\x03', title: 'Ctrl+C' },
  { label: '^D', input: '\x04', title: 'Ctrl+D' },
  { label: '^R', input: '\x12', title: 'Ctrl+R' },
  { label: '/', input: '/', title: 'Slash' },
  { label: '⌫', input: '\x7f', title: 'Backspace' },
  { label: '⏎', input: '\r', title: 'Enter' },
];

/**
 * Touch input bar: the special keys a phone keyboard lacks,
 * and a text field that gets the phone's autocorrect and
 * dictation. Sending submits the text with Enter; sending an
 * empty field presses Enter.
 */
const MobileInputBar: React.FC<{
  send: (input: string) => void;
  onShowText: () => void;
}> = ({ send, onShowText }) => {
  const [text, setText] = useState('');
  const submit = () => {
    if (text) {
      // Multi-line text goes as one bracketed paste so each
      // newline is not taken as Enter. Enter follows on its
      // own so the agent does not fold it into the paste.
      send(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
      setTimeout(() => send('\r'), 80);
      setText('');
    } else {
      send('\r');
    }
  };
  return (
    <div className="hidden pointer-coarse:block shrink-0 bg-slate-900 border-t border-slate-700">
      <div className="flex gap-1 px-1 pt-1 overflow-x-auto">
        {MOBILE_KEYS.map((k) => (
          <button
            key={k.title}
            type="button"
            title={k.title}
            aria-label={k.title}
            // Keep the focus (and the keyboard) where it is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send(k.input)}
            className="shrink-0 min-w-11 h-9 px-2 rounded-md bg-slate-800 active:bg-slate-600 text-slate-200 text-sm font-mono border border-slate-700"
          >
            {k.label}
          </button>
        ))}
      </div>
      <form
        className="flex items-end gap-1 p-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          onClick={onShowText}
          aria-label="Select text"
          title="Show the screen as text to select and copy"
          className="shrink-0 w-11 h-10 rounded-md bg-slate-800 active:bg-slate-600 text-slate-300 border border-slate-700 flex items-center justify-center"
        >
          <TextSelect size={18} />
        </button>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          enterKeyHint="send"
          placeholder="Type a message…"
          aria-label="Message to the session"
          className="flex-1 min-w-0 min-h-10 max-h-28 [field-sizing:content] resize-none bg-slate-800 border border-slate-700 rounded-md px-2 py-1.5 text-slate-50 focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          onMouseDown={(e) => e.preventDefault()}
          aria-label={text ? 'Send' : 'Press Enter'}
          className="shrink-0 w-11 h-10 rounded-md bg-accent active:bg-accent-hover text-accent-text flex items-center justify-center"
        >
          <SendHorizontal size={18} />
        </button>
      </form>
    </div>
  );
};

const Terminal: React.FC<TerminalProps> = ({
  agentId,
  onClose,
  socket: sharedSocket,
  ended = false,
  onOpenAgent,
  onReplace,
  onDetach,
}) => {
  const embedded = !!sharedSocket;
  const openAgent = onOpenAgent ?? openTerminalWindow;
  // Callbacks read through refs so the xterm effect does not
  // re-run (and rebuild the terminal) when they change.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const isReplaying = useRef<boolean>(false);

  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [companions, setCompanions] = useState<Agent[]>([]);
  const [spawning, setSpawning] = useState(false);
  // The screen as plain text, shown for touch selection.
  const [screenText, setScreenText] = useState<string | null>(null);

  // Files dragged over the terminal, and how sending them went.
  const [dragging, setDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);

  // Stale session reconnect state
  const [sessionLost, setSessionLost] = useState(ended);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const reconnectingRef = useRef(false);
  const historyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch agent details on mount
  useEffect(() => {
    getAgentDetails(agentId)
      .then(setAgentDetail)
      .catch((err) => console.error('Failed to fetch agent details:', err));
  }, [agentId]);

  // Fetch companions on mount + poll every 10s
  useEffect(() => {
    const fetchCompanions = () => {
      getCompanions(agentId)
        .then(setCompanions)
        .catch((err) => console.error('Failed to fetch companions:', err));
    };
    fetchCompanions();
    const interval = setInterval(fetchCompanions, 10_000);
    return () => clearInterval(interval);
  }, [agentId]);

  // Resume a lost session on request: stop the old agent
  // record, spawn a replacement with resume mode, and switch
  // to it. Nothing is respawned without the user asking, so a
  // session that ended stays visibly ended.
  const handleResume = useCallback(async () => {
    if (!agentDetail || reconnectingRef.current) return;
    setReconnecting(true);
    setReconnectError(null);
    reconnectingRef.current = true;
    try {
      // Stop the stale agent record (ignore errors —
      // it may already be cleaned up)
      await stopAgent(agentId).catch(() => {});

      // Spawn a new agent with the same parameters,
      // using resume mode for session continuity.
      // If the stale session was in a worktree, use
      // the worktree path so the agent resumes in the
      // same isolated directory with its branch and
      // uncommitted work intact.
      const projectDir =
        agentDetail.telemetry?.worktree_path ||
        agentDetail.telemetry?.project_dir;
      const newAgent = await spawnAgent(
        agentDetail.host_id,
        agentDetail.tool_name || 'bash',
        projectDir,
        agentDetail.telemetry?.task_description,
        'resume',
      );

      if (onReplace) {
        onReplace(newAgent.agent_id);
        return;
      }
      // Navigate to the new agent's terminal and update
      // the window name so window.open() can find and
      // focus this popup instead of opening a duplicate
      window.name = `agent_${newAgent.agent_id}`;
      window.location.replace(`/terminal/${newAgent.agent_id}`);
    } catch (err) {
      console.error('Resume failed:', err);
      setReconnectError('Failed to resume — the host may be offline.');
      setReconnecting(false);
      reconnectingRef.current = false;
    }
  }, [agentId, agentDetail, onReplace]);

  // Listen for live telemetry updates to keep header fresh
  useEffect(() => {
    if (!socketRef.current) return;
    const handler = (data: {
      agent_id: string;
      telemetry: Record<string, unknown>;
    }) => {
      if (data.agent_id === agentId && agentDetail) {
        setAgentDetail((prev) =>
          prev
            ? { ...prev, telemetry: { ...prev.telemetry, ...data.telemetry } }
            : prev,
        );
      }
    };
    socketRef.current.on('agent_telemetry_update', handler);
    return () => {
      socketRef.current?.off('agent_telemetry_update', handler);
    };
  }, [agentId, agentDetail]);

  // Companion button handler
  const handleOpenCompanion = useCallback(
    async (targetTool: string) => {
      // Check existing companions for matching tool
      const existing = companions.find((c) => c.tool_name === targetTool);
      if (existing) {
        openAgent(existing.agent_id);
        return;
      }

      if (!agentDetail || spawning) return;
      setSpawning(true);
      try {
        // Use the worktree path if present so the
        // companion inherits the same working directory
        // as the parent agent (worktree or original).
        const projectDir =
          agentDetail.telemetry?.worktree_path ||
          agentDetail.telemetry?.project_dir;
        const spawned = await spawnAgent(
          agentDetail.host_id,
          targetTool,
          projectDir,
          undefined, // taskDescription
          undefined, // sessionMode
          false, // useWorktree — share parent's directory
        );
        openAgent(spawned.agent_id);
      } catch (err) {
        console.error('Failed to spawn companion:', err);
      } finally {
        setSpawning(false);
      }
    },
    [companions, agentDetail, spawning, openAgent],
  );

  // xterm + socket setup
  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      // Scrollback set to zero because scrolling is
      // handled by tmux's 10k-line server-side buffer.
      // Mouse wheel events are relayed as SGR sequences
      // to tmux, which redraws the visible portion.
      // xterm.js scrollback is never directly scrolled
      // by the user.
      //
      // Setting this to 0 eliminates the DOM reflow cost
      // on resize — xterm.js only reflows the visible
      // screen (~47 rows) instead of 500+ lines of
      // escape-heavy agent TUI output. This reduces
      // resize latency from 20+ seconds to near-instant
      // in long sessions.
      //
      // Reconnection replay still works: history is
      // replayed into the visible area by the daemon,
      // and tmux maintains the full scrollback.
      scrollback: 0,
      theme: {
        background: '#000000',
        foreground: '#f1f5f9',
        cursor: '#60a5fa',
        selectionBackground: '#334155',
      },
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      // Phones get more columns out of a narrow screen.
      fontSize: window.innerWidth < 640 ? 12 : 14,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    // On a phone, focusing would pop the keyboard over the
    // output; a tap on the terminal focuses it.
    if (!isTouch()) term.focus();

    // Enable bracketed paste mode so multi-line pastes
    // are wrapped in ESC[200~ / ESC[201~ sequences.
    // Applications (e.g. Pi) request this via ESC[?2004h,
    // but tmux intercepts that sequence and doesn't
    // forward it to the daemon's PTY. Without this,
    // each pasted newline is treated as Enter and
    // submitted as a separate prompt.
    term.write('\x1b[?2004h');

    // --- Scroll position tracking ---
    // Track whether the viewport is scrolled to the bottom
    // so we can restore position after fitAddon.fit()
    // reflows the buffer.
    let isAtBottom = true;
    term.onScroll(() => {
      const buf = term.buffer.active;
      isAtBottom = buf.viewportY >= buf.baseY;
    });

    // --- Resize handling ---
    // Leading-edge debounce for resize: fire immediately
    // on the first resize event, then suppress further
    // calls until the trailing edge settles. This ensures
    // tmux starts redrawing as soon as the user begins
    // resizing (no 500ms wait), while still coalescing
    // rapid intermediate events during a window drag.
    //
    // Track last-sent dimensions to deduplicate resize
    // events. The dedup check in performFit prevents
    // redundant socket emits even if the debounce fires
    // multiple times at the same dimensions.
    let lastSentCols = 0;
    let lastSentRows = 0;

    // Set on cleanup: queued animation frames and timers
    // must not touch a disposed terminal.
    let disposed = false;
    const performFit = () => {
      if (disposed || !terminalRef.current) return;
      try {
        const wasAtBottom = isAtBottom;
        fitAddon.fit();
        if (wasAtBottom) {
          term.scrollToBottom();
        }
        if (
          socketRef.current?.connected &&
          (term.cols !== lastSentCols || term.rows !== lastSentRows)
        ) {
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          socketRef.current.emit('terminal_resize', {
            sid: agentId,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch (e) {
        console.error('Fit failed:', e);
      }
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeCooldown = false;
    const RESIZE_DEBOUNCE_MS = 150;
    const debouncedFit = () => {
      // Leading edge: fire immediately on first event
      if (!resizeCooldown) {
        resizeCooldown = true;
        performFit();
      }
      // Trailing edge: reset timer on each event,
      // fire once after events stop
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeCooldown = false;
        performFit();
      }, RESIZE_DEBOUNCE_MS);
    };

    window.addEventListener('resize', debouncedFit);

    // Re-render the terminal when the tab/window regains
    // focus — xterm.js canvas may not update while hidden.
    const onVisibilityChange = () => {
      if (!document.hidden) {
        requestAnimationFrame(performFit);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const onWindowFocus = () => {
      requestAnimationFrame(performFit);
    };
    window.addEventListener('focus', onWindowFocus);

    let resizeObserver: ResizeObserver | null = null;
    if (terminalRef.current) {
      resizeObserver = new ResizeObserver(debouncedFit);
      resizeObserver.observe(terminalRef.current);
    }

    requestAnimationFrame(performFit);
    xtermRef.current = term;

    const LINE_HEIGHT_PX = 18; // approx pixel height per row

    // Scrolls tmux's buffer by sending SGR mouse wheel
    // sequences (see the wheel handler below), one per step,
    // capped to avoid flooding the PTY. Positive is down.
    const sendWheel = (steps: number) => {
      if (steps === 0 || !socketRef.current?.connected) return;
      const button = steps > 0 ? 65 : 64; // down : up
      const count = Math.min(Math.abs(steps), 10);
      socketRef.current.emit('terminal_input', {
        target_sid: agentId,
        input: `\x1b[<${button};1;1M`.repeat(count),
      });
    };

    // --- Touch scrolling ---
    // xterm.js intercepts touch events with {passive: false}
    // and calls preventDefault(), blocking the browser's
    // native scroll.  We attach our own handler on the
    // xterm-screen element to translate vertical swipes into
    // wheel steps for tmux: xterm.js has no scrollback of
    // its own to scroll.
    let touchStartY: number | null = null;
    let touchAccum = 0;
    // tmux scrolls several lines per wheel step.
    const TOUCH_STEP_PX = 40;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchAccum = 0;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchStartY === null || e.touches.length !== 1) return;
      const deltaY = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      touchAccum += deltaY;

      const steps = Math.trunc(touchAccum / TOUCH_STEP_PX);
      if (steps !== 0) {
        sendWheel(steps);
        touchAccum -= steps * TOUCH_STEP_PX;
      }
      // Prevent the page itself from scrolling
      e.preventDefault();
    };
    const onTouchEnd = () => {
      touchStartY = null;
      touchAccum = 0;
    };

    // Attach to the .xterm-screen element inside our
    // container so we capture touches before xterm's own
    // handler can preventDefault() on them.
    const screenEl =
      terminalRef.current?.querySelector<HTMLElement>('.xterm-screen');
    if (screenEl) {
      screenEl.addEventListener('touchstart', onTouchStart, {
        passive: true,
      });
      screenEl.addEventListener('touchmove', onTouchMove, {
        passive: false,
      });
      screenEl.addEventListener('touchend', onTouchEnd, {
        passive: true,
      });
    }

    // --- Mouse wheel scrolling ---
    // tmux has mouse mode ON for scroll handling, but
    // the daemon strips mouse tracking escape sequences
    // from the output stream so xterm.js never enters
    // application mouse mode.  This means the browser
    // handles text selection and right-click natively.
    //
    // Without mouse tracking and without scrollback,
    // xterm.js turns wheel events into arrow keys, which
    // the agent CLI reads as prompt history navigation.
    // We take over the wheel instead and send synthesized
    // SGR mouse wheel escape sequences to tmux via
    // Socket.IO.  tmux processes these as scroll events
    // in its scrollback buffer.
    //
    // SGR (mode 1006) mouse wheel format:
    //   \x1b[<64;col;rowM  = wheel up
    //   \x1b[<65;col;rowM  = wheel down
    //
    // Trackpads send many small pixel deltas, so they are
    // accumulated until they add up to whole steps.
    let wheelAccum = 0;
    term.attachCustomWheelEventHandler((e) => {
      e.preventDefault();
      wheelAccum += e.deltaMode === 1 ? e.deltaY * LINE_HEIGHT_PX : e.deltaY;
      const steps = Math.trunc(wheelAccum / LINE_HEIGHT_PX);
      wheelAccum -= steps * LINE_HEIGHT_PX;
      sendWheel(steps);
      return false; // never let xterm.js send arrow keys
    });

    // --- Output batching ---
    // Buffer rapid successive terminal_output events and
    // flush them in a single term.write() per animation
    // frame. Uses the write callback so xterm signals
    // when processing is complete.
    let outputBuffer = '';
    let rafId: number | null = null;
    const flushOutput = () => {
      rafId = null;
      if (outputBuffer) {
        const chunk = outputBuffer;
        outputBuffer = '';
        term.write(chunk);
      }
    };

    // Buffer history chunks and write them all at once on
    // history_complete to avoid per-chunk scroll jumping
    // during replay.
    let historyBuffer: string[] = [];

    // Socket.IO: the shared connection when running as a
    // tab, otherwise a connection owned by this window.
    const baseURL =
      import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`;
    const socket =
      sharedSocket ??
      io(`${baseURL}/terminal`, {
        path: '/socket.io',
      });
    socketRef.current = socket;

    // Track disconnect time so we can detect brief
    // interruptions (e.g. browser pausing JS during
    // window drag-resize) vs real outages.
    let disconnectedAt: number | null = null;
    let attached = false;
    const BRIEF_DISCONNECT_MS = 30000;

    const onDisconnect = () => {
      disconnectedAt = Date.now();
    };

    const onConnect = () => {
      const wasBrief =
        attached &&
        !sharedSocket &&
        disconnectedAt !== null &&
        Date.now() - disconnectedAt < BRIEF_DISCONNECT_MS;
      disconnectedAt = null;

      if (wasBrief) {
        // Brief disconnect (e.g. browser paused JS during
        // window drag-resize).  The terminal still has its
        // content.  Do NOT emit join_room — that triggers
        // request_history on the backend, and the history
        // chunks would be written on top of existing
        // content through the live output path.  Just send
        // a resize so tmux adapts to any new dimensions.
        isReplaying.current = false;
        performFit();
        return;
      }

      // A reconnect on the shared connection gets a new
      // server session and loses its rooms, so it always
      // rejoins. Clear the screen first: the replayed
      // history redraws it.
      if (attached) term.reset();
      attached = true;

      // Full reconnect — replay history.
      isReplaying.current = true;
      historyBuffer = [];
      // Send resize BEFORE joining the room so tmux
      // has the correct dimensions before history is
      // replayed.
      lastSentCols = 0;
      lastSentRows = 0;
      performFit();
      socket.emit('join_room', { room: agentId });

      // Detect stale sessions: if history never completes
      // within 5s, the daemon likely no longer has this agent
      if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);
      historyTimeoutRef.current = setTimeout(() => {
        if (isReplaying.current) {
          setSessionLost(true);
          isReplaying.current = false;
        }
      }, 5000);
    };

    const onHistoryComplete = (data: { agent_id: string }) => {
      if (data.agent_id === agentId) {
        // History arrived — session is alive, cancel
        // the stale detection timeout
        if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);

        // Write all buffered history in one call
        if (historyBuffer.length > 0) {
          term.write(historyBuffer.join(''));
          historyBuffer = [];
        }
        isReplaying.current = false;
        replayEndTime = Date.now();
      }
    };

    const onTerminalOutput = (data: { sid: string; output: string }) => {
      if (data.sid !== agentId) return;
      if (isReplaying.current) {
        // Collect history chunks for batched write
        historyBuffer.push(data.output);
      } else {
        // Buffer live output and flush per animation frame
        outputBuffer += data.output;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushOutput);
        }
      }
    };

    // Handle agent lifecycle events. "stopped" means the
    // user intentionally stopped the agent — close the
    // terminal. "closed" means the session ended on the
    // host — show it as ended and offer to resume.
    const onStatusUpdate = (data: { agent_id: string; status: string }) => {
      if (data.agent_id !== agentId) return;
      if (data.status === 'stopped' && !reconnectingRef.current) {
        // Skip while resuming: our own stopAgent call
        // triggers this event.
        if (sharedSocket) onCloseRef.current();
        else window.close();
      } else if (data.status === 'closed') {
        setSessionLost(true);
        isReplaying.current = false;
      }
    };

    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    socket.on('history_complete', onHistoryComplete);
    socket.on('terminal_output', onTerminalOutput);
    socket.on('agent_status_update', onStatusUpdate);
    // The shared connection is usually up already.
    if (socket.connected) onConnect();

    // Filter terminal query responses from user input.
    // eslint-disable-next-line no-control-regex
    const TERM_RESPONSES = new RegExp(
      [
        '\\x1b\\[\\??[\\d;]*c', // DA (Device Attributes)
        '\\x1b\\[[\\d;]*R', // CPR (Cursor Position Report)
        '\\x1b\\[[\\d;]*\\$y', // DECRPM (DEC Private Mode Report)
        '\\x1b\\][\\d;]*;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC responses
      ].join('|'),
      'g',
    );
    // Suppress onData briefly after history replay ends.
    // xterm.js generates terminal query responses while
    // processing replayed output, and these fire through
    // onData after isReplaying clears. The ESC prefixes
    // may be stripped by xterm, making regex matching
    // unreliable. A 500ms suppression window catches
    // all queued responses without affecting real typing.
    let replayEndTime = 0;
    term.onData((data) => {
      if (!isReplaying.current) {
        if (Date.now() - replayEndTime < 500) return;
        const filtered = data.replace(TERM_RESPONSES, '');
        if (filtered) {
          socket.emit('terminal_input', {
            target_sid: agentId,
            input: filtered,
          });
        }
      }
    });

    return () => {
      disposed = true;
      window.removeEventListener('resize', debouncedFit);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);
      resizeObserver?.disconnect();
      if (screenEl) {
        screenEl.removeEventListener('touchstart', onTouchStart);
        screenEl.removeEventListener('touchmove', onTouchMove);
        screenEl.removeEventListener('touchend', onTouchEnd);
      }
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      socket.off('history_complete', onHistoryComplete);
      socket.off('terminal_output', onTerminalOutput);
      socket.off('agent_status_update', onStatusUpdate);
      if (sharedSocket) {
        // Stop this session's output from reaching the
        // page now that nothing displays it.
        if (socket.connected) socket.emit('leave_room', { room: agentId });
      } else {
        socket.disconnect();
      }
      term.dispose();
    };
  }, [agentId, sharedSocket]);

  // xterm.js text cannot be selected by touch: show the
  // screen as plain text the phone can select natively.
  // Wrapped rows are joined so long links stay whole.
  const showScreenText = useCallback(() => {
    const buf = xtermRef.current?.buffer.active;
    if (!buf) return;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    setScreenText(lines.join('\n').trimEnd());
  }, []);

  const sendInput = useCallback(
    (input: string) => {
      socketRef.current?.emit('terminal_input', { target_sid: agentId, input });
    },
    [agentId],
  );

  // Files dropped on the terminal are saved on the session's
  // host, then their paths are pasted at the prompt, as a
  // desktop terminal does. Enter is left to the user.
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      // Some drag sources fill only `items`, not `files`.
      let files = Array.from(e.dataTransfer.files);
      if (!files.length) {
        files = Array.from(e.dataTransfer.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file);
      }
      if (!files.length) {
        console.error('Drop carried no file:', e.dataTransfer.types);
        setUploadStatus({
          text: 'The browser handed over no file. Drag it from a file manager.',
          error: true,
        });
        return;
      }
      setUploadStatus({
        text: `Sending ${files.length === 1 ? files[0].name : `${files.length} files`}…`,
      });
      const paths: string[] = [];
      let error: string | null = null;
      for (const file of files) {
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
          error = `${file.name}: larger than ${MAX_UPLOAD_MB} MB.`;
          continue;
        }
        try {
          paths.push(await uploadFile(agentId, file));
        } catch (err) {
          console.error('Upload failed:', err);
          error = `${file.name}: ${uploadErrorText(err)}`;
        }
      }
      if (paths.length) {
        sendInput(`\x1b[200~${paths.join(' ')} \x1b[201~`);
        xtermRef.current?.focus();
      }
      // An error stays until clicked or the next drop.
      setUploadStatus(error ? { text: error, error: true } : null);
    },
    [agentId, sendInput],
  );

  // Derived header values
  const category = categorize(agentDetail?.tool_name);
  const hostName = agentDetail?.host_name;
  const gitProject = agentDetail?.telemetry?.git_project;
  const gitBranch = agentDetail?.telemetry?.git_branch;
  const gitRemoteUrl = agentDetail?.telemetry?.git_remote_url;
  const worktreePath = agentDetail?.telemetry?.worktree_path;

  // Build tool info from available_tools on this host.
  const allTools: ToolInfo[] = (agentDetail?.available_tools || []).map(
    normalizeToolInfo,
  );

  // Prefer display_name from profile metadata over the
  // hardcoded label map for the tool badge and title.
  const profileInfo = allTools.find((t) => t.name === agentDetail?.tool_name);
  const toolLabel = profileInfo?.display_name || TOOL_LABELS[category];
  const toolBadgeColor = profileInfo?.color
    ? getToolColorsByKeyword(profileInfo.color).solid
    : TOOL_COLORS[category];

  // Companion buttons: all other tools on this host.
  const companionButtons = allTools
    .filter((t) => t.name !== agentDetail?.tool_name)
    .map((t) => ({ label: t.display_name, tool: t.name, color: t.color }));

  // Update browser window title with host / project / branch
  useEffect(() => {
    // As a tab the page title belongs to the workspace.
    if (embedded) return;
    const parts = [toolLabel];
    if (hostName) parts.push(hostName);
    if (gitProject) parts.push(gitProject);
    if (gitBranch) parts.push(gitBranch);
    if (worktreePath) parts.push('worktree');
    document.title = parts.join(' · ');
    return () => {
      document.title = 'Agent Dashboard';
    };
  }, [embedded, toolLabel, hostName, gitProject, gitBranch, worktreePath]);

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-black overflow-hidden">
      {/* Header Bar */}
      <div className="h-11 sm:h-12 flex items-center justify-between gap-2 bg-slate-800 border-b border-slate-700 px-2 sm:px-4 shrink-0 overflow-hidden">
        {/* Left side: tool badge + context */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          {/* Tool badge */}
          <span
            className={`${toolBadgeColor} text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded tracking-wider shrink-0`}
          >
            {toolLabel}
          </span>

          {/* Host / project / branch */}
          <div className="flex items-center gap-2 text-xs text-slate-300 font-mono min-w-0 overflow-hidden">
            {hostName && (
              <span className="hidden sm:contents">
                <Monitor size={12} className="text-slate-400 shrink-0" />
                <span className="text-slate-200">{hostName}</span>
              </span>
            )}
            {gitProject && (
              <>
                <span className="hidden sm:inline text-slate-600">/</span>
                {gitRemoteUrl ? (
                  <a
                    href={gitRemoteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white font-semibold hover:underline truncate min-w-0"
                  >
                    {gitProject}
                  </a>
                ) : (
                  <span className="text-white font-semibold truncate min-w-0">
                    {gitProject}
                  </span>
                )}
              </>
            )}
            {gitBranch && (
              <>
                <GitBranch
                  size={12}
                  className="hidden sm:block text-emerald-400 shrink-0 ml-1"
                />
                {gitRemoteUrl ? (
                  <a
                    href={`${gitRemoteUrl}/tree/${gitBranch}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden sm:block text-emerald-300 hover:underline truncate min-w-0"
                  >
                    {gitBranch}
                  </a>
                ) : (
                  <span className="hidden sm:block text-emerald-300 truncate min-w-0">
                    {gitBranch}
                  </span>
                )}
              </>
            )}
            {worktreePath && (
              <>
                <GitFork
                  size={12}
                  className="hidden sm:block text-amber-400 shrink-0 ml-1"
                />
                <span className="text-amber-300 hidden sm:inline">
                  worktree
                </span>
              </>
            )}
          </div>
        </div>

        {/* Right side: companion + close buttons */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {companionButtons.map((btn) => {
            const existing = companions.find((c) => c.tool_name === btn.tool);
            return (
              <button
                key={btn.tool}
                onClick={() => handleOpenCompanion(btn.tool)}
                disabled={spawning}
                className="shrink-0 flex items-center gap-1.5 bg-slate-700/60 hover:bg-slate-600 text-slate-200 px-2.5 h-9 pointer-fine:h-auto pointer-fine:py-1.5 rounded-md transition-colors border border-slate-600/40 cursor-pointer text-xs font-medium disabled:opacity-50"
                aria-label={
                  existing ? `Attach ${btn.label}` : `Open ${btn.label}`
                }
                title={
                  existing
                    ? `Attach to existing ${btn.label} session`
                    : `Open new ${btn.label} session`
                }
              >
                {existing ? (
                  <ExternalLink size={12} />
                ) : (
                  <TerminalSquare size={12} />
                )}
                <span className="hidden md:inline">
                  {existing ? `Attach ${btn.label}` : `Open ${btn.label}`}
                </span>
                <span className="md:hidden">{btn.label}</span>
              </button>
            );
          })}

          {onDetach && (
            // Touch devices have no separate windows.
            <button
              onClick={onDetach}
              title="Move this session to its own window"
              className="hidden md:pointer-fine:flex items-center gap-1.5 bg-slate-700/60 hover:bg-slate-600 text-slate-200 px-2.5 py-1.5 rounded-md transition-colors border border-slate-600/40 cursor-pointer text-xs font-medium"
            >
              <SquareArrowOutUpRight size={12} />
              <span>Detach</span>
            </button>
          )}

          <button
            onClick={onClose}
            aria-label={embedded ? 'Close Tab' : 'Close Window'}
            className="shrink-0 flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 h-9 pointer-fine:h-auto pointer-fine:py-1.5 rounded-md transition-colors border border-red-500/20 cursor-pointer"
          >
            <XCircle size={14} />
            <span className="hidden sm:inline font-semibold text-xs">
              {embedded ? 'Close Tab' : 'Close Window'}
            </span>
          </button>
        </div>
      </div>

      {/* Terminal Container */}
      <div
        className="flex-1 flex flex-col h-full min-h-0 bg-black p-1 sm:p-2 overflow-hidden relative"
        onDragOver={(e) => {
          // Only files: dragged text keeps its default.
          if (sessionLost || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(e) => {
          if (!sessionLost && e.dataTransfer.types.includes('Files'))
            handleDrop(e);
        }}
      >
        <div className="flex-1 h-full min-h-0">
          <div
            ref={terminalRef}
            className="terminal xterm"
            style={{ height: '100%' }}
          />
        </div>

        {dragging && (
          <div className="absolute inset-1 z-30 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-black/70 text-slate-100 text-sm pointer-events-none">
            <Upload size={18} /> Drop files to send them to this session
          </div>
        )}

        {uploadStatus && (
          <div
            role={uploadStatus.error ? 'alert' : 'status'}
            onClick={() => setUploadStatus(null)}
            title={uploadStatus.error ? 'Click to dismiss' : undefined}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-30 max-w-[90%] truncate px-4 py-2 rounded-md text-sm font-medium border shadow-lg cursor-pointer ${
              uploadStatus.error
                ? 'bg-red-950 text-red-300 border-red-500/40'
                : 'bg-slate-800 text-slate-200 border-slate-600'
            }`}
          >
            {uploadStatus.text}
          </div>
        )}

        {screenText !== null && (
          <div className="absolute inset-0 z-20 flex flex-col bg-slate-950">
            <div className="flex items-center gap-2 px-2 py-1 border-b border-slate-700 shrink-0">
              <span className="flex-1 text-xs text-slate-400">
                Press and hold to select
              </span>
              <button
                onClick={() =>
                  navigator.clipboard?.writeText(screenText).catch(() => {})
                }
                className="flex items-center gap-1.5 h-9 px-3 rounded-md bg-slate-800 active:bg-slate-600 text-slate-200 text-xs border border-slate-700"
              >
                <Copy size={14} /> Copy all
              </button>
              <button
                onClick={() => setScreenText(null)}
                aria-label="Back to the terminal"
                className="flex items-center justify-center h-9 w-11 rounded-md bg-accent text-accent-text"
              >
                <X size={16} />
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-2 text-xs leading-relaxed text-slate-100 font-mono whitespace-pre-wrap break-all select-text">
              {screenText.split(/(https?:\/\/[^\s"'<>]+)/).map((part, i) =>
                i % 2 ? (
                  <a
                    key={i}
                    href={part}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-400 underline"
                  >
                    {part}
                  </a>
                ) : (
                  part
                ),
              )}
            </pre>
          </div>
        )}

        {/* Shown when the session ended or can no longer be
            reached. It is resumed only on request. */}
        {sessionLost && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
            <div className="text-center space-y-4 max-w-sm">
              {reconnecting ? (
                <p className="text-slate-300 text-sm flex items-center gap-2">
                  <RefreshCw size={14} className="animate-spin" />
                  Resuming session...
                </p>
              ) : (
                <>
                  <p
                    role="alert"
                    className={`text-sm ${reconnectError ? 'text-red-400' : 'text-slate-300'}`}
                  >
                    {reconnectError || 'This session has ended.'}
                  </p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={handleResume}
                      disabled={!agentDetail}
                      className="bg-accent hover:bg-accent-hover text-accent-text font-bold px-4 py-2 rounded-xl transition-colors text-sm disabled:opacity-50"
                    >
                      Resume
                    </button>
                    <button
                      onClick={onClose}
                      className="text-slate-400 hover:text-slate-50 px-4 py-2 rounded-xl border border-slate-700 transition-colors text-sm"
                    >
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {!sessionLost && (
        <MobileInputBar send={sendInput} onShowText={showScreenText} />
      )}
    </div>
  );
};

export default Terminal;
