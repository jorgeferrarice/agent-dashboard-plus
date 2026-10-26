import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { useI18n } from '../../i18n';

/**
 * A page or document over the whole window: a PDF, an HTML page
 * Claude made. Closes with the button at the top right, Esc, or
 * a click on the backdrop.
 *
 * Rendered into document.body so no panel around the chat can
 * make it smaller than the window.
 */
const Viewer: React.FC<{
  title: string;
  src: string;
  /** iframe sandbox; a PDF needs none, an HTML page does. */
  sandbox?: string;
  /** Download address and file name; no button without it. */
  download?: { href: string; name: string };
  onClose: () => void;
}> = ({ title, src, sandbox, download, onClose }) => {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-[100] flex flex-col bg-black/80 p-2 sm:p-4"
    >
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-700 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
            {title}
          </span>
          {download && (
            <a
              href={download.href}
              download={download.name}
              className="flex h-9 items-center gap-1.5 rounded-md border border-slate-600 bg-slate-800 px-3 text-sm text-slate-200 hover:bg-slate-700"
            >
              <Download size={15} /> {t('chat.download')}
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('chat.close')}
            title={t('chat.close')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-slate-50"
          >
            <X size={18} />
          </button>
        </div>
        <iframe
          title={title}
          src={src}
          sandbox={sandbox}
          className="min-h-0 flex-1 w-full bg-white"
        />
      </div>
    </div>,
    document.body,
  );
};

export default Viewer;
