import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../ErrorBoundary';
import {
  buildErrorReport,
  clearRecentErrors,
  recordWindowErrors,
} from '../../errorReport';

let broken = true;

function TasksBoard() {
  if (broken)
    throw new TypeError("Cannot read properties of undefined (reading 'map')");
  return <p>board ok</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    broken = true;
    clearRecentErrors();
    document.documentElement.lang = 'pt-BR';
    // React logs caught render errors; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the error and a report in place of a broken tab', () => {
    render(
      <div>
        <ErrorBoundary where="Tasks tab">
          <TasksBoard />
        </ErrorBoundary>
        <p>other tab</p>
      </div>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Esta aba encontrou um erro')).toBeTruthy();
    expect(
      screen.getByText(/TypeError: Cannot read properties/, { selector: 'p' }),
    ).toBeTruthy();
    // The rest of the page keeps working.
    expect(screen.getByText('other tab')).toBeTruthy();

    const log = (screen.getByLabelText('Log do erro') as HTMLTextAreaElement)
      .value;
    expect(log).toContain('Where: Tasks tab');
    expect(log).toContain("reading 'map'");
    expect(log).toContain('Component stack:');
    expect(log).toContain('TasksBoard');
  });

  it('renders the tab again on "try again"', () => {
    render(
      <ErrorBoundary where="Tasks tab">
        <TasksBoard />
      </ErrorBoundary>,
    );
    broken = false;
    fireEvent.click(screen.getByText('Tentar de novo'));
    expect(screen.getByText('board ok')).toBeTruthy();
  });

  it('fills the screen and offers a reload for the whole app', () => {
    render(
      <ErrorBoundary where="Whole dashboard" fullScreen>
        <TasksBoard />
      </ErrorBoundary>,
    );
    expect(screen.getByText('O painel encontrou um erro')).toBeTruthy();
    expect(screen.getByText('Recarregar página')).toBeTruthy();
  });

  it('copies the report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <ErrorBoundary where="Tasks tab">
        <TasksBoard />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Copiar log'));
    expect(writeText.mock.calls[0][0]).toContain(
      'Agent Dashboard error report',
    );
    expect(await screen.findByText('Copiado!')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('buildErrorReport', () => {
  it('includes recent window errors and leaves out the query string', () => {
    clearRecentErrors();
    recordWindowErrors();
    window.history.replaceState(null, '', '/?code=secret#x');
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('socket blew up'),
        message: 'x',
      }),
    );
    const report = buildErrorReport('Tasks tab', new Error('boom'));
    expect(report).toContain('Recent window errors');
    expect(report).toContain('Error: socket blew up');
    expect(report).not.toContain('secret');
    window.history.replaceState(null, '', '/');
  });
});
