/**
 * The chat view's data: the conversation of a session as the
 * host daemon reads it from the agent's transcript, and the
 * helpers shared with the terminal (sending a prompt, upload
 * errors).
 */

import { createContext, useEffect, useState } from 'react';
import type { I18n } from '../../i18n';

export interface ImageRef {
  /** A transcript image ("t:<offset>:<index>") or a file path. */
  src: string;
  mime: string;
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & ImageRef)
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      text: string;
      is_error: boolean;
      truncated: boolean;
      images: ImageRef[];
    }
  | { type: 'command'; name: string; args: string }
  | {
      type: 'notice';
      kind:
        | 'compacted'
        | 'command_output'
        | 'task_notification'
        | 'interrupted';
      text: string;
    };

export type ToolResult = Extract<ChatBlock, { type: 'tool_result' }>;
export type ToolUse = Extract<ChatBlock, { type: 'tool_use' }>;

export interface ChatMessage {
  id: string;
  ts: string | null;
  role: 'user' | 'assistant' | 'system';
  blocks: ChatBlock[];
}

/** What the daemon sends: new messages, or all of them. */
export interface ChatEvent {
  agent_id: string;
  messages: ChatMessage[];
  /** The list replaces the one shown (first read, new conversation). */
  replace?: boolean;
}

/** Adds new messages; one with a known ID replaces the old copy. */
export function mergeMessages(
  shown: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const next = [...shown];
  const index = new Map(next.map((m, i) => [m.id, i]));
  for (const message of incoming) {
    const at = index.get(message.id);
    if (at === undefined) {
      index.set(message.id, next.length);
      next.push(message);
    } else {
      next[at] = message;
    }
  }
  return next;
}

/** Each tool call's result, by the call's ID. */
export function resultsById(messages: ChatMessage[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const m of messages)
    for (const b of m.blocks)
      if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  return results;
}

/** The last tool call that has no result yet. */
export function pendingTool(
  messages: ChatMessage[],
  results: Map<string, ToolResult>,
): ToolUse | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === 'tool_use') return results.has(b.id) ? null : b;
    }
  }
  return null;
}

/** One line telling what a tool call does: the command, the file... */
export function toolSummary(tool: ToolUse): string {
  const input = tool.input ?? {};
  const pick = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string) : '';
  const known: Record<string, string> = {
    Bash: 'command',
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    MultiEdit: 'file_path',
    NotebookEdit: 'notebook_path',
    Grep: 'pattern',
    Glob: 'pattern',
    WebFetch: 'url',
    WebSearch: 'query',
    Task: 'description',
    Agent: 'description',
  };
  const first = Object.values(input).find((v) => typeof v === 'string');
  const text = (known[tool.name] && pick(known[tool.name])) || first || '';
  return String(text).split('\n')[0];
}

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const PDF = /\.pdf$/i;
const HTML = /\.html?$/i;
const MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|pdf)$/i;

const bare = (src: string) => src.split(/[?#]/)[0];

/** Whether a path or URL names a video (by its extension). */
export const isVideo = (src: string) => VIDEO.test(bare(src));

/** Whether a path or URL names a PDF. */
export const isPdf = (src: string) => PDF.test(bare(src));

/** Whether a path names an HTML page. */
export const isHtml = (src: string) => HTML.test(bare(src));

/** A web address, as opposed to a path on the session's host. */
export const isWebUrl = (src: string) => /^https?:\/\//i.test(src);

/**
 * Whether the chat shows a path or URL as media: images, videos
 * and PDFs, and HTML pages on the session's host (a web page is
 * left a link: it is a site, not a file Claude made).
 */
export const isMedia = (src: string) =>
  MEDIA.test(bare(src)) || (isHtml(src) && !isWebUrl(src));

/** The last part of a path or URL, without query or fragment. */
export const fileName = (path: string) => bare(path).split('/').pop() || path;

const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;

/** A claude.ai artifact's address, without query or fragment;
 *  null for any other address. */
export const artifactUrl = (href: string): string | null =>
  ARTIFACT.exec(href)?.[0] ?? null;

/** The local file of each artifact address the chat knows (see
 *  ``artifactFiles``). Given by the chat view. */
export const ArtifactFiles = createContext<Map<string, string>>(new Map());

/**
 * The local file each artifact of the conversation was published
 * from, by its address. claude.ai refuses to be shown inside
 * another site, so the chat shows that file instead.
 *
 * An Artifact call names the file (``file_path``) and, when it
 * updates one, the address (``url``); its result names the
 * address of a new one.
 */
export function artifactFiles(
  messages: ChatMessage[],
  results: Map<string, ToolResult>,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of messages)
    for (const b of m.blocks) {
      if (b.type !== 'tool_use' || b.name !== 'Artifact') continue;
      const path = b.input.file_path;
      if (typeof path !== 'string' || !isHtml(path)) continue;
      const known = [
        String(b.input.url ?? ''),
        ...(results.get(b.id)?.text.match(/https:\/\/claude\.ai\/\S+/g) ?? []),
      ];
      for (const href of known) {
        const url = artifactUrl(href);
        if (url) files.set(url, path);
      }
    }
  return files;
}

const PASTED =
  /<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g;

/**
 * Splits a prompt into what was typed and what was pasted.
 * Claude Code stores pasted text between
 * ``<pasted_content id="…">`` tags; the chat shows it without
 * them, set apart.
 */
export function promptParts(text: string): { text: string; pasted: boolean }[] {
  const parts: { text: string; pasted: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(PASTED)) {
    parts.push({ text: text.slice(at, match.index), pasted: false });
    parts.push({ text: match[1], pasted: true });
    at = match.index + match[0].length;
  }
  parts.push({ text: text.slice(at), pasted: false });
  return parts
    .map((p) => ({
      ...p,
      // A tag left alone (cut, unclosed) is dropped too.
      text: p.text.replace(/<\/?pasted_content id="[^"]*">/g, ''),
    }))
    .map((p) => (p.pasted ? p : { ...p, text: p.text.trim() }))
    .filter((p) => p.text.trim());
}

/**
 * Sends a prompt to the session's terminal, as if typed.
 *
 * Multi-line text goes as one bracketed paste so each newline
 * is not taken as Enter. Enter follows on its own so the agent
 * does not fold it into the paste. Empty text presses Enter.
 */
export function sendPrompt(send: (input: string) => void, text: string): void {
  if (!text) {
    send('\r');
    return;
  }
  send(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => send('\r'), 80);
}

/** Largest file a session accepts. Keep in sync with
 *  MAX_UPLOAD_BYTES in backend/app/main.py. */
export const MAX_UPLOAD_MB = 90;

/** Why an upload failed, in words the user can act on. */
export function uploadErrorText(err: unknown, t: I18n['t']): string {
  const res = (
    err as { response?: { status?: number; data?: { detail?: unknown } } }
  ).response;
  if (typeof res?.data?.detail === 'string') return res.data.detail;
  if (res?.status === 413)
    return t('terminal.uploadTooLarge', { mb: MAX_UPLOAD_MB });
  if (res?.status) return t('terminal.uploadStatus', { status: res.status });
  // No answer at all: the browser could not read the item
  // (a folder, or a file it has no access to) or the
  // connection dropped.
  return t('terminal.uploadUnreadable');
}

/** Files of a drop: some drag sources fill only `items`. */
export function droppedFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

const DRAFT_KEY = 'agentDashboard.draft.';

/**
 * The text being written to a session, kept in this browser.
 *
 * The chat's box and the terminal's touch bar share it, so
 * switching views, tabs or reloading keeps what was typed.
 * Sending clears it.
 */
export function useDraft(agentId: string) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY + agentId) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY + agentId, text);
      else localStorage.removeItem(DRAFT_KEY + agentId);
    } catch {
      // Storage blocked: the draft lasts while the view is open.
    }
  }, [agentId, text]);
  return [text, setText] as const;
}

/** A menu on the session's screen: a permission prompt, a
 *  question, trusting a folder. */
export interface ScreenMenu {
  /** The lines above the options: what is asked, and about what. */
  prompt: string[];
  options: { label: string; detail: string }[];
  /** The highlighted option. */
  selected: number;
}

const POINTER = '❯'; // ❯, the highlighted option
const BORDER = /^\s*─{10,}\s*$/; // ─── the dialog's top edge
const RULE = /^\s*[─╌┄-]{10,}\s*$/; // any rule
const NUMBERED = /^\d+\.\s/;
/** The keys hint under menus that have no numbers. */
const FOOTER = /Enter to (confirm|select)|Esc to cancel/;

/**
 * Finds the menu Claude Code shows at the bottom of its screen.
 *
 * Options sit in one column, the highlighted one behind ❯;
 * lines indented further describe the option above them. A
 * menu needs two options, and either numbers or the keys hint
 * under it, so the prompt line (❯ and what is being typed) is
 * not taken for one.
 *
 * @param lines The screen's rows, top to bottom.
 * @returns The menu, or null if none is on screen.
 */
export function parseMenu(lines: string[]): ScreenMenu | null {
  const rows = lines.map((l) => l.replace(/\s+$/, ''));
  let sel = -1;
  for (let i = rows.length - 1; i >= 0 && sel < 0; i--)
    if (rows[i].trimStart().startsWith(POINTER)) sel = i;
  if (sel < 0 || !rows[sel].slice(rows[sel].indexOf(POINTER) + 1).trim())
    return null;
  const col = rows[sel].indexOf(POINTER) + 2;
  const plain = (r: string) => r.replace(POINTER, ' ');
  const indent = (r: string) => plain(r).search(/\S/);
  const isOption = (r: string) => indent(r) === col;
  const inMenu = (r: string) => !r.trim() || indent(r) >= col;

  // The rows of the menu: options, their details, blank rows,
  // and rules between options (Claude's "Chat about this").
  const scan = (from: number, step: number) => {
    let edge = from;
    for (let i = from + step; i >= 0 && i < rows.length; i += step) {
      const r = rows[i];
      if (RULE.test(r)) {
        let j = i + step;
        while (j >= 0 && j < rows.length && !rows[j].trim()) j += step;
        if (j < 0 || j >= rows.length || !isOption(rows[j])) break;
        i = j - step;
        continue;
      }
      if (!inMenu(r)) break;
      if (r.trim() && (step < 0 ? isOption(r) : true)) edge = i;
    }
    return edge;
  };
  const start = scan(sel, -1);
  const end = scan(sel, 1);

  const options: ScreenMenu['options'] = [];
  let selected = -1;
  for (let i = start; i <= end; i++) {
    const r = rows[i];
    if (!r.trim() || RULE.test(r)) continue;
    if (isOption(r)) {
      if (i === sel) selected = options.length;
      options.push({ label: plain(r).trim(), detail: '' });
    } else if (options.length) {
      const last = options[options.length - 1];
      last.detail = [last.detail, r.trim()].filter(Boolean).join(' ');
    }
  }
  if (options.length < 2 || selected < 0) return null;
  const numbered = options.every((o, i) => o.label.startsWith(`${i + 1}. `));
  const after = rows.slice(end + 1).filter((r) => r.trim());
  if (!numbered && !after.slice(0, 2).some((r) => FOOTER.test(r))) return null;
  if (!numbered && options.some((o) => NUMBERED.test(o.label))) return null;

  // What is asked: the lines from the dialog's top edge down.
  const prompt: string[] = [];
  for (let i = start - 1; i >= 0 && prompt.length < 12; i--) {
    if (BORDER.test(rows[i])) break;
    if (rows[i].trim() && !RULE.test(rows[i])) prompt.unshift(rows[i].trim());
  }
  return { prompt, options, selected };
}

/** What a menu's label reads without its number ("2. No" → "No"). */
export const optionText = (label: string) => label.replace(NUMBERED, '');

/** Whether an option opens a text field ("Type something."). */
export const isTypeOption = (label: string) =>
  /^type something/i.test(optionText(label));

/**
 * The keys that pick a menu option: arrows from the highlighted
 * one, then Enter. Arrows work in every Claude Code menu,
 * numbered or not. An option that opens a text field gets no
 * Enter: what the user writes next goes into it.
 */
export function menuKeys(menu: ScreenMenu, index: number): string[] {
  const moves = index - menu.selected;
  const keys: string[] = Array(Math.abs(moves)).fill(
    moves > 0 ? '\x1b[B' : '\x1b[A',
  );
  if (!isTypeOption(menu.options[index].label)) keys.push('\r');
  return keys;
}

/** A row of the chat: a message, or a run of tool calls. */
export type ChatItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tools'; key: string; tools: ToolUse[] };

/**
 * Turns messages into chat rows. Tool calls in a row, across
 * messages, fold into one group; tool results are shown on
 * their calls, so they make no row. Questions to the user stay
 * in the conversation, where they are read.
 */
export function buildItems(messages: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    m.blocks.forEach((b, i) => {
      if (b.type === 'tool_result') return;
      const last = items[items.length - 1];
      if (b.type === 'tool_use' && b.name !== 'AskUserQuestion') {
        if (last?.kind === 'tools') last.tools.push(b);
        else items.push({ kind: 'tools', key: `tools:${b.id}`, tools: [b] });
        return;
      }
      if (last?.kind === 'message' && last.message.id === m.id)
        last.message.blocks.push(b);
      else
        items.push({
          kind: 'message',
          key: `${m.id}:${i}`,
          message: { ...m, blocks: [b] },
        });
    });
  }
  return items;
}

/** How many tool calls of a group run, ended well, failed. */
export function toolCounts(tools: ToolUse[], results: Map<string, ToolResult>) {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const tool of tools) {
    const result = results.get(tool.id);
    if (!result) running++;
    else if (result.is_error) failed++;
    else done++;
  }
  return { running, done, failed };
}
