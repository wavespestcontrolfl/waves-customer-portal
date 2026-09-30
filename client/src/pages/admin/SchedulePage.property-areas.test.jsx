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
let areaLoadFailures = 0;
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
    if (url.includes('property-areas') && areaLoadFailures > 0) {
      areaLoadFailures -= 1;
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('property-areas')) data = measurements;
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('tech-tips')) data = { available: true, groups: [] };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); areaLoadFailures = 0; });
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

// ── Review round: soil drench, kind binding, explicit coverage, stale-version retry ──
const sequestar = { id: 'sequestar', name: 'Sequestar', category: 'fertilizer', application_method: 'soil_drench', default_rate_per_1000: 1.5, rate_unit: 'lb' };
const bedField = [{ key: 'bed_sqft_serviced', label: 'Beds serviced', type: 'number' }];
function heldAreas() {
  const original = fetch.getMockImplementation();
  const held = { release: null };
  fetch.mockImplementation((url, ...rest) => url.includes('property-areas')
    ? new Promise(resolve => { held.release = resolve; }) : original(url, ...rest));
  return held;
}
const respond = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

it('an area-based soil drench takes the reviewed bed area and derives its total', async () => {
  render(<CompletionPanel service={{ id: 'visit-1', customerId: 'customer-1', serviceType: 'Tree & Shrub Care', scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields: [], nextStepChips: [] } }}
    products={[...products, sequestar]} onClose={() => {}} onSubmit={vi.fn()} />);
  await add('Sequestar');
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200);
  expect(screen.getByPlaceholderText('Total')).toHaveValue(1.8);
});

it('a product area default is bound to its service-area kind and stops following after reclassification', async () => {
  const view = mount(); await add('Snapshot 2.5TG');
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200);
  view.rerender(panel('Mosquito Control'));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(3600));
  expect(screen.getByPlaceholderText('Sq ft')).toHaveValue(1200);
});

it('bed coverage typed before the measurements load becomes the visit override', async () => {
  const held = heldAreas();
  mount('Tree & Shrub Care', bedField);
  fireEvent.change((await screen.findByText(/Beds serviced/)).closest('div').parentElement.querySelector('input'), { target: { value: '700' } });
  await act(async () => held.release(respond(measurements)));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(700));
  expect(screen.getByText('1,200 sq ft')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use property area' })).toBeInTheDocument();
});

it('a completion refused as stale refetches the areas and retries with the new version and the kept override', async () => {
  const onSubmit = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('Property areas changed.'), { status: 409, code: 'property_service_area_changed' }))
    .mockResolvedValue({ success: true });
  render(<CompletionPanel service={{ id: 'visit-1', customerId: 'customer-1', serviceType: 'Tree & Shrub Care', scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields: bedField, nextStepChips: [] } }}
    products={products} onClose={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(await screen.findByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  measurements = { ...measurements, version: 'b'.repeat(64) };
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0][1].propertyServiceArea).toMatchObject({ version: 'a'.repeat(64), treatedSqft: 600, explicitVisitArea: true });
  const complete = await screen.findByRole('button', { name: /complete & send recap/i });
  await waitFor(() => expect(complete).toBeEnabled());
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.includes('/visit-1/property-areas')).length).toBe(2));
  await waitFor(() => expect(screen.getByLabelText('Area treated today (sq ft)')).toHaveValue(600));
  fireEvent.click(complete);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  expect(onSubmit.mock.calls[1][1].propertyServiceArea).toMatchObject({ version: 'b'.repeat(64), treatedSqft: 600, explicitVisitArea: true });
});

it('a failed refetch after a stale completion keeps completion blocked until Retry loads a fresh version', async () => {
  const onSubmit = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('Property areas changed.'), { status: 409, code: 'property_service_area_changed' }))
    .mockResolvedValue({ success: true });
  render(<CompletionPanel service={{ id: 'visit-1', customerId: 'customer-1', serviceType: 'Tree & Shrub Care', scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields: bedField, nextStepChips: [] } }}
    products={products} onClose={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(await screen.findByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  measurements = { ...measurements, version: 'b'.repeat(64) };
  areaLoadFailures = 1;
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  const retry = await screen.findByRole('button', { name: 'Retry' });
  // The failed reload never releases the stale closeout.
  expect(screen.getByRole('button', { name: /complete & send recap/i })).toBeDisabled();
  fireEvent.click(retry);
  const complete = screen.getByRole('button', { name: /complete & send recap/i });
  await waitFor(() => expect(complete).toBeEnabled());
  fireEvent.change(await screen.findByLabelText('Area treated today (sq ft)'), { target: { value: '600' } });
  fireEvent.click(complete);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  expect(onSubmit.mock.calls[1][1].propertyServiceArea).toMatchObject({ version: 'b'.repeat(64), treatedSqft: 600 });
});

it('a visit-area change recalculates a following total in the row\'s spoon unit, not the rate unit', async () => {
  const liquid = { id: 'floz', name: 'Fixture bed drench', category: 'insecticide', application_method: 'soil_drench', default_rate_per_1000: 0.5, rate_unit: 'fl_oz' };
  // A following row read in spoons (tsp) while its rate is per fl oz.
  localStorage.setItem('waves_completion_draft_visit-1', JSON.stringify({
    serviceId: 'visit-1', savedAt: Date.now(), notes: 'Fixture notes',
    selectedProducts: [{ productId: 'floz', name: 'Fixture bed drench', category: 'insecticide', applicationMethod: 'soil_drench',
      rate: 0.5, rateUnit: 'fl_oz', amountUnit: 'tsp', totalAmount: 3.6, areaValue: 1200, areaUnit: 'sqft',
      propertyServiceAreaField: true, propertyAreaDefault: { serviceId: 'visit-1', propertyId: 'property-1', kind: 'beds' } }],
  }));
  render(<CompletionPanel service={{ id: 'visit-1', customerId: 'customer-1', serviceType: 'Tree & Shrub Care', scheduledDate: '2026-09-27',
    completionProfile: { findingsType: 'tree_shrub', requiresProducts: false }, findingsSchema: { type: 'tree_shrub', fields: bedField, nextStepChips: [] } }}
    products={[...products, liquid]} onClose={() => {}} onSubmit={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(screen.getByPlaceholderText('Total')).toHaveValue(3.6));
  fireEvent.change(await screen.findByLabelText('Area treated today (sq ft)'), { target: { value: '2000' } });
  // 2,000 sq ft at 0.5 fl oz / 1,000 = 1 fl oz = 6 tsp, never "1 tsp".
  await waitFor(() => expect(screen.getByPlaceholderText('Total')).toHaveValue(6));
});
