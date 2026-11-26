// @vitest-environment jsdom
// A visual note waits up to 1.4 s for the location before its upload starts,
// so no save is open yet. It holds an out-of-date tab's reload until it
// settles (lib/reloadHolds.js).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisualNotesPanel from './VisualNotesPanel';
import { reloadHoldNames } from '../../lib/reloadHolds';

let located;
const posts = [];

beforeEach(() => {
  posts.length = 0;
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (success) => { located = success; } },
  });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'POST') posts.push(String(url));
    return { ok: true, status: 200, json: async () => ({ moments: [] }) };
  }));
});

afterEach(() => {
  cleanup();
  delete navigator.geolocation;
  vi.unstubAllGlobals();
});

it('holds an out-of-date tab reload from Save moment while the location is read, until the upload settles', async () => {
  render(<VisualNotesPanel service={{ id: 'svc-1' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Weeds' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save moment' }));
  expect(reloadHoldNames()).toContain('visual-note');
  expect(posts).toEqual([]);
  await act(async () => located({ coords: { latitude: 27.1, longitude: -82.4 } }));
  await waitFor(() => expect(reloadHoldNames()).not.toContain('visual-note'));
  expect(posts).toEqual([expect.stringContaining('/api/jobs/svc-1/visual-moments')]);
});

it('shows the weekly clip line, and the OK-to-post box only for a clip', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('clip-week')
      ? { weekStart: '2026-11-23', okClips: 2, goalMin: 1, goalMax: 3 }
      : { moments: [{ id: 'm1', tagLabel: 'Weeds', mediaType: 'video', visibilityStatus: 'internal_only', youtubeOk: true }] }),
  }));
  const { container } = render(<VisualNotesPanel service={{ id: 'svc-1' }} />);
  expect(await screen.findByText('2 of 1-3')).toBeTruthy();
  expect(await screen.findByText('OK to post')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Weeds' }));
  expect(screen.queryByText(/OK to post on the Waves YouTube channel/)).toBeNull();
  const video = container.querySelector('input[accept="video/*"]');
  fireEvent.change(video, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } });
  expect(screen.getByText(/OK to post on the Waves YouTube channel/)).toBeTruthy();
  expect(screen.getByText(/no faces, house numbers, car plates, gate codes/)).toBeTruthy();
});

it('hides the clip line when the week endpoint fails', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => (String(url).includes('clip-week')
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ moments: [] }) }));
  render(<VisualNotesPanel service={{ id: 'svc-1' }} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/Clips OK to post this week/)).toBeNull();
});
