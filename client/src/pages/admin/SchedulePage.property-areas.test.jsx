// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.stubGlobal('scrollTo', vi.fn());
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
function panel(type = 'Tree & Shrub Care', fields = [], id = 'visit-1') {
  return <CompletionPanel service={{ id, customerId: 'customer-1', serviceType: type, scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields, nextStepChips: [] } }}
    products={products} onClose={() => {}} onSubmit={vi.fn()} />;
}
function mount(type, fields) { return render(panel(type, fields)); }
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

it.each([false, true])('attaches an area arriving after product selection and preserves a manual total (%s)', async manual => {
  const original = fetch.getMockImplementation();
  let release;
  fetch.mockImplementation((url, ...rest) => url.includes('property-areas')
    ? new Promise(resolve => { release = resolve; }) : original(url, ...rest));
  mount();
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: 'Snapshot 2.5TG' } });
  fireEvent.click(screen.getByText('Snapshot 2.5TG'));
  if (manual) fireEvent.change(screen.getByPlaceholderText('Total'), { target: { value: '7' } });
  await act(async () => release(new Response(JSON.stringify(measurements), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await waitFor(() => expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200));
  expect(screen.getByPlaceholderText('Total')).toHaveValue(manual ? 7 : 2.76);
});
it('a unit edit made before areas load prevents a number being reused under the wrong unit', async () => {
  const original = fetch.getMockImplementation();
  let release;
  fetch.mockImplementation((url, ...rest) => url.includes('property-areas')
    ? new Promise(resolve => { release = resolve; }) : original(url, ...rest));
  mount();
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: 'Snapshot 2.5TG' } });
  fireEvent.click(screen.getByText('Snapshot 2.5TG'));
  const total = screen.getByPlaceholderText('Total');
  const amountUnit = within(total.parentElement).getAllByRole('combobox')[1];
  fireEvent.change(amountUnit, { target: { value: 'oz' } });
  await act(async () => release(new Response(JSON.stringify(measurements), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await waitFor(() => expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200));
  expect(amountUnit).toHaveValue('oz');
  expect(total).toHaveValue(null);
  fireEvent.change(screen.getByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  expect(total).toHaveValue(null);
});
it('does not reinterpret palm fertilizer as bed area', async () => {
  mount(); await add('LESCO 8-0-12 Palm');
  expect(screen.queryByPlaceholderText('Sq ft')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Total')).toHaveValue(null);
});
it('a bed coverage override is withdrawn when the same visit becomes mosquito service', async () => {
  const view = mount();
  await screen.findByRole('button', { name: 'Review areas' });
  fireEvent.change(screen.getByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  view.rerender(panel('Mosquito Control'));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(3600));
});
it('a restored bed override cannot become mosquito coverage', async () => {
  localStorage.setItem('waves_completion_draft_visit-1', JSON.stringify({
    serviceId: 'visit-1', savedAt: Date.now(), notes: 'Fixture notes', selectedProducts: [],
    propertyVisitArea: { serviceId: 'visit-1', propertyId: 'property-1', kind: 'beds', area: '600' },
  }));
  mount('Mosquito Control');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(3600));
});
it('changing visits removes products awaiting the former property area', async () => {
  const original = fetch.getMockImplementation();
  let release;
  fetch.mockImplementation((url, ...rest) => url.includes('/visit-1/property-areas')
    ? new Promise(resolve => { release = resolve; }) : original(url, ...rest));
  const view = mount();
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: 'Snapshot 2.5TG' } });
  fireEvent.click(screen.getByText('Snapshot 2.5TG'));
  expect(screen.getByPlaceholderText('Total')).toBeInTheDocument();
  view.rerender(panel('Tree & Shrub Care', [], 'visit-2'));
  await waitFor(() => expect(screen.queryByPlaceholderText('Total')).not.toBeInTheDocument());
  await act(async () => release(new Response(JSON.stringify(measurements), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await add('Snapshot 2.5TG');
  expect(screen.getByPlaceholderText('Total')).toHaveValue(2.76);
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

it.each([false, true])('a changed reviewed area clears untouched generated prose and preserves manual prose (%s)', async manual => {
  const report = 'Generated report describing 600 square feet.';
  const notes = manual ? 'Technician reviewed and corrected this description.' : report;
  localStorage.setItem('waves_completion_draft_visit-1', JSON.stringify({
    serviceId: 'visit-1', savedAt: Date.now(), notes, generatedReportText: report,
    aiReportUsed: true, chipLinesDetached: true, preGenerationNotes: 'Original field notes.',
    findingsValues: { bed_sqft_serviced: '600' }, selectedProducts: [],
  }));
  const original = fetch.getMockImplementation();
  let release;
  fetch.mockImplementation((url, ...rest) => url.includes('property-areas')
    ? new Promise(resolve => { release = resolve; }) : original(url, ...rest));
  mount('Tree & Shrub Care', [{ key: 'bed_sqft_serviced', label: 'Beds serviced', type: 'number' }]);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  expect(screen.getByDisplayValue(notes)).toBeInTheDocument();
  await act(async () => release(new Response(JSON.stringify(measurements), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(1200));
  expect(screen.getByDisplayValue(manual ? notes : 'Original field notes.')).toBeInTheDocument();
  expect(!!screen.queryByText(/the draft\s+was cleared/)).toBe(!manual);
});
