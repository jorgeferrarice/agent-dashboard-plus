import { describe, it, expect } from 'vitest';
import type { AxiosAdapter } from 'axios';
import api from '../api';

const answer =
  (type: string, data: unknown): AxiosAdapter =>
  async (config) => ({
    data,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': type },
    config,
  });

describe('api client', () => {
  it('rejects an HTML answer: the route is not proxied', async () => {
    await expect(
      api.get('/tasks', { adapter: answer('text/html', '<!doctype html>') }),
    ).rejects.toThrow('/tasks returned HTML instead of JSON');
  });

  it('passes JSON through', async () => {
    const res = await api.get('/tasks', {
      adapter: answer('application/json', []),
    });
    expect(res.data).toEqual([]);
  });
});
