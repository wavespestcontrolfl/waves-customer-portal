// @vitest-environment jsdom
// Tax > Assets > Mileage (accounting audit 2026-10-30): + Add posts the route's
// own field names (tripDate, distanceMiles…), so a normal manual trip saves
// (ACC-03); Sync from Bouncie sends no dates and reports the range the server
// synced (ACC-04).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MileageTab } from './TaxPage.jsx';

let posts;

beforeEach(() => {
  posts = [];
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const json = (data) => ({ ok: true, json: async () => data });
    if (options.method === 'POST') {
      posts.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
      if (path.endsWith('/mileage/sync-bouncie')) {
        return json({ success: true, startDate: '2026-10-25', endDate: '2026-10-31', tripsImported: 2, totalMiles: 18.4, deductionAmount: 12.88, skipped: 1 });
      }
      return json({ success: true, entry: { id: 'mileage-1' } });
    }
    if (path.endsWith('/mileage/stats')) return json({ year: '2026', totalMiles: 0, totalDeduction: 0, tripCount: 0, irsRate: 0.7, byPurpose: [], byMonth: [] });
    return json({ entries: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('+ Add posts the route field names with the typed miles and addresses', async () => {
  render(<MileageTab />);
  await screen.findByText(/No mileage entries yet/);
  fireEvent.change(screen.getByLabelText('From'), { target: { value: 'Shop' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'Job site' } });
  fireEvent.change(screen.getByLabelText('Miles'), { target: { value: '12.5' } });
  fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].path).toBe('/api/admin/tax/mileage');
  expect(posts[0].body).toEqual({
    tripDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    startAddress: 'Shop',
    endAddress: 'Job site',
    distanceMiles: '12.5',
    purpose: 'business',
    notes: '',
  });
});

it('Sync from Bouncie sends no dates and reports the range the server synced', async () => {
  render(<MileageTab />);
  await screen.findByText(/No mileage entries yet/);
  fireEvent.click(screen.getByRole('button', { name: /Sync from Bouncie/ }));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(posts).toEqual([{ path: '/api/admin/tax/mileage/sync-bouncie', body: undefined }]);
  expect(alert.mock.calls[0][0]).toMatch(/^Bouncie sync \(2026-10-25 to 2026-10-31\): 2 trips imported/);
});
