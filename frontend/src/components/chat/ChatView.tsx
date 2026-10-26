import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Loader2, ShieldQuestion, Upload } from 'lucide-react';
import { uploadFile } from '../../api';
import { useI18n } from '../../i18n';
import ChatComposer from './ChatComposer';
import ChatMessageView, { ToolGroup } from './ChatMessage';
import type { ChatEvent, ChatMessage, ScreenMenu } from './chat';
import {
  ArtifactFiles,
  MAX_UPLOAD_MB,
  artifactFiles,
  buildItems,
  droppedFiles,
  isTypeOption,
  menuKeys,
  mergeMessages,
  optionText,
  parseMenu,
  pendingTool,
  resultsById,
  sendPrompt,
  toolSummary,
  uploadErrorText,
  useDraft,
} from './chat';

/** How close to the end (px) still counts as reading the end. */
const STICK_PX = 80;

/** How often (ms) the terminal's screen is read for a menu. */
const MENU_POLL_MS = 400;

/** Pause (ms) between keys picking a menu option, so the tool
 *  handles each arrow before the next. */
const KEY_GAP_MS = 60;

/**
 * The menu the session shows (a permission prompt, a question,
 * trusting a folder), answered with a click: the option's keys
 * are typed into the terminal. Esc cancels, as in the terminal.
 */
const MenuCard: React.FC<{
  menu: ScreenMenu;
  onPick: (index: number) => void;
  onCancel: () => void;
  onShowTerminal: () => void;
  busy: boolean;
}> = ({ menu, onPick, onCancel, onShowTerminal, busy }) => {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="shrink-0 max-h-[60%] overflow-y-auto border-t border-amber-500/30 bg-amber-950/40 px-4 py-3"
    >
      <div className="mx-auto max-w-3xl">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
          <ShieldQuestion size={16} /> {t('chat.menuTitle')}
        </p>
        {menu.prompt.length > 0 && (
          <div className="mt-1 space-y-0.5 text-xs text-slate-300 break-words">
            {menu.prompt.map((line, i) => (
              <p
                key={i}
                className={
                  i === menu.prompt.length - 1
                    ? 'text-sm text-slate-100 font-medium'
                    : 'font-mono'
                }
              >
                {line}
              </p>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1.5">
          {menu.options.map((o, i) => (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => onPick(i)}
              className={`text-left rounded-lg border px-3 py-2 text-sm disabled:opacity-60 ${
                i === menu.selected
                  ? 'border-accent bg-accent/15 text-slate-50'
                  : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
              }`}
            >
              <span className="block break-words">
                {optionText(o.label)}
                {isTypeOption(o.label) && (
                  <span className="text-slate-500">
                    {' '}
                    — {t('chat.typeBelow')}
                  </span>
                )}
              </span>
              {o.detail && (
                <span className="block text-xs text-slate-400 break-words">
                  {o.detail}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-9 px-3 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-600 disabled:opacity-60"
          >
            {t('chat.cancelMenu')}
          </button>
          <button
            type="button"
            onClick={onShowTerminal}
            className="h-9 px-3 rounded-md text-slate-300 hover:text-slate-50 text-sm"
          >
            {t('chat.seeTerminal')}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * A session's conversation as a chat, over its terminal.
 *
 * The host daemon reads the agent's transcript and sends its
 * messages (`chat_messages`) to the pages that joined the
 * session's chat (`chat_join`). What the user writes is typed
 * into the terminal, as the touch input bar does, so the agent
 * keeps running exactly as it does in the terminal view.
 */
const ChatView: React.FC<{
  agentId: string;
  socket: Socket;
  /** The agent's state from telemetry: working, idle,
   *  waiting_permission. */
  status?: string;
  /** Types into the session's terminal. */
  send: (input: string) => void;
  /** The rows of the terminal's screen, for menus to answer. */
  readScreen?: () => string[];
  onShowTerminal: () => void;
}> = ({ agentId, socket, status, send, readScreen, onShowTerminal }) => {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useDraft(agentId);
  const [menu, setMenu] = useState<ScreenMenu | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastTop = useRef(0);
  // The status can say working from before the chat opened (a
  // stale reading, a session resumed): show it only once the user
  // has sent something from here.
  const [sent, setSent] = useState(false);
  const working = sent && status === 'working';

  useEffect(() => {
    const join = () => socket.emit('chat_join', { agent_id: agentId });
    const onMessages = (data: ChatEvent) => {
      if (data.agent_id !== agentId) return;
      setMessages((shown) =>
        data.replace ? data.messages : mergeMessages(shown, data.messages),
      );
    };
    // A reconnect is a new server session without its rooms.
    socket.on('connect', join);
    socket.on('chat_messages', onMessages);
    if (socket.connected) join();
    return () => {
      socket.off('connect', join);
      socket.off('chat_messages', onMessages);
      if (socket.connected) socket.emit('chat_leave', { agent_id: agentId });
    };
  }, [agentId, socket]);

  // Follow new messages, unless the user scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [messages, working]);

  // Images and videos load after their message and push the end
  // down: stay at the end while the content grows.
  useEffect(() => {
    const el = list.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    // The list shrinks too: a menu card, the keyboard on a phone.
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The terminal underneath keeps drawing the session: read its
  // screen for a menu. Polling, as a menu has no message of its
  // own (the transcript gets the call only once it is answered).
  useEffect(() => {
    if (!readScreen) return;
    const check = () => {
      const next = parseMenu(readScreen());
      setMenu((shown) =>
        JSON.stringify(shown) === JSON.stringify(next) ? shown : next,
      );
    };
    check();
    const timer = setInterval(check, MENU_POLL_MS);
    return () => clearInterval(timer);
  }, [readScreen]);

  const results = useMemo(() => resultsById(messages), [messages]);
  const items = useMemo(() => buildItems(messages), [messages]);
  const artifacts = useMemo(
    () => artifactFiles(messages, results),
    [messages, results],
  );
  // A message sent while the warning shows answers it: hide it
  // until the status leaves waiting and a new prompt comes.
  const [prevStatus, setPrevStatus] = useState(status);
  const [answered, setAnswered] = useState(false);
  if (status !== prevStatus) {
    setPrevStatus(status);
    setAnswered(false);
  }
  const waiting = status === 'waiting_permission' && !answered;
  const pending = waiting && !menu ? pendingTool(messages, results) : null;

  // Picks a menu option with its keys, one at a time.
  const pick = (index: number) => {
    if (!menu) return;
    const keys = menuKeys(menu, index);
    setBusy(true);
    keys.forEach((key, i) => setTimeout(() => send(key), i * KEY_GAP_MS));
    setTimeout(() => setBusy(false), keys.length * KEY_GAP_MS + 300);
    setSent(true);
    if (isTypeOption(menu.options[index].label)) field.current?.focus();
  };

  const submit = () => {
    sendPrompt(send, text.trim());
    setText('');
    setSent(true);
    setAnswered(true);
    atEnd.current = true;
  };

  // Files go to the session's host; their paths join the text.
  const addFiles = async (files: File[]) => {
    setNotice({
      text: t('terminal.sending', {
        name:
          files.length === 1
            ? files[0].name
            : t('terminal.files', { count: files.length }),
      }),
    });
    const paths: string[] = [];
    let error: string | null = null;
    for (const file of files) {
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        error = `${file.name}: ${t('terminal.uploadTooLarge', { mb: MAX_UPLOAD_MB })}`;
        continue;
      }
      try {
        paths.push(await uploadFile(agentId, file));
      } catch (err) {
        console.error('Upload failed:', err);
        error = `${file.name}: ${uploadErrorText(err, t)}`;
      }
    }
    if (paths.length)
      setText(
        (current) =>
          [current.trimEnd(), paths.join(' ')].filter(Boolean).join(' ') + ' ',
      );
    setNotice(error ? { text: error, error: true } : null);
  };

  return (
    <div
      className="absolute inset-0 z-[5] flex flex-col bg-slate-950"
      // Files dropped here go to the message, not the terminal.
      onDragOver={(e) => {
        e.stopPropagation();
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.stopPropagation();
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        const files = droppedFiles(e.dataTransfer);
        if (files.length) addFiles(files);
        else setNotice({ text: t('terminal.noFile'), error: true });
      }}
    >
      <div
        ref={list}
        onScroll={(e) => {
          // Only scrolling up leaves the end. Content that grows
          // (an image loading) also fires a scroll event, and must
          // not stop the list from following.
          const el = e.currentTarget;
          if (el.scrollTop < lastTop.current)
            atEnd.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
          else if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX)
            atEnd.current = true;
          lastTop.current = el.scrollTop;
        }}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <ArtifactFiles.Provider value={artifacts}>
          <div className="mx-auto max-w-3xl px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-sm text-slate-300">{t('chat.empty')}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {t('chat.emptyHint')}
                </p>
                {/* Before the first message the tool may be asking
                  something only the terminal shows (e.g. whether
                  to trust the folder). */}
                <button
                  type="button"
                  onClick={onShowTerminal}
                  className="mt-4 h-9 px-3 rounded-md border border-slate-700 bg-slate-900 text-xs text-slate-300 hover:bg-slate-800"
                >
                  {t('chat.seeTerminal')}
                </button>
              </div>
            )}
            {items.map((item) =>
              item.kind === 'tools' ? (
                <ToolGroup
                  key={item.key}
                  agentId={agentId}
                  tools={item.tools}
                  results={results}
                />
              ) : (
                <ChatMessageView
                  key={item.key}
                  agentId={agentId}
                  message={item.message}
                  results={results}
                />
              ),
            )}
            {working && (
              <p
                role="status"
                className="flex items-center gap-2 text-xs text-slate-400"
              >
                <Loader2 size={14} className="animate-spin" />
                {t('chat.working')}
              </p>
            )}
          </div>
        </ArtifactFiles.Provider>
      </div>

      {menu ? (
        <MenuCard
          menu={menu}
          busy={busy}
          onPick={pick}
          onCancel={() => send('\x1b')}
          onShowTerminal={onShowTerminal}
        />
      ) : (
        waiting && (
          // Waiting, but no menu found on the screen: the terminal
          // shows what is asked.
          <div
            role="alert"
            className="shrink-0 border-t border-amber-500/30 bg-amber-950/40 px-4 py-3"
          >
            <div className="mx-auto max-w-3xl">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
                <ShieldQuestion size={16} /> {t('chat.permission')}
              </p>
              {pending && (
                <p className="mt-1 truncate font-mono text-xs text-slate-300">
                  {pending.name}: {toolSummary(pending)}
                </p>
              )}
              <button
                type="button"
                onClick={onShowTerminal}
                className="mt-2 h-9 px-3 rounded-md border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 text-sm"
              >
                {t('chat.seeTerminal')}
              </button>
            </div>
          </div>
        )
      )}

      {notice && (
        <div
          role={notice.error ? 'alert' : 'status'}
          onClick={() => setNotice(null)}
          className={`shrink-0 px-4 py-2 text-xs cursor-pointer truncate ${
            notice.error
              ? 'bg-red-950 text-red-300'
              : 'bg-slate-800 text-slate-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      <ChatComposer
        fieldRef={field}
        text={text}
        setText={setText}
        onSubmit={submit}
        onFiles={addFiles}
        working={working}
        onStop={() => send('\x1b')}
      />

      {dragging && (
        <div className="absolute inset-1 z-30 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-black/70 text-slate-100 text-sm pointer-events-none">
          <Upload size={18} /> {t('chat.dropFiles')}
        </div>
      )}
    </div>
  );
};

export default ChatView;
