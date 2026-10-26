import React, { useEffect, useRef } from 'react';
import { Paperclip, SendHorizontal, Square } from 'lucide-react';
import { useI18n } from '../../i18n';

/** Whether the primary input is a finger. */
const isTouch = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Where the user writes to the agent. Enter sends, Shift+Enter
 * adds a line. Files picked or pasted are handed to `onFiles`,
 * which uploads them and adds their paths to the text.
 */
const ChatComposer: React.FC<{
  /** The text field, for the chat to focus it. */
  fieldRef?: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  onSubmit: () => void;
  onFiles: (files: File[]) => void;
  /** Shows Stop, which presses Esc in the session. */
  working: boolean;
  onStop: () => void;
}> = ({ fieldRef, text, setText, onSubmit, onFiles, working, onStop }) => {
  const { t } = useI18n();
  const ownField = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? ownField;
  const picker = useRef<HTMLInputElement>(null);

  // The terminal underneath may hold the keyboard: take it,
  // except on phones, where it would pop the keyboard up.
  useEffect(() => {
    if (!isTouch()) field.current?.focus();
  }, [field]);

  return (
    <form
      className="shrink-0 flex items-end gap-1.5 border-t border-slate-700 bg-slate-900 px-2 py-2 sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-testid="chat-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <button
        type="button"
        onClick={() => picker.current?.click()}
        aria-label={t('chat.attach')}
        title={t('chat.attach')}
        className="shrink-0 w-10 h-10 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center justify-center"
      >
        <Paperclip size={18} />
      </button>
      <textarea
        ref={field}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length) {
            e.preventDefault();
            onFiles(files);
          }
        }}
        enterKeyHint="send"
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.messageLabel')}
        className="flex-1 min-w-0 min-h-10 max-h-40 [field-sizing:content] resize-none bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-50 focus:outline-none focus:border-accent"
      />
      {working && (
        <button
          type="button"
          onClick={onStop}
          aria-label={t('chat.stop')}
          title={t('chat.stopTitle')}
          className="shrink-0 w-10 h-10 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 flex items-center justify-center"
        >
          <Square size={16} />
        </button>
      )}
      <button
        type="submit"
        onMouseDown={(e) => e.preventDefault()}
        aria-label={t('chat.send')}
        className="shrink-0 w-10 h-10 rounded-md bg-accent hover:bg-accent-hover text-accent-text flex items-center justify-center"
      >
        <SendHorizontal size={18} />
      </button>
    </form>
  );
};

export default ChatComposer;
