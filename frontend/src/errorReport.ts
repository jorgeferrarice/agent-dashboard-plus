/**
 * Error reports for the error screens (see ErrorBoundary).
 *
 * A report is plain text meant to be pasted into an AI chat or an
 * issue: where it broke, the error and its stacks, the browser,
 * and the last errors the window saw (async errors that a React
 * error boundary cannot catch end up there too).
 */

const MAX_RECENT = 20;

interface RecentError {
  time: string;
  text: string;
}

const recent: RecentError[] = [];
let listening = false;

const describe = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const remember = (text: string) => {
  recent.push({ time: new Date().toISOString(), text });
  if (recent.length > MAX_RECENT) recent.shift();
};

/**
 * Starts keeping the window's uncaught errors and unhandled
 * promise rejections, so a report can include them. Safe to call
 * more than once.
 */
export function recordWindowErrors(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('error', (event) => {
    remember(
      event.error
        ? describe(event.error)
        : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    remember(`Unhandled rejection: ${describe(event.reason)}`);
  });
}

/** The page address without query or fragment (they can hold login codes). */
const pageAddress = () =>
  typeof window === 'undefined'
    ? ''
    : `${window.location.origin}${window.location.pathname}`;

/**
 * The text report for an error caught by an error boundary.
 *
 * @param where Which part of the interface broke, e.g. "Tasks tab".
 * @param error What was thrown.
 * @param componentStack React's component stack, when known.
 */
export function buildErrorReport(
  where: string,
  error: unknown,
  componentStack?: string | null,
): string {
  const lines = [
    'Agent Dashboard error report',
    `Where: ${where}`,
    `Time: ${new Date().toISOString()}`,
    `Page: ${pageAddress()}`,
    `Browser: ${typeof navigator === 'undefined' ? '' : navigator.userAgent}`,
    `Language: ${typeof document === 'undefined' ? '' : document.documentElement.lang}`,
    `Build: ${import.meta.env.MODE}`,
    '',
    'Error:',
    describe(error),
  ];
  if (componentStack) {
    lines.push('', 'Component stack:', componentStack.replace(/^\n+/, ''));
  }
  if (recent.length) {
    lines.push('', 'Recent window errors (oldest first):');
    for (const entry of recent) lines.push(`[${entry.time}] ${entry.text}`);
  }
  return lines.join('\n');
}

/** Forgets the recorded window errors (tests). */
export function clearRecentErrors(): void {
  recent.length = 0;
}
