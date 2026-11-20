// @vitest-environment jsdom
// A punch with the location waits up to 7 s for it before its request starts,
// so no save is open yet. Each punch holds an out-of-date tab's reload until
// it settles, at any page move (lib/reloadHolds.js).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TechTimeTrackingCard from './TechTimeTrackingCard';
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
    return { ok: true, status: 200, json: async () => ({ clockedIn: false, onBreak: false, currentJob: null, todaySummary: { shiftMinutes: 0, jobCount: 0 } }) };
  }));
});

afterEach(() => {
  cleanup();
  delete navigator.geolocation;
  vi.unstubAllGlobals();
});

it('holds an out-of-date tab reload from Clock in while the location is read, until the punch settles', async () => {
  render(<TechTimeTrackingCard nextStop={null} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Clock in' }));
  expect(reloadHoldNames()).toContain('time-clock');
  expect(posts).toEqual([]);
  await act(async () => located({ coords: { latitude: 27.1, longitude: -82.4 } }));
  await waitFor(() => expect(reloadHoldNames()).not.toContain('time-clock'));
  expect(posts).toEqual([expect.stringContaining('/api/tech/timetracking/clock-in')]);
});
