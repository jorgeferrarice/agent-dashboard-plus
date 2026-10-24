import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  translate,
  type MessageKey,
} from '../i18n';
import { buildErrorReport } from '../errorReport';

interface Props {
  /** Which part of the interface this guards, shown in the report. */
  where: string;
  /** The whole app: fill the screen and offer a page reload. */
  fullScreen?: boolean;
  children: ReactNode;
}

interface State {
  error: unknown;
  report: string | null;
  copied: boolean;
}

// The language the I18nProvider put on <html>. Read directly so
// the app-wide boundary works even if the provider itself broke.
const t = (key: MessageKey) => {
  const lang = document.documentElement.lang;
  return translate(isLanguage(lang) ? lang : DEFAULT_LANGUAGE, key);
};

/**
 * Shows what went wrong, instead of a blank screen, when the part
 * of the interface it wraps throws while rendering.
 *
 * The error screen has a copyable report (error, stacks, browser,
 * recent window errors) to paste into an AI chat or an issue, and
 * a button to try rendering again.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, report: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('Unknown error') };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const report = buildErrorReport(
      this.props.where,
      error,
      info.componentStack,
    );
    this.setState({ report });
    console.error(`[ErrorBoundary] ${this.props.where} crashed\n${report}`);
  }

  private retry = () =>
    this.setState({ error: null, report: null, copied: false });

  private copy = () => {
    const { report } = this.state;
    if (!report) return;
    navigator.clipboard
      ?.writeText(report)
      .then(() => this.setState({ copied: true }))
      .catch(() => {});
  };

  render() {
    const { error, report, copied } = this.state;
    if (!error) return this.props.children;
    const { fullScreen, where } = this.props;
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const text = report ?? buildErrorReport(where, error);

    return (
      <div
        role="alert"
        className={`${
          fullScreen
            ? 'min-h-[var(--app-height,100dvh)] bg-slate-950'
            : 'flex-1 min-h-0'
        } overflow-y-auto p-4 text-slate-200`}
      >
        <div className="mx-auto max-w-3xl flex flex-col gap-3 rounded-lg border border-red-500/50 bg-red-950/40 p-4">
          <h2 className="text-lg font-semibold text-red-300">
            {t(fullScreen ? 'error.appTitle' : 'error.tabTitle')}
          </h2>
          <p className="font-mono text-sm break-words text-red-200">
            {message}
          </p>
          <p className="text-sm text-slate-300">{t('error.hint')}</p>
          <textarea
            readOnly
            aria-label={t('error.log')}
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            className="h-64 w-full resize-y rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs text-slate-300"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.copy}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
            >
              {t(copied ? 'error.copied' : 'error.copy')}
            </button>
            <button
              type="button"
              onClick={fullScreen ? () => window.location.reload() : this.retry}
              className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              {t(fullScreen ? 'error.reload' : 'error.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
