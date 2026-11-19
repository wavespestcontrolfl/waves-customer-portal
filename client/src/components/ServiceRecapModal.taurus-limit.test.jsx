// @vitest-environment jsdom
// Taurus SC's label limit (4 a year per home) on the recap modal's house mix:
// the context carries the server's count; at 4 the mix opens without Taurus,
// a manual Taurus warns (never blocks), an unknown count leaves Taurus out too.
import React from 'react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home has had fewer than 4 this year.";

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
  test('4 of 4: the mix opens without Taurus and says so; Crosscheck and the surfactant stay', async () => {
    await open({ count: 4, limit: 4, year: 2026 });
    expect(screen.getByRole('button', { name: 'Taurus SC', pressed: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'LESCO 90/10 Nonionic Surfactant', pressed: true })).toBeTruthy();
    expect(screen.getByText('Taurus left out: 4 of 4 this year at this home (label limit).')).toBeTruthy();
  });

  test('3 of 4: Taurus stays on the mix and nothing is said', async () => {
    await open({ count: 3, limit: 4, year: 2026 });
    expect(screen.getByRole('button', { name: 'Taurus SC', pressed: true })).toBeTruthy();
    expect(screen.queryByText(/label limit|over the label/)).toBeNull();
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

  test('adding Taurus back by hand at 4 warns (the warning never touches the save)', async () => {
    await open({ count: 4, limit: 4, year: 2026 });
    fireEvent.click(screen.getByRole('button', { name: 'Taurus SC', pressed: false }));
    expect(screen.getByText("5th Taurus this year at this home: over the label's 4.")).toBeTruthy();
    expect(screen.queryByText(/Taurus left out/)).toBeNull();
  });
});
