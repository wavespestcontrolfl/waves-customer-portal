// @vitest-environment jsdom
// Audit repro (round 2, CompletionPanel finder): a termite bait-station visit
// closed as "Customer declined" still POSTs every existing station as
// status 'ok' (the zero-tap default) — the server only skips the station
// sync for visitOutcome === 'incomplete', so a visit where nothing was
// checked writes a "checked OK" termite_station_checks row per station.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage.jsx';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const service = {
  id: 'termite-visit',
  customerId: 'cust-1',
  serviceType: 'Termite Bait Station Monitoring',
  completionProfile: { serviceKey: 'termite', findingsType: 'termite_bait_station' },
  scheduledDate: '2026-09-23',
  status: 'on_site',
  price: 0,
};
let submit;
beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('alert', vi.fn());
  submit = vi.fn().mockRejectedValue(new Error('Synthetic submit'));
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: { 'station-map-v1': true, 'lawn-completion-improvements': false } };
    if (url.includes('property-map')) {
      data = {
        available: true,
        stationsLoaded: true,
        image: { center: { lat: 27.1, lng: -82.4 }, zoom: 20, width: 640, height: 340, url: 'about:blank' },
        stations: [
          { id: 's1', number: 1, program: 'termite', geometryImage: { type: 'circle', cx: 100, cy: 100, r: 6 } },
          { id: 's2', number: 2, program: 'termite', geometryImage: { type: 'circle', cx: 200, cy: 120, r: 6 } },
        ],
        nextStationNumber: 3,
      };
    }
    if (url.includes('completion-actions')) data = { actions: [] };
    if (url.includes('tech-tips')) data = { available: false };
    return { ok: true, json: async () => data };
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('a "Customer declined" termite closeout posts every station as checked ok without a tap', async () => {
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={submit} />);
  const outcome = await screen.findByDisplayValue('Completed');
  fireEvent.change(outcome, { target: { value: 'customer_declined' } });
  // wait for the station registry to load (the payload is only serialized once ready)
  await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('property-map'))).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  fireEvent.click(screen.getAllByRole('button', { name: /complete/i }).at(-1));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const body = submit.mock.calls[0][1];
  expect(body.visitOutcome).toBe('customer_declined');
  // The bug: nothing was tapped, yet both stations ship as 'ok' checks.
  expect(body.termiteStations).toEqual([
    { id: 's1', status: 'ok' },
    { id: 's2', status: 'ok' },
  ]);
  // The customer text still goes out by default on the declined visit.
  expect(body.sendCompletionSms).toBe(true);
});
