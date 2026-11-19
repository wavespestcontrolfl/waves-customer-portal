// @vitest-environment jsdom
// Taurus SC's yearly label limit on the recap modal's house mix: the context
// carries the server's answer (whether another 0.03% application fits); when none
// fits the mix opens without Taurus, a manual Taurus warns (never blocks), and an
// unknown answer leaves Taurus out too.
import React from 'react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home is still within the label's yearly limit.";

const FULL = { high: 0, low: 4, count: 4, eligible: false, year: 2026 };
const ROOM = { high: 0, low: 3, count: 3, eligible: true, year: 2026 };

const CATALOG = [
  { id: 1, name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 2, name: 'LESCO Crosscheck Plus', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 3, name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' },
];

function makeRequest(taurusYearly, existingRecord = null) {
  return vi.fn(async (path) => {
    if (path.endsWith('/context')) {
      return {
        ok: true,
        eligible: true,
        service: { id: 'svc-1', customerName: 'Pat Jones', hasPhone: false, serviceType: 'General Pest Control (Quarterly)' },
        timeline: [],
        products: CATALOG,
        existingRecord,
        ...(taurusYearly === undefined ? {} : { taurusYearly }),
      };
    }
    return { ok: true };
  });
}

async function open(taurusYearly) {
  render(<ServiceRecapModal service={{ id: 'svc-1', serviceType: 'General Pest Control (Quarterly)' }} request={makeRequest(taurusYearly)} onClose={() => {}} />);
  await screen.findByRole('button', { name: 'LESCO Crosscheck Plus', pressed: true });
}

describe('ServiceRecapModal Taurus yearly limit', () => {
  test('no application fits: the mix opens without Taurus and says so; Crosscheck and the surfactant stay', async () => {
    await open(FULL);
    expect(screen.getByRole('button', { name: 'Taurus SC', pressed: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'LESCO 90/10 Nonionic Surfactant', pressed: true })).toBeTruthy();
    expect(screen.getByText("Taurus left out: this home reached the label's yearly limit (4 this year).")).toBeTruthy();
  });

  test('a reopened recap reads the ledger quantity: 3.2 fl oz of Taurus after three 0.03% visits warns', async () => {
    const threeLow = { high: 0, low: 3, count: 3, eligible: true, eligibleHigh: false, year: 2026 };
    const record = (totalAmount) => ({
      id: 'rec-1',
      products: [{ product_id: 1, product_name: 'Taurus SC', application_rate: '1.6', rate_unit: 'oz', ledger_rows: [{ quantity: totalAmount, quantity_unit: 'fl_oz' }] }],
    });
    render(<ServiceRecapModal service={{ id: 'svc-1', serviceType: 'General Pest Control (Quarterly)' }} request={makeRequest(threeLow, record(3.2))} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Taurus SC', pressed: true });
    expect(screen.getByText("Over the label's yearly Taurus limit at this home.")).toBeTruthy();
    cleanup();
    render(<ServiceRecapModal service={{ id: 'svc-1', serviceType: 'General Pest Control (Quarterly)' }} request={makeRequest(threeLow, record(1.6))} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Taurus SC', pressed: true });
    expect(screen.queryByText("Over the label's yearly Taurus limit at this home.")).toBeNull();
  });

  test("a reopened recap reads each ledger row's dilution and date: a 0.06% row at a 1.6 oz rate after three 0.03% visits warns", async () => {
    const threeLow = { high: 0, low: 3, count: 3, eligible: true, eligibleHigh: false, year: 2026 };
    const record = (ledgerRows) => ({
      id: 'rec-1',
      products: [{ product_id: 1, product_name: 'Taurus SC', application_rate: '1.6', rate_unit: 'oz', ledger_rows: ledgerRows }],
    });
    const warning = "Over the label's yearly Taurus limit at this home.";
    for (const [ledger, warns] of [
      [[{ dilution_rate: '0.06%' }], true],
      [[{ application_date: '2026-10-14' }], true],
      [[{ dilution_rate: '0.03%', application_date: '2026-10-14' }], false],
      [[{ application_date: '2026-11-20' }], false],
      // Two active rows for one product: the count reads the record at its strongest, so a 0.06% row warns.
      [[{ dilution_rate: '0.03%' }, { dilution_rate: '0.06%' }], true],
      [[{ dilution_rate: '0.03%' }, { quantity: 1.6, quantity_unit: 'fl_oz' }], false],
    ]) {
      render(<ServiceRecapModal service={{ id: 'svc-1', serviceType: 'General Pest Control (Quarterly)' }} request={makeRequest(threeLow, record(ledger))} onClose={() => {}} />);
      await screen.findByRole('button', { name: 'Taurus SC', pressed: true });
      expect(Boolean(screen.queryByText(warning))).toBe(warns);
      cleanup();
    }
  });

  test('a recorded mL rate (never shown) is read from the ledger row: 23.7 mL/gal after three 0.03% visits warns', async () => {
    const threeLow = { high: 0, low: 3, count: 3, eligible: true, eligibleHigh: false, year: 2026 };
    const record = {
      id: 'rec-1',
      products: [{
        product_id: 1, product_name: 'Taurus SC', application_rate: '23.7', rate_unit: 'ml/gal',
        ledger_rows: [{ application_rate: 23.7, rate_unit: 'ml/gal', application_date: '2026-11-21' }],
      }],
    };
    render(<ServiceRecapModal service={{ id: 'svc-1', serviceType: 'General Pest Control (Quarterly)' }} request={makeRequest(threeLow, record)} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Taurus SC', pressed: true });
    expect(screen.getByText("Over the label's yearly Taurus limit at this home.")).toBeTruthy();
  });

  test('room under the label: Taurus stays on the mix and nothing is said', async () => {
    await open(ROOM);
    expect(screen.getByRole('button', { name: 'Taurus SC', pressed: true })).toBeTruthy();
    expect(screen.queryByText(/yearly (Taurus )?limit/)).toBeNull();
  });

  test('unknown count (null, or no key from an older server): the mix opens without Taurus and says the count is unavailable', async () => {
    for (const unknown of [null, undefined]) {
      await open(unknown);
      expect(screen.getByRole('button', { name: 'Taurus SC', pressed: false })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'LESCO Crosscheck Plus', pressed: true })).toBeTruthy();
      expect(screen.getByText(UNKNOWN_LINE)).toBeTruthy();
      cleanup();
    }
  });

  test('two 0.06% applications also use the year up: no Taurus on the mix', async () => {
    await open({ high: 2, low: 0, count: 2, eligible: false, year: 2026 });
    expect(screen.getByRole('button', { name: 'Taurus SC', pressed: false })).toBeTruthy();
    expect(screen.getByText("Taurus left out: this home reached the label's yearly limit (2 this year).")).toBeTruthy();
  });

  test('adding Taurus back by hand when none fits warns (the warning never touches the save)', async () => {
    await open(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Taurus SC', pressed: false }));
    expect(screen.getByText("Over the label's yearly Taurus limit at this home.")).toBeTruthy();
    expect(screen.queryByText(/Taurus left out/)).toBeNull();
  });
});
