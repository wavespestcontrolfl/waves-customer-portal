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
