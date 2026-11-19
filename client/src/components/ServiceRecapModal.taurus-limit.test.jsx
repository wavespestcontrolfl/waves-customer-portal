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

function makeRequest(taurusYearly) {
  return vi.fn(async (path) => {
    if (path.endsWith('/context')) {
      return {
        ok: true,
        eligible: true,
        service: { id: 'svc-1', customerName: 'Pat Jones', hasPhone: false, serviceType: 'General Pest Control (Quarterly)' },
        timeline: [],
        products: CATALOG,
        existingRecord: null,
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
