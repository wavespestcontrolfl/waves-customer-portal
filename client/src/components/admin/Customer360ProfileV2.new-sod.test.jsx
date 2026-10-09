// @vitest-environment jsdom
/**
 * Customer 360 → Property → Access & Preferences → New sod.
 *
 * The office records sod someone else laid; later visits hold products from it.
 * This pins what the form sends and shows: the sod date, the covers choice with
 * "Where" only for part of the lawn, confirmedAsOf taken from the stamp the form
 * rendered from, the server's refusal message, the server-computed hold lines,
 * and the last Waves pre-emergent with its under-12-weeks warning.
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

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const MOVED_AT = '2026-10-08T15:00:00.000Z';
const BASE_PREFS = {
  id: 'pref-1',
  customer_id: 'customer-a',
  irrigation_home_changed_at: MOVED_AT,
  sod_laid_on: null,
  sod_covers: null,
  sod_area: null,
  sod_rooted_on: null,
};

function customerDetail(prefsOverride = {}) {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' },
      active: true,
    },
    notificationPrefs: {},
    preferences: { ...BASE_PREFS, ...prefsOverride },
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [],
    annualPrepayTerms: [],
  };
}

const NEW_SOD = {
  holdLines: [],
  lastPreEmergent: { date: '2026-08-10', dateText: 'Aug 10, 2026', product: 'LESCO Dimension 0.25% Granular' },
  preEmergentWarning: null,
};

// A fetch stub: the customer detail, the new-sod lines, and a PUT handler.
function stubFetch({ prefs = {}, newSod = NEW_SOD, newSodFails = false, onPut } = {}) {
  const fetchMock = vi.fn((url, options) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path.includes('/admin/customers/customer-a/new-sod')) {
      if (newSodFails) return Promise.reject(new Error('network'));
      const value = typeof newSod === 'function' ? newSod(path) : newSod;
      // A function may return a promise (a held request).
      return typeof value?.then === 'function' ? value.then((body) => response({ newSod: body })) : response({ newSod: value });
    }
    if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
      return onPut(JSON.parse(options.body), options);
    }
    if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail(prefs));
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const putCalls = (fetchMock) => fetchMock.mock.calls
  .filter(([u, o]) => String(u).endsWith('/property-preferences') && o?.method === 'PUT')
  .map(([, o]) => JSON.parse(o.body));

async function openEditor() {
  render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
  await screen.findAllByText('Avery Customer');
  fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
  await screen.findByText('Access & Preferences');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
  await screen.findByText('New sod');
}

const dateInput = () => screen.getByText('Sod laid on').closest('label').querySelector('input');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

describe('Customer 360 → Access & Preferences → New sod', () => {
  it('saves a whole-lawn sod date with confirmedAsOf from the rendered stamp, and no Where field', async () => {
    const fetchMock = stubFetch({
      onPut: () => response({ success: true, saved: true, preferences: { ...BASE_PREFS, sod_laid_on: '2026-10-01' } }),
    });
    await openEditor();

    expect(screen.queryByText('Where')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Whole lawn')).toBeChecked();
    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(putCalls(fetchMock)[0]).toEqual({
      sodLaidOn: '2026-10-01',
      sodCovers: null,
      sodArea: '',
      confirmedAsOf: MOVED_AT,
    });
  });

  it('Part of lawn shows Where (max 120) and sends covers and area with the date', async () => {
    const fetchMock = stubFetch({
      onPut: () => response({ success: true, saved: true, preferences: BASE_PREFS }),
    });
    await openEditor();

    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByLabelText('Part of lawn'));
    const where = screen.getByText('Where').closest('label').querySelector('input');
    expect(where).toHaveAttribute('maxlength', '120');
    fireEvent.change(where, { target: { value: 'back lawn by the pool' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(putCalls(fetchMock)[0]).toMatchObject({
      sodLaidOn: '2026-10-01',
      sodCovers: 'part',
      sodArea: 'back lawn by the pool',
      confirmedAsOf: MOVED_AT,
    });
  });

  it('sends the stamp as null when the home never changed, and sends no sod fields for another edit', async () => {
    const fetchMock = stubFetch({
      prefs: { irrigation_home_changed_at: null, access_notes: 'old' },
      onPut: () => response({ success: true, saved: true, preferences: BASE_PREFS }),
    });
    await openEditor();

    const notes = screen.getByText('Access Notes').closest('label').querySelector('textarea');
    fireEvent.change(notes, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(putCalls(fetchMock)[0]).toEqual({ accessNotes: 'new' });
  });

  it('shows the server refusal under the sod date and keeps the form open', async () => {
    const message = 'The home on this customer changed. Reload the customer, then make the sod change again.';
    stubFetch({
      onPut: () => response({ error: message, rejected: [{ field: 'sodLaidOn', message }] }, 400),
    });
    await openEditor();

    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const shown = await screen.findAllByText(message);
    expect(shown.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('a saved record can be cleared: Clear sod record sends nulls for all three fields', async () => {
    const fetchMock = stubFetch({
      prefs: { sod_laid_on: '2026-09-20', sod_covers: 'part', sod_area: 'front yard' },
      onPut: () => response({ success: true, saved: true, preferences: BASE_PREFS }),
    });
    await openEditor();

    expect(dateInput()).toHaveValue('2026-09-20');
    fireEvent.click(screen.getByRole('button', { name: 'Clear sod record' }));
    expect(dateInput()).toHaveValue('');
    expect(screen.queryByText('Where')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(putCalls(fetchMock)[0]).toMatchObject({ sodLaidOn: null, sodCovers: null, sodArea: '' });
  });

  it('there is no Clear sod record action when no record exists', async () => {
    stubFetch({ onPut: () => response({}) });
    await openEditor();
    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    expect(screen.queryByRole('button', { name: 'Clear sod record' })).not.toBeInTheDocument();
  });

  it('shows the three hold lines the server computed, and the last pre-emergent', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole' },
      newSod: {
        ...NEW_SOD,
        holdLines: [
          { key: 'fertilizer', active: true, text: 'Fertilizer is held until Oct 31, 2026.' },
          { key: 'weedKiller', active: true, text: 'Weed killer is held until Oct 31, 2026 and until the technician confirms the sod is rooted.' },
          { key: 'preEmergent', active: true, text: 'Pre-emergent is held until Oct 1, 2027.' },
        ],
      },
      onPut: () => response({}),
    });
    await openEditor();

    expect(await screen.findByText('Fertilizer is held until Oct 31, 2026.')).toBeInTheDocument();
    expect(screen.getByText('Pre-emergent is held until Oct 1, 2027.')).toBeInTheDocument();
    expect(screen.getByText(/Weed killer is held until Oct 31, 2026 and until the technician confirms/)).toBeInTheDocument();
    expect(await screen.findByText('Last pre-emergent by Waves: Aug 10, 2026 (LESCO Dimension 0.25% Granular)')).toBeInTheDocument();
  });

  it('the hold lines are hidden once a sod field is edited: they describe the saved record only', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSod: { ...NEW_SOD, holdLines: [{ key: 'fertilizer', active: true, text: 'Fertilizer is held until Oct 31, 2026.' }] },
      onPut: () => response({}),
    });
    await openEditor();
    expect(await screen.findByTestId('sod-hold-lines')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Part of lawn'));
    expect(screen.queryByTestId('sod-hold-lines')).not.toBeInTheDocument();
    expect(screen.getByTestId('sod-hold-lines-stale')).toHaveTextContent('Save to see the hold dates for this change.');
  });

  it('the read view shows the saved record and its hold lines', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'part', sod_area: 'back lawn' },
      newSod: { ...NEW_SOD, holdLines: [{ key: 'preEmergent', active: true, text: 'Pre-emergent is held until Oct 1, 2027.' }] },
      onPut: () => response({}),
    });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByText('New sod')).toBeInTheDocument();
    expect(screen.getByText('Part of lawn: back lawn')).toBeInTheDocument();
    expect(await screen.findByText('Pre-emergent is held until Oct 1, 2027.')).toBeInTheDocument();
  });

  it('the read view keeps the saved record\'s 12-week warning, so a fast save cannot hide it', async () => {
    const warning = 'Pre-emergent was applied less than 12 weeks before this sod. Tell the customer.';
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSod: { ...NEW_SOD, preEmergentWarning: warning },
      onPut: () => response({}),
    });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByTestId('sod-read-warning')).toHaveTextContent(warning);
  });

  it('while the summary is loading the read view says so, and shows no lines from an earlier answer', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSod: () => gate.then(() => ({ ...NEW_SOD, holdLines: [{ key: 'fertilizer', active: true, text: 'Fertilizer is held until Oct 31, 2026.' }] })),
      onPut: () => response({}),
    });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByTestId('sod-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('sod-hold-lines')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Fertilizer is held until Oct 31, 2026.')).toBeInTheDocument();
    expect(screen.queryByTestId('sod-loading')).not.toBeInTheDocument();
  });

  it('a failed sod read is stated on the read view, never shown as no warning', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSodFails: true,
      onPut: () => response({}),
    });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByText('Pre-emergent history could not be read. Check the service history.')).toBeInTheDocument();
  });

  it('says so when Waves has no pre-emergent on record, and shows the server warning for the typed date', async () => {
    const WARNING = 'Pre-emergent was applied less than 12 weeks before this sod. Tell the customer.';
    const fetchMock = stubFetch({
      newSod: (path) => (path.includes('sodLaidOn=2026-10-01')
        ? { ...NEW_SOD, preEmergentWarning: WARNING }
        : { holdLines: [], lastPreEmergent: null, preEmergentWarning: null }),
      onPut: () => response({}),
    });
    await openEditor();

    expect(await screen.findByText('No pre-emergent by Waves on record')).toBeInTheDocument();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();

    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/new-sod?sodLaidOn=2026-10-01'))).toBe(true);
  });

  it('a technician sees no new-sod fields and never calls the office-only endpoint', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    // A saved record: the read view must not show it to a technician either.
    const fetchMock = stubFetch({ prefs: { sod_laid_on: '2026-10-01', sod_covers: 'part', sod_area: 'Back yard strip' }, onPut: () => response({}) });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    await screen.findByText('Access & Preferences');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/new-sod'))).toBe(false);
    expect(screen.queryByText('New sod')).not.toBeInTheDocument();
    expect(screen.queryByText('Sod Laid On')).not.toBeInTheDocument();
    expect(screen.queryByText(/Back yard strip/)).not.toBeInTheDocument();
  });
});
