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

const NEW_SOD = { holdLines: [] };

// A fetch stub: the customer detail, the new-sod lines, and a PUT handler.
function stubFetch({ prefs = {}, newSod = NEW_SOD, newSodFails = false, onPut } = {}) {
  const fetchMock = vi.fn((url, options) => {
    const path = String(url);
    if (path.endsWith('/admin/payers')) return response({ payers: [] });
    if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
    if (path.includes('/admin/customers/customer-a/new-sod')) {
      if (newSodFails) return Promise.reject(new Error('network'));
      const value = typeof newSod === 'function' ? newSod(path) : newSod;
      // The server answers with the record the lines were built from: here, the profile's record unless a test names another.
      const row = { ...BASE_PREFS, ...prefs };
      const withRecord = (body) => ({
        record: { sod_laid_on: row.sod_laid_on, sod_covers: row.sod_covers, sod_area: row.sod_area },
        ...body,
      });
      // A function may return a promise (a held request).
      return typeof value?.then === 'function'
        ? value.then((body) => response({ newSod: withRecord(body) }))
        : response({ newSod: withRecord(value) });
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
    // Only the date changed: covers and area are not sent (the server keeps the stored values).
    expect(putCalls(fetchMock)[0]).toEqual({ sodLaidOn: '2026-10-01', confirmedAsOf: MOVED_AT });
  });

  it('a new record with Part of lawn shows Where (max 120) and sends all three sod fields', async () => {
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

  it('a save that rejects one sod field keeps every sod field unsaved, so the retry sends them all', async () => {
    const message = 'Say where the new sod is.';
    let puts = 0;
    const fetchMock = stubFetch({
      prefs: { sod_laid_on: '2026-09-20', sod_covers: 'whole', access_notes: 'old' },
      onPut: () => {
        puts += 1;
        return puts === 1
          ? response({ success: true, saved: true, rejected: [{ field: 'sodArea', message }], preferences: BASE_PREFS })
          : response({ success: true, saved: true, preferences: BASE_PREFS });
      },
    });
    await openEditor();

    const notes = screen.getByText('Access Notes').closest('label').querySelector('textarea');
    fireEvent.change(notes, { target: { value: 'new' } });
    fireEvent.click(screen.getByLabelText('Part of lawn'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    await screen.findAllByText(message);

    const where = screen.getByText('Where').closest('label').querySelector('input');
    fireEvent.change(where, { target: { value: 'back lawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(2));
    // The first save stored the notes only: the retry carries Covers again with Where.
    expect(putCalls(fetchMock)[1]).toEqual({ sodCovers: 'part', sodArea: 'back lawn', confirmedAsOf: MOVED_AT });
  });

  describe('partial payloads on a saved record: only the sod fields changed in this edit are sent', () => {
    const saved = (extra = {}) => ({ sod_laid_on: '2026-09-20', sod_covers: 'whole', sod_area: null, ...extra });
    const saveWith = async (prefs, edit) => {
      const fetchMock = stubFetch({ prefs, onPut: () => response({ success: true, saved: true, preferences: BASE_PREFS }) });
      await openEditor();
      edit();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
      return putCalls(fetchMock)[0];
    };

    it('Covers whole to part with Where typed sends covers and area, not the date', async () => {
      const body = await saveWith(saved(), () => {
        fireEvent.click(screen.getByLabelText('Part of lawn'));
        const where = screen.getByText('Where').closest('label').querySelector('input');
        fireEvent.change(where, { target: { value: 'back lawn by the pool' } });
      });
      expect(body).toEqual({ sodCovers: 'part', sodArea: 'back lawn by the pool', confirmedAsOf: MOVED_AT });
    });

    it('changing only the date sends the date alone', async () => {
      const body = await saveWith(saved({ sod_covers: 'part', sod_area: 'front yard' }), () => {
        fireEvent.change(dateInput(), { target: { value: '2026-09-25' } });
      });
      expect(body).toEqual({ sodLaidOn: '2026-09-25', confirmedAsOf: MOVED_AT });
    });

    it('changing only Where sends the area alone', async () => {
      const body = await saveWith(saved({ sod_covers: 'part', sod_area: 'front yard' }), () => {
        const where = screen.getByText('Where').closest('label').querySelector('input');
        fireEvent.change(where, { target: { value: 'side yard' } });
      });
      expect(body).toEqual({ sodArea: 'side yard', confirmedAsOf: MOVED_AT });
    });

    it('Part of lawn back to Whole lawn sends covers alone (the server drops the area)', async () => {
      const body = await saveWith(saved({ sod_covers: 'part', sod_area: 'front yard' }), () => {
        fireEvent.click(screen.getByLabelText('Whole lawn'));
      });
      expect(body).toEqual({ sodCovers: 'whole', confirmedAsOf: MOVED_AT });
    });

    it('Clear sod record sends the date as null alone: the server clears the whole record', async () => {
      const prefs = saved({ sod_covers: 'part', sod_area: 'front yard' });
      const fetchMock = stubFetch({ prefs, onPut: () => response({ success: true, saved: true, preferences: BASE_PREFS }) });
      await openEditor();

      expect(dateInput()).toHaveValue('2026-09-20');
      fireEvent.click(screen.getByRole('button', { name: 'Clear sod record' }));
      expect(dateInput()).toHaveValue('');
      expect(screen.queryByText('Where')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
      expect(putCalls(fetchMock)[0]).toEqual({ sodLaidOn: null, confirmedAsOf: MOVED_AT });
    });

    it('after an accepted clear with another field rejected, the retry sends no sod field', async () => {
      const prefs = saved({ sod_covers: 'part', sod_area: 'front yard', access_notes: 'old' });
      const message = 'Access notes are too long.';
      let puts = 0;
      const fetchMock = stubFetch({
        prefs,
        onPut: () => {
          puts += 1;
          return puts === 1
            ? response({ success: true, saved: true, rejected: [{ field: 'accessNotes', message }], preferences: BASE_PREFS })
            : response({ success: true, saved: true, preferences: BASE_PREFS });
        },
      });
      await openEditor();

      const notes = () => screen.getByText('Access Notes').closest('label').querySelector('textarea');
      fireEvent.change(notes(), { target: { value: 'too long' } });
      fireEvent.click(screen.getByRole('button', { name: 'Clear sod record' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
      await screen.findAllByText(message);

      fireEvent.change(notes(), { target: { value: 'short' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(2));
      // Covers and Where were cleared by the first save: they are not sent again.
      expect(putCalls(fetchMock)[1]).toEqual({ accessNotes: 'short' });
    });

    it('a typed-out date with another field rejected: the form takes Covers from the server answer', async () => {
      const prefs = saved({ sod_covers: 'part', sod_area: 'front yard', access_notes: 'old' });
      const message = 'Access notes are too long.';
      let puts = 0;
      const fetchMock = stubFetch({
        prefs,
        onPut: () => {
          puts += 1;
          return puts === 1
            ? response({ success: true, saved: true, rejected: [{ field: 'accessNotes', message }], preferences: BASE_PREFS })
            : response({ success: true, saved: true, preferences: BASE_PREFS });
        },
      });
      await openEditor();

      const notes = () => screen.getByText('Access Notes').closest('label').querySelector('textarea');
      fireEvent.change(notes(), { target: { value: 'too long' } });
      fireEvent.change(dateInput(), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
      await screen.findAllByText(message);

      // The server cleared Covers and Where with the date: the form shows that.
      await waitFor(() => expect(screen.getByLabelText('Whole lawn')).toBeChecked());
      expect(screen.queryByText('Where')).not.toBeInTheDocument();

      fireEvent.change(notes(), { target: { value: 'short' } });
      fireEvent.change(dateInput(), { target: { value: '2026-10-02' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(2));
      expect(putCalls(fetchMock)[1]).toEqual({ accessNotes: 'short', sodLaidOn: '2026-10-02', confirmedAsOf: MOVED_AT });
    });
  });

  it('there is no Clear sod record action when no record exists', async () => {
    stubFetch({ onPut: () => response({}) });
    await openEditor();
    fireEvent.change(dateInput(), { target: { value: '2026-10-01' } });
    expect(screen.queryByRole('button', { name: 'Clear sod record' })).not.toBeInTheDocument();
  });

  it('shows the three hold lines the server computed', async () => {
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

  it('hold lines built from a record another person changed are not shown beside the old record', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSod: {
        record: { sod_laid_on: '2026-10-05', sod_covers: 'part', sod_area: 'front yard' },
        holdLines: [{ key: 'fertilizer', active: false, text: 'Fertilizer is not held. The new sod covers only part of the lawn.' }],
      },
      onPut: () => response({}),
    });
    await openEditor();
    expect(await screen.findByTestId('sod-stale')).toHaveTextContent('The sod record changed. Reload the customer to see the hold dates.');
    expect(screen.queryByText(/Fertilizer is not held/)).not.toBeInTheDocument();
  });

  describe('last pre-emergent by Waves (the server builds both strings)', () => {
    const LINE = 'Last pre-emergent by Waves: Dimension 2EW, Aug 1, 2026 (61 days before the sod date).';
    const WARNING = 'Its label delays seeding or sprigging 12 weeks (Dimension 2EW: 3 months) after treatment. Sod laid on treated soil may root slowly. Tell the customer in writing today.';

    it('prints the line and the warning in the edit form, with no saved sod record needed', async () => {
      stubFetch({ newSod: { holdLines: [], lastPreEmergent: { line: LINE, warning: WARNING } }, onPut: () => response({}) });
      await openEditor();
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      expect(screen.getByTestId('sod-pre-emergent-warning')).toHaveTextContent(WARNING);
    });

    it('prints only the line when the server sends no warning', async () => {
      stubFetch({ newSod: { holdLines: [], lastPreEmergent: { line: LINE, warning: null } }, onPut: () => response({}) });
      await openEditor();
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      expect(screen.queryByTestId('sod-pre-emergent-warning')).not.toBeInTheDocument();
    });

    it('prints nothing when the server found none', async () => {
      stubFetch({ newSod: { holdLines: [], lastPreEmergent: null }, onPut: () => response({}) });
      await openEditor();
      await waitFor(() => expect(screen.queryByTestId('sod-loading')).not.toBeInTheDocument());
      expect(screen.queryByTestId('sod-last-pre-emergent')).not.toBeInTheDocument();
    });

    it('is hidden once a sod field is edited: it was judged against the saved sod date', async () => {
      stubFetch({ prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole' }, newSod: { holdLines: [], lastPreEmergent: { line: LINE, warning: WARNING } }, onPut: () => response({}) });
      await openEditor();
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      fireEvent.change(dateInput(), { target: { value: '2026-10-02' } });
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
      expect(screen.queryByTestId('sod-pre-emergent-warning')).not.toBeInTheDocument();
    });

    it('shows on the read view beside the saved sod record', async () => {
      stubFetch({ prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole' }, newSod: { holdLines: [], lastPreEmergent: { line: LINE, warning: WARNING } }, onPut: () => response({}) });
      render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
      await screen.findAllByText('Avery Customer');
      fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      expect(screen.getByTestId('sod-pre-emergent-warning')).toBeInTheDocument();
    });
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

  it('a failed sod read is stated on the read view, never shown as no holds', async () => {
    stubFetch({
      prefs: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null },
      newSodFails: true,
      onPut: () => response({}),
    });
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
    expect(await screen.findByText('Hold dates could not be read.')).toBeInTheDocument();
    expect(screen.queryByTestId('sod-hold-lines')).not.toBeInTheDocument();
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
