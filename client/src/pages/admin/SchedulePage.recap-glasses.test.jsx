// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PestRecapCard } from './SchedulePage';

let glassesFlag = false;
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: (name) => ({ enabled: name === 'recap-glasses-v1' && glassesFlag, ready: true }),
}));

const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

// recapState is what GET /recap-video answers; confirming or removing a clip re-queues the recap (the server does the same).
function stubServer(recapState, items = []) {
  const calls = [];
  const fetchMock = vi.fn(async (url, options = {}) => {
    const path = String(url).replace(/^.*\/api/, '');
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.endsWith('/recap-video/file')) return json({}, false);
    if (path.endsWith('/recap-video')) return json(recapState.current);
    if (path.endsWith('/recap-media/presign')) return json({ mediaId: 'media-1', uploadUrl: 'https://upload.test/media-1' });
    if (path.endsWith('/recap-media/media-1/confirm')) { recapState.current = { exists: true, status: 'pending' }; return json({ ok: true, id: 'media-1', status: 'ready' }); }
    if (path.endsWith('/recap-media/media-9') && options.method === 'DELETE') { recapState.current = { exists: true, status: 'pending' }; return json({ ok: true }); }
    if (path.endsWith('/recap-media')) return json({ items });
    if (String(url).startsWith('https://upload.test')) return json({});
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  glassesFlag = false;
  localStorage.clear();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    if (tag !== 'video') return realCreate(tag, options);
    const video = { preload: '', duration: 45 };
    Object.defineProperty(video, 'src', { set() { setTimeout(() => video.onloadedmetadata(), 0); } });
    return video;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const READY = { exists: true, status: 'ready', ready: true, approved: false, sent: false, lateClips: true };

describe('PestRecapCard late clips (recap-glasses-v1)', () => {
  it('offers no capture without the flag', async () => {
    stubServer({ current: READY });
    render(<PestRecapCard serviceId="visit-1" />);
    await screen.findByText('Approve & send');
    expect(screen.queryByRole('button', { name: 'From Photos' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recap clips')).not.toBeInTheDocument();
  });

  it('offers no capture while the server gate is off, even with the flag', async () => {
    glassesFlag = true;
    stubServer({ current: { ...READY, lateClips: false } });
    render(<PestRecapCard serviceId="visit-1" />);
    await screen.findByText('Approve & send');
    expect(screen.queryByRole('button', { name: 'From Photos' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recap clips')).not.toBeInTheDocument();
  });

  it('removing a clip from an unapproved recap shows the re-render', async () => {
    glassesFlag = true;
    const calls = stubServer({ current: READY }, [{ id: 'media-9', role: 'perimeter', media_type: 'video', status: 'ready' }]);
    render(<PestRecapCard serviceId="visit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '×' }));

    expect(await screen.findByText(/Rendering the recap/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/recap-media/media-9'))).toBe(true);
  });

  it('does not offer a late clip once the recap is approved', async () => {
    glassesFlag = true;
    stubServer({ current: { ...READY, status: 'approved', approved: true } });
    render(<PestRecapCard serviceId="visit-1" />);
    await screen.findByText(/Approved/);
    expect(screen.queryByRole('button', { name: 'From Photos' })).not.toBeInTheDocument();
  });

  it('adds a library clip to an unapproved recap and shows the re-render', async () => {
    glassesFlag = true;
    const calls = stubServer({ current: READY });
    render(<PestRecapCard serviceId="visit-1" />);
    await screen.findByRole('button', { name: 'From Photos' });

    const inputs = document.querySelectorAll('input[type="file"]');
    const library = Array.from(inputs).find((input) => !input.hasAttribute('capture'));
    expect(library).toHaveAttribute('accept', 'video/*');
    fireEvent.change(library, { target: { files: [new File(['clip'], 'glasses.mp4', { type: 'video/mp4' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Spray — perimeter' }));

    expect(await screen.findByText(/Rendering the recap/)).toBeInTheDocument();
    const confirm = calls.find((c) => c.path.endsWith('/media-1/confirm'));
    expect(JSON.parse(confirm.body)).toMatchObject({ durationMs: 45000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'From Photos' })).not.toBeInTheDocument());
  });
});
