// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage';
import { refetchFlags } from '../../hooks/useFeatureFlag';
const products = [
  { id: 'snapshot', name: 'Snapshot 2.5TG', category: 'herbicide', application_method: 'granular_broadcast', default_rate_per_1000: 2.3, rate_unit: 'lb' },
  { id: 'palm', name: 'LESCO 8-0-12 Palm', category: 'fertilizer', application_method: 'granular_broadcast', default_rate_per_1000: 1.3, rate_unit: 'lb' },
  { id: 'liquid', name: 'Fixture foliar spray', category: 'insecticide', application_method: 'foliar_spray', default_rate_per_1000: 0.8, rate_unit: 'fl_oz/gal' },
];
let measurements;
beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  measurements = { enabled: true, propertyId: 'property-1', version: 'a'.repeat(64), areas: {
    beds: { sqft: 1200, source: 'field', reviewedAt: '2026-09-27' }, lawn: null,
    mosquito: { sqft: 3600, source: 'field', reviewedAt: '2026-09-27' },
  } };
  vi.stubGlobal('fetch', vi.fn(async url => {
    let data = {};
    if (url.includes('property-areas')) data = measurements;
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('tech-tips')) data = { available: true, groups: [] };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(type = 'Tree & Shrub Care') {
  return render(<CompletionPanel service={{ id: 'visit-1', customerId: 'customer-1', serviceType: type, scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields: [], nextStepChips: [] } }}
    products={products} onClose={() => {}} onSubmit={vi.fn()} />);
}
async function add(name) {
  await screen.findByRole('button', { name: 'Review areas' });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: name } });
  fireEvent.click(screen.getByText(name));
}
it('derives a granular bed amount and retains a manual quantity after partial coverage changes', async () => {
  mount(); await add('Snapshot 2.5TG');
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200);
  expect(screen.getByPlaceholderText('Total')).toHaveValue(2.76);
  fireEvent.change(screen.getByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  await waitFor(() => expect(screen.getByPlaceholderText('Total')).toHaveValue(1.38));
  fireEvent.change(screen.getByPlaceholderText('Total'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Area treated today (sq ft)'), { target: { value: '500' } });
  expect(screen.getByPlaceholderText('Total')).toHaveValue(2);
  expect(screen.getByText('1,200 sq ft')).toBeInTheDocument();
  expect(fetch.mock.calls.some(([url, opts]) => url.includes('property-areas') && opts?.method === 'PUT')).toBe(false);
});
it('does not reinterpret palm fertilizer as bed area', async () => {
  mount(); await add('LESCO 8-0-12 Palm');
  expect(screen.queryByPlaceholderText('Sq ft')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Total')).toHaveValue(null);
});
it('an individually entered product area stops following the visit area', async () => {
  mount(); await add('Snapshot 2.5TG');
  fireEvent.change(screen.getByPlaceholderText('Sq ft'), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(300);
  expect(screen.getByPlaceholderText('Total')).toHaveValue(0.69);
});
it('mosquito coverage is separate and never substitutes for finished mix gallons', async () => {
  mount('Mosquito Control'); await add('Fixture foliar spray');
  expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(3600);
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(3600);
  expect(screen.getByPlaceholderText('Total')).toHaveValue(null);
});

it('a detached product area still withdraws a derived total when the amount unit changes', async () => {
  mount(); await add('Snapshot 2.5TG');
  fireEvent.change(screen.getByPlaceholderText('Sq ft'), { target: { value: '300' } });
  const total = screen.getByPlaceholderText('Total');
  expect(total).toHaveValue(0.69);
  fireEvent.change(within(total.parentElement).getAllByRole('combobox')[1], { target: { value: 'oz' } });
  expect(total).toHaveValue(null);
  fireEvent.change(screen.getByPlaceholderText('Sq ft'), { target: { value: '600' } });
  expect(total).toHaveValue(null);
});
