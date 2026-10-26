import React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Loader2,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import Markdown, { Media } from './Markdown';
import type { ChatMessage as Message, ToolResult, ToolUse } from './chat';
import { promptParts, toolCounts, toolSummary } from './chat';

interface Question {
  question?: string;
  options?: { label?: string; description?: string }[];
}

/** An AskUserQuestion call: the questions and their options.
 *  They are answered on the menu card above the message box. */
const QuestionCard: React.FC<{ tool: ToolUse }> = ({ tool }) => {
  const questions = Array.isArray(tool.input.questions)
    ? (tool.input.questions as Question[])
    : [];
  return (
    <div className="my-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm space-y-3">
      {questions.map((q, i) => (
        <div key={i}>
          {/* String(): the input is the model's JSON; a value of
              another type must not break the page. */}
          <p className="text-slate-100 font-medium">
            {String(q?.question ?? '')}
          </p>
          <ul className="mt-1 space-y-1">
            {(Array.isArray(q?.options) ? q.options : []).map((o, j) => (
              <li key={j} className="text-slate-300">
                <span className="font-mono text-slate-500">{j + 1}.</span>{' '}
                {String(o?.label ?? '')}
                {o?.description && (
                  <span className="text-slate-500">
                    {' '}
                    — {String(o.description)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};

/** A tool call and its result, folded to one line. */
const ToolCard: React.FC<{
  agentId: string;
  tool: ToolUse;
  result?: ToolResult;
}> = ({ agentId, tool, result }) => {
  const { t } = useI18n();
  const summary = toolSummary(tool);
  const status = !result ? (
    <Circle size={12} className="text-slate-500 shrink-0" />
  ) : result.is_error ? (
    <AlertTriangle size={12} className="text-red-400 shrink-0" />
  ) : (
    <Check size={12} className="text-emerald-400 shrink-0" />
  );
  return (
    <details
      className={`my-1.5 rounded-md border text-xs ${
        result?.is_error
          ? 'border-red-500/40 bg-red-950/30'
          : 'border-slate-700 bg-slate-900'
      }`}
    >
      <summary className="flex items-center gap-2 px-2 py-1.5 cursor-pointer select-none min-w-0">
        {status}
        <span className="font-semibold text-slate-200 shrink-0">
          {tool.name}
        </span>
        <span className="font-mono text-slate-400 truncate min-w-0">
          {summary}
        </span>
      </summary>
      <div className="border-t border-slate-700 px-2 py-2 space-y-2">
        <div>
          <p className="text-slate-500 mb-1">{t('chat.input')}</p>
          <pre className="whitespace-pre-wrap break-all font-mono text-slate-300 max-h-64 overflow-auto">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        </div>
        <div>
          <p className="text-slate-500 mb-1">
            {result?.is_error ? t('chat.toolError') : t('chat.result')}
          </p>
          {result ? (
            <>
              <pre
                className={`whitespace-pre-wrap break-all font-mono max-h-80 overflow-auto ${
                  result.is_error ? 'text-red-300' : 'text-slate-300'
                }`}
              >
                {result.text}
              </pre>
              {result.truncated && (
                <p className="mt-1 text-slate-500 italic">
                  {t('chat.truncated')}
                </p>
              )}
              {result.images.map((img) => (
                <Media key={img.src} agentId={agentId} src={img.src} />
              ))}
            </>
          ) : (
            <p className="text-slate-500 italic">{t('chat.toolPending')}</p>
          )}
        </div>
      </div>
    </details>
  );
};

/** Bubbles stay this narrow so a reply reads as a reply; long
 *  replies wrap and their code and tables scroll inside. */
const BUBBLE = 'min-w-0 px-3.5 py-2 rounded-2xl text-sm shadow-sm';

/** The time a message was written, as hours and minutes. */
function clock(ts: string | null, language: string): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tool calls in a row, folded to one line that counts them:
 *  "1 command running, 3 done". Open, it lists each call. */
export const ToolGroup: React.FC<{
  agentId: string;
  tools: ToolUse[];
  results: Map<string, ToolResult>;
}> = ({ agentId, tools, results }) => {
  const { t } = useI18n();
  const { running, done, failed } = toolCounts(tools, results);
  const parts: string[] = [];
  if (running)
    parts.push(
      t(running === 1 ? 'chat.groupRunningOne' : 'chat.groupRunning', {
        count: running,
      }),
    );
  if (done)
    parts.push(
      t(done === 1 ? 'chat.groupDoneOne' : 'chat.groupDone', { count: done }),
    );
  if (failed)
    parts.push(
      t(failed === 1 ? 'chat.groupFailedOne' : 'chat.groupFailed', {
        count: failed,
      }),
    );
  const label = running
    ? parts.join(', ')
    : `${t(tools.length === 1 ? 'chat.groupCommandsOne' : 'chat.groupCommands', { count: tools.length })}: ${parts.join(', ')}`;
  // While a call runs, the line also tells which one.
  const current = [...tools].reverse().find((tool) => !results.has(tool.id));
  return (
    <details className="group max-w-[92%] sm:max-w-[85%] rounded-xl border border-slate-700/70 bg-slate-900/70 text-xs">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none min-w-0 list-none [&::-webkit-details-marker]:hidden">
        {running ? (
          <Loader2 size={13} className="animate-spin text-sky-400 shrink-0" />
        ) : failed ? (
          <AlertTriangle size={13} className="text-red-400 shrink-0" />
        ) : (
          <Check size={13} className="text-emerald-400 shrink-0" />
        )}
        <span className="font-medium text-slate-200 shrink-0">{label}</span>
        {current && (
          <span className="font-mono text-slate-500 truncate min-w-0">
            {current.name}: {toolSummary(current)}
          </span>
        )}
        <ChevronRight
          size={13}
          className="ml-auto shrink-0 text-slate-500 transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="border-t border-slate-700/70 px-2 py-1">
        {tools.map((tool) => (
          <ToolCard
            key={tool.id}
            agentId={agentId}
            tool={tool}
            result={results.get(tool.id)}
          />
        ))}
      </div>
    </details>
  );
};

/**
 * One message of the conversation, as chat bubbles: the user's
 * on the right, Claude's on the left. Slash commands and
 * notices are centered between them. Tool calls are shown by
 * ToolGroup; their results come in later messages of their own.
 */
const ChatMessage: React.FC<{
  agentId: string;
  message: Message;
  results: Map<string, ToolResult>;
}> = ({ agentId, message, results }) => {
  const { t, language } = useI18n();
  const user = message.role === 'user';
  const time = clock(message.ts, language);

  // Text and images in a row share one bubble.
  const rows: React.ReactNode[] = [];
  let bubble: React.ReactNode[] = [];
  const closeBubble = () => {
    if (!bubble.length) return;
    rows.push(
      <div
        key={`b${rows.length}`}
        className={`flex ${user ? 'justify-end' : 'justify-start'} min-w-0`}
      >
        <div
          className={
            user
              ? `${BUBBLE} max-w-[85%] sm:max-w-[75%] rounded-br-md bg-accent text-accent-text`
              : `${BUBBLE} max-w-[92%] sm:max-w-[85%] rounded-bl-md bg-slate-800 text-slate-100`
          }
        >
          {bubble}
          {time && (
            <span
              className={`block text-right text-[10px] leading-none mt-1 ${
                user ? 'opacity-70' : 'text-slate-500'
              }`}
            >
              {time}
            </span>
          )}
        </div>
      </div>,
    );
    bubble = [];
  };

  message.blocks.forEach((b, i) => {
    switch (b.type) {
      case 'text':
        bubble.push(
          user ? (
            promptParts(b.text).map((part, j) =>
              part.pasted ? (
                // Pasted text: set apart, and scrolled when long.
                <div
                  key={`${i}.${j}`}
                  title={t('chat.pasted')}
                  className="my-1 max-h-60 overflow-auto rounded-md border-l-2 border-current/40 bg-black/20 px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words"
                >
                  {part.text}
                </div>
              ) : (
                <p
                  key={`${i}.${j}`}
                  className="whitespace-pre-wrap break-words"
                >
                  {part.text}
                </p>
              ),
            )
          ) : (
            <Markdown key={i} agentId={agentId} text={b.text} />
          ),
        );
        return;
      case 'image':
        bubble.push(<Media key={i} agentId={agentId} src={b.src} />);
        return;
    }
    closeBubble();
    switch (b.type) {
      case 'tool_use':
        rows.push(
          b.name === 'AskUserQuestion' ? (
            <div key={i} className="max-w-[92%] sm:max-w-[85%]">
              <QuestionCard tool={b} />
            </div>
          ) : (
            <ToolGroup
              key={i}
              agentId={agentId}
              tools={[b]}
              results={results}
            />
          ),
        );
        return;
      case 'command':
        rows.push(
          <p key={i} className="text-center">
            <span className="inline-block max-w-full truncate rounded-full bg-slate-800 border border-slate-700 px-3 py-1 font-mono text-xs text-slate-300">
              {b.name}
              {b.args ? ` ${b.args}` : ''}
            </span>
          </p>,
        );
        return;
      case 'notice':
        rows.push(
          b.kind === 'command_output' ? (
            <pre
              key={i}
              className="mx-auto max-w-full whitespace-pre-wrap break-all rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-slate-400"
            >
              {b.text}
            </pre>
          ) : (
            <p
              key={i}
              className="text-center text-xs text-slate-500 italic break-words"
            >
              {b.kind === 'compacted'
                ? t('chat.compacted')
                : b.kind === 'interrupted'
                  ? t('chat.interrupted')
                  : `${t('chat.task')}: ${b.text}`}
            </p>
          ),
        );
        return;
    }
  });
  closeBubble();
  if (!rows.length) return null;

  return (
    <div className="space-y-1 min-w-0" data-role={message.role}>
      {rows}
    </div>
  );
};

export default ChatMessage;
