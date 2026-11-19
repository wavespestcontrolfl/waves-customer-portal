// @vitest-environment jsdom
// Taurus SC's yearly label limit on the pest Fast Complete sheet:
// pest-recap/context carries the server's answer (whether another 0.03%
// application fits); when none fits the house mix opens without Taurus, a manual Taurus warns (never blocks), an unknown count
// leaves Taurus out too and says so.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home is still within the label's yearly limit.";

const FULL = { high: 0, low: 4, count: 4, eligible: false, year: 2026 };
const ROOM = { high: 0, low: 3, count: 3, eligible: true, year: 2026 };

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'insecticide', active_ingredient: 'fipronil', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', inventory_unit: 'fl_oz', inventory_on_hand: '120.0000' },
  { id: 'crosscheck', name: 'LESCO Crosscheck Plus', category: 'insecticide', active_ingredient: 'bifenthrin', inventory_unit: 'fl_oz', inventory_on_hand: 96 },
  { id: 'lesco', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
];
const CONTEXT_SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

function makeRequest(taurusYearly) {
  return vi.fn(async (path) => {
    if (path.split('?')[0].endsWith('/pest-recap/context')) {
      return {
        ok: true, eligible: true, service: CONTEXT_SERVICE, products: CATALOG, commonProducts: [], existingRecord: null,
        ...(taurusYearly === undefined ? {} : { taurusYearly }),
      };
    }
    if (path.endsWith('/tech-rating-allowed')) return { allowed: false };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/photos')) return { photos: [] };
    return {};
  });
}

async function open(taurusYearly) {
  render(<FastCompleteSheet service={SERVICE} request={makeRequest(taurusYearly)} onClose={() => {}} />);
  await screen.findByRole('button', { name: /LESCO Crosscheck Plus/ });
}
const taurusTile = () => screen.queryByRole('button', { name: /^Taurus SC/ });

describe('FastCompleteSheet Taurus yearly limit', () => {
  test('no application fits: the house mix opens without Taurus and says so; Crosscheck and the surfactant stay', async () => {
    await open(FULL);
    expect(taurusTile()).toBeNull();
    expect(screen.getByRole('button', { name: /LESCO 90\/10 Nonionic Surfactant/ })).toBeTruthy();
    expect(screen.getByText("Taurus left out: this home reached the label's yearly limit (4 this year).")).toBeTruthy();
  });

  test('room under the label: Taurus stays on the mix and nothing is said', async () => {
    await open(ROOM);
    expect(taurusTile()).toBeTruthy();
    expect(screen.queryByText(/yearly (Taurus )?limit/)).toBeNull();
  });

  test('unknown count (null, or no key from an older server): the mix opens without Taurus and says the count is unavailable', async () => {
    for (const unknown of [null, undefined]) {
      await open(unknown);
      expect(taurusTile()).toBeNull();
      expect(screen.getByRole('button', { name: /LESCO Crosscheck Plus/ })).toBeTruthy();
      expect(screen.getByText(UNKNOWN_LINE)).toBeTruthy();
      cleanup();
    }
  });

  test('two 0.06% applications also use the year up: no Taurus on the mix', async () => {
    await open({ high: 2, low: 0, count: 2, eligible: false, year: 2026 });
    expect(taurusTile()).toBeNull();
    expect(screen.getByText("Taurus left out: this home reached the label's yearly limit (2 this year).")).toBeTruthy();
  });

  test('adding Taurus back from the picker when none fits warns, and the warning replaces the left-out line', async () => {
    await open(FULL);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Taurus SC\b/ }));
    expect(screen.getByText("Over the label's yearly Taurus limit at this home.")).toBeTruthy();
    expect(screen.queryByText(/Taurus left out/)).toBeNull();
  });
});
