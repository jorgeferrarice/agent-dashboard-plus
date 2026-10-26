import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Markdown from '../Markdown';
import { ArtifactFiles } from '../chat';
import { mediaUrl } from '../../../api';

const renderMd = (text: string) =>
  render(<Markdown agentId="a1" text={text} />).container;

describe('Markdown', () => {
  it('shows a local image through the session media endpoint', () => {
    const img = renderMd('![shot](out/a%20b.png)').querySelector('img')!;
    expect(img.getAttribute('src')).toBe(mediaUrl('a1', 'out/a b.png'));
    expect(img.getAttribute('src')).toContain(
      '/agents/a1/media?src=out%2Fa%20b.png',
    );
  });

  it('loads a web image directly, without a referrer', () => {
    const img = renderMd('![x](https://ex.com/a.png)').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://ex.com/a.png');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('plays a linked video', () => {
    const video = renderMd('[demo](/tmp/v.mp4)').querySelector('video')!;
    expect(video.getAttribute('src')).toBe(mediaUrl('a1', '/tmp/v.mp4'));
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('previews a media path written as inline code', () => {
    const md = renderMd('Salvei em `shots/b.webp`.');
    expect(md.querySelector('code')!.textContent).toBe('shots/b.webp');
    expect(md.querySelector('img')!.getAttribute('src')).toBe(
      mediaUrl('a1', 'shots/b.webp'),
    );
  });

  it('shows each media file once per message', () => {
    const md = renderMd(
      '![](/home/u/proj/chart.png)\n\n- `chart.png`\n- `clip.mp4` e de novo `clip.mp4`',
    );
    expect(md.querySelectorAll('img')).toHaveLength(1);
    expect(md.querySelectorAll('video')).toHaveLength(1);
    expect(md.querySelectorAll('code')).toHaveLength(3);
  });

  it('opens web links in a new tab and does not link host files', () => {
    const md = renderMd('[site](https://ex.com) e [código](src/a.py)');
    const links = md.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(md.textContent).toContain('código');
  });

  it('does not render raw HTML', () => {
    const md = renderMd('<img src="x" onerror="alert(1)"> **ok**');
    expect(md.querySelector('img')).toBeNull();
    expect(md.querySelector('strong')!.textContent).toBe('ok');
  });

  it('renders GitHub tables', () => {
    const md = renderMd('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(md.querySelectorAll('td')).toHaveLength(2);
  });

  it('previews a PDF from the host, downloads it, opens it full size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['%PDF']), { status: 200 })),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => 'blob:pdf',
        revokeObjectURL: vi.fn(),
      }),
    );
    const md = renderMd('O relatório: `out/report.pdf`');
    await waitFor(() =>
      expect(md.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf'),
    );
    expect(fetch).toHaveBeenCalledWith(mediaUrl('a1', 'out/report.pdf'), {
      credentials: 'include',
    });
    const link = screen.getByText('Download').closest('a')!;
    expect(link.getAttribute('download')).toBe('report.pdf');
    fireEvent.click(screen.getByLabelText('Show over the whole window'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('iframe')!.getAttribute('src')).toBe(
      'blob:pdf',
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens an HTML page of the host in a sandboxed window; Esc closes it', () => {
    renderMd('Abra `site/index.html`');
    fireEvent.click(screen.getByText('Open page'));
    const frame = screen.getByRole('dialog').querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(mediaUrl('a1', 'site/index.html'));
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens an artifact from the file it was published from', () => {
    const url = 'https://claude.ai/code/artifact/f75bd97e-a6cb';
    render(
      <ArtifactFiles.Provider value={new Map([[url, '/tmp/x/plan.html']])}>
        <Markdown agentId="a1" text={`Publicado: ${url}`} />
      </ArtifactFiles.Provider>,
    );
    fireEvent.click(screen.getByText('Open artifact'));
    expect(
      screen.getByRole('dialog').querySelector('iframe')!.getAttribute('src'),
    ).toBe(mediaUrl('a1', '/tmp/x/plan.html'));
  });
});

afterEach(() => vi.unstubAllGlobals());
