// @vitest-environment jsdom
/**
 * Customer 360 → Property → Access & Preferences → Away Watch (GATE_AWAY_WATCH). The admin GET carries awayWatchEnabled
 * only while the gate is live; the dates show and edit beside the blackout dates, and the pair travels together.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => null }));
vi.mock('./CallBridgeLink', () => ({
  default: ({ children }) => <span>{children}</span>,
  callViaBridge: vi.fn(),
}));
vi.mock('../../pages/admin/SchedulePage', () => ({
  ZoneMarkingStep: () => null,
  StationMarkingStep: () => null,
}));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const response = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

const PREFS = { id: 'pref-1', customer_id: 'customer-a', garage_code: '2299', preferred_day: 'monday', preferred_time: 'morning', contact_preference: 'text' };

function detail({ enabled, prefs = {} }) {
  return {
    customer: { id: 'customer-a', firstName: 'Avery', lastName: 'Customer', address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' }, active: true },
    ...(enabled ? { awayWatchEnabled: true } : {}),
    notificationPrefs: {}, preferences: { ...PREFS, ...prefs }, healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [], annualPrepayTerms: [],
  };
}

function stubFetch(detailBody, onPut) {
  const fetchMock = vi.fn((url, options) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path.endsWith('/admin/customers/customer-a/property-preferences')) return onPut(JSON.parse(options.body));
    if (path.endsWith('/admin/customers/customer-a')) return response(detailBody);
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openEditor() {
  render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
  await screen.findAllByText('Avery Customer');
  fireEvent.click(await screen.findByRole('tab', { name: 'Property' }));
  await screen.findByText('Access & Preferences');
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

describe('Customer 360 Away Watch dates', () => {
  it('gate off: no Away Watch row and no inputs', async () => {
    stubFetch(detail({ enabled: false }), () => response({}));
    await openEditor();
    expect(screen.queryByText('Away Watch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    await screen.findByText('Blackout Start');
    expect(screen.queryByText('Away Watch: leaves')).toBeNull();
  });

  it('gate on: the saved window reads as a range, or Not set', async () => {
    stubFetch(detail({ enabled: true, prefs: { away_watch_from: '2026-06-01', away_watch_until: '2026-09-15' } }), () => response({}));
    await openEditor();
    expect(await screen.findByText('Away Watch')).toBeInTheDocument();
    expect(screen.getByText('2026-06-01 – 2026-09-15')).toBeInTheDocument();
  });

  it('gate on: entering the two days sends both together, and nothing else', async () => {
    const puts = [];
    stubFetch(detail({ enabled: true }), (body) => { puts.push(body); return response({ success: true, saved: true, preferences: { ...PREFS, away_watch_from: body.awayWatchFrom, away_watch_until: body.awayWatchUntil } }); });
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const from = (await screen.findByText('Away Watch: leaves')).closest('label').querySelector('input');
    fireEvent.change(from, { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    // Only one date was typed, yet the pair travels together so the server can judge it whole.
    expect(puts[0]).toEqual({ awayWatchFrom: '2026-06-01', awayWatchUntil: null });
  });

  it('gate on: a refusal from the server shows under the dates', async () => {
    stubFetch(detail({ enabled: true }), () => response({ success: true, saved: true, preferences: PREFS, rejected: [{ field: 'awayWatchUntil', message: 'Away dates must be set or cleared together.' }] }));
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const from = (await screen.findByText('Away Watch: leaves')).closest('label').querySelector('input');
    fireEvent.change(from, { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Away dates must be set or cleared together.')).length).toBeGreaterThan(0);
  });
});
