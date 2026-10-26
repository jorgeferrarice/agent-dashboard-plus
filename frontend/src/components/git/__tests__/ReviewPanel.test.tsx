import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PullRequest, Review, ReviewComment } from '../../../gitApi';

let saved: Review | null = null;
let runs = 0;
let inline = true;
const posted: [string, ReviewComment][] = [];
const fresh: Review = {
  pr_id: 'github:1:acme/app:7',
  model: 'claude-sonnet-5-5',
  created_at: '2026-10-24T12:00:00Z',
  summary: 'Resumo do review.',
  verdict: 'request_changes',
  language: 'pt-BR',
  comments: [
    { path: 'src/a.py', line: 12, body: 'Trate o erro aqui.' },
    { path: null, line: null, body: 'Faltam testes.' },
  ],
};
vi.mock('../../../gitApi', () => ({
  getReview: async () => saved,
  runReview: async () => {
    runs++;
    return fresh;
  },
  postComment: async (prId: string, comment: ReviewComment) => {
    posted.push([prId, comment]);
    return { url: 'https://github.com/acme/app/pull/7#c1', inline };
  },
}));

import ReviewPanel from '../ReviewPanel';

const pr: PullRequest = {
  id: 'github:1:acme/app:7',
  provider: 'github',
  connection_id: 1,
  connection_name: 'GitHub',
  repo: 'acme/app',
  number: 7,
  title: 'Add retries',
  state: 'open',
  roles: ['reviewer'],
};

const settle = () => act(async () => {});

beforeEach(() => {
  saved = null;
  runs = 0;
  inline = true;
  posted.length = 0;
});

describe('ReviewPanel', () => {
  it('starts a review when none is saved, and posts nothing by itself', async () => {
    render(<ReviewPanel pr={pr} onClose={() => {}} />);
    await settle();
    expect(runs).toBe(1);
    expect(screen.getByText('Resumo do review.')).toBeInTheDocument();
    expect(screen.getByText('src/a.py:12')).toBeInTheDocument();
    expect(screen.getByText('General comment')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('shows a saved review without running a new one', async () => {
    saved = { ...fresh, summary: 'Saved summary.' };
    render(<ReviewPanel pr={pr} onClose={() => {}} />);
    await settle();
    expect(runs).toBe(0);
    expect(screen.getByText('Saved summary.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Review again/ }));
    await settle();
    expect(runs).toBe(1);
    expect(screen.getByText('Resumo do review.')).toBeInTheDocument();
  });

  it('posts the edited text of the clicked suggestion only', async () => {
    render(<ReviewPanel pr={pr} onClose={() => {}} />);
    await settle();
    fireEvent.change(screen.getByLabelText('Comment on src/a.py:12'), {
      target: { value: 'Texto editado.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Post' })[0]);
    await settle();
    expect(posted).toEqual([
      [pr.id, { body: 'Texto editado.', path: 'src/a.py', line: 12 }],
    ]);
    expect(screen.getByText('Posted')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment on src/a.py:12')).toBeDisabled();
    // The other suggestion is still waiting for its own click.
    expect(screen.getAllByRole('button', { name: 'Post' })).toHaveLength(1);
  });

  it('says when a line comment went in as a general one', async () => {
    inline = false;
    render(<ReviewPanel pr={pr} onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: 'Post' })[0]);
    await settle();
    expect(screen.getByText(/posted as a general comment/)).toBeInTheDocument();
  });
});
