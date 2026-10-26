import React, { useContext, useEffect, useState } from 'react';
import { Download, FileText, Globe, Maximize2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mediaUrl } from '../../api';
import { useI18n } from '../../i18n';
import {
  ArtifactFiles,
  artifactUrl,
  fileName,
  isHtml,
  isMedia,
  isPdf,
  isVideo,
  isWebUrl,
} from './chat';
import Viewer from './Viewer';

/** iframe sandbox for an HTML page Claude made: its scripts run,
 *  without this site's origin. The server sends the same rules. */
const PAGE_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals';

/**
 * A PDF: a preview in the message, a button to see it over the
 * whole window and one to download it. A file on the host is
 * fetched once and shown from memory: the browser's PDF viewer
 * does not run in the sandbox the server puts on files.
 */
const PdfPreview: React.FC<{ url: string; name: string; web: boolean }> = ({
  url,
  name,
  web,
}) => {
  const { t } = useI18n();
  const [blob, setBlob] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (web) return;
    let made: string | null = null;
    let live = true;
    fetch(url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((data) => {
        made = URL.createObjectURL(
          new Blob([data], { type: 'application/pdf' }),
        );
        if (live) setBlob(made);
        else URL.revokeObjectURL(made);
      })
      .catch((err) => {
        console.error('PDF failed to load:', err);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, web]);

  if (failed)
    return (
      <span className="block text-xs text-slate-500 italic break-all">
        {t('chat.mediaError', { src: name })}
      </span>
    );
  const src = web ? url : blob;
  return (
    <span className="block my-2 overflow-hidden rounded-md border border-slate-700 bg-slate-900">
      <span className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-300">
        <FileText size={14} className="shrink-0 text-red-300" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {src && (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={t('chat.expand')}
              title={t('chat.expand')}
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-slate-800"
            >
              <Maximize2 size={14} />
            </button>
            <a
              href={src}
              download={name}
              target={web ? '_blank' : undefined}
              rel="noopener noreferrer"
              className="flex h-7 items-center gap-1 rounded px-2 hover:bg-slate-800"
            >
              <Download size={14} /> {t('chat.download')}
            </a>
          </>
        )}
      </span>
      {src ? (
        <iframe
          title={name}
          src={src}
          className="block h-[50vh] w-full border-t border-slate-700 bg-white"
        />
      ) : (
        <span className="block px-2 pb-2 text-xs text-slate-500">
          {t('chat.loading')}
        </span>
      )}
      {open && src && (
        <Viewer
          title={name}
          src={src}
          download={{ href: src, name }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
};

/** A page or artifact Claude made: a button that opens it over
 *  the whole window. */
const PageCard: React.FC<{ url: string; name: string; label: string }> = ({
  url,
  name,
  label,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 flex max-w-full items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
      >
        <Globe size={14} className="shrink-0 text-sky-300" />
        <span className="font-medium">{label}</span>
        <span className="min-w-0 truncate text-slate-500">{name}</span>
      </button>
      {open && (
        <Viewer
          title={name}
          src={url}
          sandbox={PAGE_SANDBOX}
          download={{ href: url, name }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

/**
 * Whether images and videos from other sites load as soon as
 * they are shown. Text the agent read (a web page, a file) can
 * make it write an image address that carries data out in its
 * query string; with false, such media waits for a click.
 */
const EXTERNAL_MEDIA_AUTOLOAD = true;

/**
 * An image or a video of a session, by its extension: a web
 * address, a transcript image ("t:...") or a file on the
 * session's host.
 */
export const Media: React.FC<{
  agentId: string;
  src: string;
  alt?: string;
  video?: boolean;
}> = ({ agentId, src, alt, video }) => {
  const { t } = useI18n();
  const web = isWebUrl(src);
  const [load, setLoad] = useState(!web || EXTERNAL_MEDIA_AUTOLOAD);
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  if (failed)
    return (
      <span className="block text-xs text-slate-500 italic break-all">
        {t('chat.mediaError', { src })}
      </span>
    );
  if (!load)
    return (
      <button
        type="button"
        onClick={() => setLoad(true)}
        className="block my-1 px-3 py-2 rounded-md border border-slate-700 bg-slate-800 text-xs text-slate-300 hover:bg-slate-700"
      >
        {t('chat.loadExternal', { host: new URL(src).host })}
      </button>
    );
  const url = web ? src : mediaUrl(agentId, src);
  if (isPdf(src))
    return <PdfPreview url={url} name={fileName(src)} web={web} />;
  if (isHtml(src) && !web)
    return (
      <PageCard url={url} name={fileName(src)} label={t('chat.openPage')} />
    );
  if (video ?? isVideo(src))
    return (
      <video
        controls
        preload="metadata"
        src={url}
        onError={() => setFailed(true)}
        className="block my-2 max-w-full max-h-[60vh] rounded-md bg-black"
      />
    );
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={url}
        alt={alt || src}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="my-2 max-w-full max-h-[60vh] rounded-md border border-slate-700 bg-slate-950"
      />
    </a>
  );
};

/** Markdown elements, styled for the dark chat. */
const STYLE = [
  'text-sm leading-relaxed text-slate-100 break-words',
  '[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5',
  '[&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1,&_h2,&_h3]:font-semibold [&_h1,&_h2,&_h3]:mt-3 [&_h1,&_h2,&_h3]:mb-1',
  '[&_pre]:my-2 [&_pre]:p-2 [&_pre]:rounded-md [&_pre]:bg-slate-950 [&_pre]:overflow-x-auto [&_pre]:text-xs',
  '[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-black/30 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-300',
  '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_td]:border [&_th]:border-slate-700 [&_td]:border-slate-700 [&_th]:px-2 [&_td]:px-2',
  '[&_hr]:border-slate-700 [&_a]:text-sky-400 [&_a]:underline',
].join(' ');

/**
 * Text of the agent as markdown. Raw HTML is not rendered.
 * Images and links to images or videos show the media: files
 * on the session's host through the dashboard, web addresses
 * directly. Other links to files on the host are not links
 * (they would point into the dashboard).
 */
const Markdown: React.FC<{ agentId: string; text: string }> = ({
  agentId,
  text,
}) => {
  const { t } = useI18n();
  const artifacts = useContext(ArtifactFiles);
  // File names of images and links: already shown as media. By
  // name, as the agent often writes the full path in the image
  // and the short one in the text.
  const linked = new Set(
    Array.from(text.matchAll(/\]\(\s*<?([^)\s>]+)/g), (m) =>
      fileName(safeDecode(m[1])),
    ),
  );
  const components: Components = {
    img: ({ src, alt }) => {
      const target = String(src ?? '');
      return (
        <Media
          agentId={agentId}
          src={isWebUrl(target) ? target : safeDecode(target)}
          alt={alt}
        />
      );
    },
    a: ({ href, children }) => {
      const target = String(href ?? '');
      const artifact = artifactUrl(target);
      const file = artifact && artifacts.get(artifact);
      if (file)
        return (
          <>
            <a href={target} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
            <PageCard
              url={mediaUrl(agentId, file)}
              name={fileName(file)}
              label={t('chat.openArtifact')}
            />
          </>
        );
      if (isWebUrl(target) || target.startsWith('mailto:'))
        return (
          <>
            <a href={target} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
            {isMedia(target) && <Media agentId={agentId} src={target} />}
          </>
        );
      if (isMedia(target))
        return <Media agentId={agentId} src={safeDecode(target)} />;
      return <span className="text-sky-300">{children}</span>;
    },
    code: ({ className, children, node }) => {
      const value = String(children ?? '');
      // A media path in inline code (`out/chart.png`) is shown too,
      // once per message, unless an image or link already shows it.
      const preview =
        !className &&
        /^[^\s<>"'`]+$/.test(value) &&
        isMedia(value) &&
        !linked.has(fileName(value)) &&
        node?.position?.start.offset === text.indexOf('`' + value + '`');
      return (
        <>
          <code className={className}>{children}</code>
          {preview && <Media agentId={agentId} src={value} />}
        </>
      );
    },
  };
  return (
    <div className={STYLE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

/** A path as written in markdown, where spaces may be %20. */
function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export default Markdown;
