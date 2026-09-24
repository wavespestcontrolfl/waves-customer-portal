// @vitest-environment jsdom
// Codex round-3 P1 on PR #4688: GET /admin/tax/rates left BOTH a staged
// future rate and its predecessor with active:true, so the rates screen
// (reading the raw `active` flag) showed the not-yet-effective rate in the
// "current" grid alongside the rate actually in force, and a superseded row
// stayed there forever. The route now derives a 'current' | 'staged' |
// 'superseded' status per row (same selection calculateTax applies); this
// covers TaxRatesTab grouping by that status instead of `active`.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TaxRatesTab } from './TaxPage.jsx';

const rates = [
  { id: 'r-current', county: 'Sarasota', state: 'FL', stateRate: 0.06, countySurtax: 0.01, combinedRate: 0.07, effectiveDate: '2025-01-01', expiryDate: null, serviceZone: 'Sarasota / LWR', notes: null, active: true, status: 'current' },
  { id: 'r-staged', county: 'Sarasota', state: 'FL', stateRate: 0.06, countySurtax: 0.015, combinedRate: 0.075, effectiveDate: '2031-01-01', expiryDate: null, serviceZone: 'Sarasota / LWR', notes: null, active: true, status: 'staged' },
  { id: 'r-superseded', county: 'Charlotte', state: 'FL', stateRate: 0.06, countySurtax: 0.01, combinedRate: 0.07, effectiveDate: '2024-01-01', expiryDate: '2025-01-01', serviceZone: null, notes: null, active: false, status: 'superseded' },
];

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/admin/tax/rates')) {
      return { ok: true, json: async () => ({ rates }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('groups rates by the server-derived status, not the raw active flag', async () => {
  render(<TaxRatesTab />);

  // The staged (not-yet-effective) rate must NOT appear in the current grid
  // — only its own "Staged Rates" section.
  await waitFor(() => expect(screen.getByText('Sarasota County')).toBeInTheDocument());
  expect(screen.getAllByText('Sarasota County')).toHaveLength(1);
  expect(screen.getByText('Staged Rates (not yet in effect)')).toBeInTheDocument();

  // The superseded rate shows under Historical Rates, not the current grid.
  expect(screen.getByText('Historical Rates')).toBeInTheDocument();
  expect(screen.queryByText('Charlotte County')).not.toBeInTheDocument();
});
