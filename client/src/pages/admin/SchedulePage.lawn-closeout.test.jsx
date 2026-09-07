// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const products = [{ id: 'test-k', name: 'Test liquid fertilizer', category: 'fertilizer', rate_unit: 'fl_oz', default_rate_per_1000: 99 }];
const secondProduct = { id: 'test-micro', name: 'Test micronutrients', category: 'fertilizer', rate_unit: 'fl_oz', default_rate_per_1000: 99 };
const service = { id: 'test-visit', customerId: 'test-property', serviceType: 'Every 6 Weeks Lawn Care Service', completionProfile: { serviceKey: 'lawn', requiresProducts: true }, scheduledDate: '2026-09-05', waveguardTier: 'Silver', status: 'on_site', price: 0 };
let submit;
let planResolvers;
let delayPlan;
let mixAmount;
let improvementsEnabled;
let history;
let defaultsEnabled;
let failPlan;
let withdrawDefaults;
let catalog;
let optionalOptions;
beforeEach(async () => {
  history = [{ confirmed_by_tech: true, service_date: '2026-07-10', overall_score: 81 }];
  improvementsEnabled = true;
  defaultsEnabled = false;
  failPlan = false;
  withdrawDefaults = false;
  catalog = products;
  optionalOptions = [];
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  window.history.replaceState({}, '', '/?completionImprovements=1');
  vi.stubGlobal('alert', vi.fn());
  delayPlan = false;
  mixAmount = 15;
  planResolvers = [];
  submit = vi.fn().mockRejectedValue(new Error('Synthetic submit'));
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: { 'lawn-completion-improvements': improvementsEnabled } };
    if (url.includes('turf-profile')) data = { profile: { lawn_sqft: 5000 } };
    if (url.includes('lawn-assessment/service')) data = { assessment: { id: 'assessment-current', confirmed_by_tech: true, turf_density: 82, weed_suppression: 85, color_health: 85, stress_damage: 80 } };
    if (url.includes('lawn-assessment/history')) data = { history };
    if (url.includes('treatment-plans')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const sqft = Object.hasOwn(body, 'lawnSqft') ? body.lawnSqft : 5000;
      const visitId = /treatment-plans\/([^/?]+)/.exec(url)[1];
      if (delayPlan) await new Promise((resolve) => { planResolvers.push(resolve); });
      if (failPlan) throw new Error('Synthetic plan outage');
      data = { plan: { protocol: {}, mixCalculator: { items: [{ product: products[0], mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: mixAmount, amountUnit: 'fl_oz', treatedSqft: 5000 } }] } } };
      if (defaultsEnabled) {
        const items = (withdrawDefaults ? [] : catalog).map((product, index) => ({ product, selected: true, applicationMethod: 'broadcast_spray',
          mix: { ratePer1000: index === 0 ? 3 : 2, rateUnit: 'fl_oz', amount: sqft ? sqft * (index === 0 ? 3 : 2) / 1000 : null, amountUnit: 'fl_oz', treatedSqft: sqft } }));
        const baseline = { id: 'baseline', date: '2026-07-01', overall_score: 60 };
        const previous = { id: 'previous', date: '2026-08-01', overall_score: 81 };
        data.plan.mixCalculator.items = items;
        data.plan.completionDefaults = { enabled: true, serviceId: visitId, propertyId: 'property-a', lawnSqft: sqft,
          // Optional protocol rows reach the client as id/name only (server options), never as defaults.
          items, options: [...items, ...optionalOptions.map((product) => ({ product: { id: product.id, name: product.name } }))], propertyMatchesProfile: true,
          history: { available: true, rows: [baseline, previous], current: null, baseline, previous, progress: { baselineDelta: 21 } } };
      }
    }
    if (url.includes('tech-tips')) data = { available: true, groups: [{ id: 'lawn', label: 'Lawn care', tips: [{ id: 'lawn_water_morning', label: 'Water in the morning', copy: 'Use the morning irrigation window.' }] }] };
    if (url.includes('generate-report')) data = { report: 'WHAT WE DID:\nApplied the old products.\nWHAT WE FOUND:\nLawn looked fine.' };
    if (url.includes('completion-actions')) data = { actions: [] };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    return { ok: true, json: async () => data };
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<CompletionPanel service={service} products={catalog} onClose={() => {}} onSubmit={submit} />);

it('prefills the engine mix and submits findings and inspection actions once, with edited quantities', async () => {
  mount();
  await waitFor(() => expect(screen.getByPlaceholderText('Total').value).toBe('15'));
  expect(screen.getByPlaceholderText('Sq ft').value).toBe('5000');
  expect(screen.queryByText('Add lawn length photo')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Sq ft'), { target: { value: '4000' } });
  expect(screen.getByPlaceholderText('Total').value).toBe('12');
  const statement = 'Leaf spotting consistent with gray leaf spot was observed.';
  fireEvent.change(screen.getByLabelText('Finding', { exact: true }), { target: { value: statement } });
  fireEvent.change(screen.getByLabelText('Location', { exact: true }), { target: { value: 'Back yard' } });
  fireEvent.click(screen.getByText('Add finding to report'));
  fireEvent.change(screen.getByText('Add protocol action...').parentElement, { target: { value: 'lawn-field-3' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const body = submit.mock.calls[0][1];
  expect(body.products).toHaveLength(1);
  expect(body.products[0]).toMatchObject({ productId: 'test-k', rate: 3, totalAmount: 12, areaValue: '4000', applicationArea: 'Front yard, Back yard, Side yards' });
  expect(body.observations).toEqual([`${statement} Location: Back yard.`]);
  expect(body.structuredObservations).toEqual(body.observations);
  expect(body.protocolActionsCompleted).toEqual(['Tested irrigation coverage']);
  expect(body).not.toHaveProperty('gaugePhoto');
});

it('keeps the existing defaults when the server flag is disabled, even with a query override', async () => {
  improvementsEnabled = false;
  await refetchFlags();
  window.history.replaceState({}, '', '/?completionImprovements=1');
  mount();
  await screen.findByText('Assessment confirmed');
  expect(screen.queryByLabelText('Previous lawn visit')).toBeNull();
  expect(screen.queryByPlaceholderText('Total')).toBeNull();
  expect(screen.queryByRole('group', { name: 'Lawn findings' })).toBeNull();
});

it('preserves an intentionally empty product list restored before the plan arrives', async () => {
  delayPlan = true;
  localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
    serviceId: service.id, savedAt: Date.now(), notes: 'Draft inspection notes',
    selectedProducts: [], areasServiced: [],
  }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(planResolvers.length).toBeGreaterThan(0));
  delayPlan = false;
  await act(async () => { planResolvers.forEach((resolve) => resolve()); });
  await screen.findByText('Assessment confirmed');
  await waitFor(() => expect(screen.queryByText('Loading treatment plan…')).toBeNull());
  expect(screen.queryByPlaceholderText('Total')).toBeNull();
});

it.each([false, true])('refreshes untouched plan defaults while preserving edits=%s', async (edited) => {
  const view = mount();
  await waitFor(() => expect(screen.getByPlaceholderText('Total').value).toBe('15'));
  if (edited) fireEvent.change(screen.getByPlaceholderText('Total'), { target: { value: '12' } });
  mixAmount = 10;
  view.rerender(<CompletionPanel service={{ ...service, id: 'plan-refresh' }} products={products} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('treatment-plans/plan-refresh'))).toBe(true));
  await waitFor(() => expect(screen.getByPlaceholderText('Total').value).toBe(edited ? '12' : '10'));
});


it.each(['Commercial', 'One-Time', null])('does not seed residential products for a %s lawn visit', async (waveguardTier) => {
  render(<CompletionPanel service={{ ...service, waveguardTier }} products={products} onClose={() => {}} onSubmit={submit} />);
  await screen.findByText('Assessment confirmed');
  await waitFor(() => expect(screen.queryByText('Loading treatment plan…')).toBeNull());
  expect(screen.queryByPlaceholderText('Total')).toBeNull();
});


it('prunes an out-of-line tip restored after the current lawn library has loaded', async () => {
  localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
    serviceId: service.id, savedAt: Date.now(), notes: 'Synthetic saved draft',
    selectedProducts: [{ productId: 'test-k', rate: 3, rateUnit: 'fl_oz', totalAmount: 15, amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft' }],
    selectedTipIds: ['moisture_ac_drip', 'lawn_water_morning'], areasServiced: ['Front yard'],
  }));
  mount();
  await screen.findByPlaceholderText('Search tips…');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await screen.findByText('Assessment confirmed');
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].techTips.ids).toEqual(['lawn_water_morning']);
});


it('normalizes legacy previous scores using the same four categories as the customer report', async () => {
  history = [{ confirmed_by_tech: true, service_date: '2026-07-10', overall_score: 99,
    turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: null,
    fungus_control: 60, thatch_level: 70 }];
  mount();
  const card = await screen.findByLabelText('Previous lawn visit');
  await waitFor(() => expect(card.textContent).toContain('Overall score 76/100'));
  expect(card.textContent).toContain('Condition60/100');
  expect(card.textContent).not.toContain('99/100');
});

const enableDefaults = () => { defaultsEnabled = true; catalog = [...products, secondProduct]; };
const totals = () => screen.getAllByPlaceholderText('Total');

it('uses the appointment plan and scoped progress without fetching static actions or customer-wide scores', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  expect(screen.getByLabelText('Area for this visit (sq ft)').value).toBe('5000');
  expect(screen.getByLabelText('Lawn visit plan').textContent).toContain('+21 points from baseline');
  expect(fetch.mock.calls.some(([url]) => /completion-actions|lawn-assessment\/history/.test(url))).toBe(false);
});

it('updates untouched products and areas while keeping a manually entered amount', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(totals()[0], { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['7', '8']));
  expect(screen.getAllByPlaceholderText('Sq ft').map(input => input.value)).toEqual(['4000', '4000']);
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products.map(row => Number(row.totalAmount))).toEqual([7, 8]);
  expect(submit.mock.calls[0][1].lawnProtocolCompletion).toEqual({ treatedSqft: 4000 });
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/build')).map(([, options]) => JSON.parse(options.body)))
    .toEqual([{ completionDefaults: true, lawnSqft: 4000 }]);
});

it('keeps removed defaults out of the plan after refresh', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(screen.queryByText('Updating plan suggestions…')).toBeNull());
  expect(totals().map(input => input.value)).toEqual(['10']);
});

it('preserves a per-product treated-area override when the visit area changes', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getAllByPlaceholderText('Sq ft')[0], { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['3', '8']));
  expect(screen.getAllByPlaceholderText('Sq ft').map(input => input.value)).toEqual(['1000', '4000']);
});

it('restores removals and manual amounts after a reload without reseeding', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  fireEvent.change(totals()[0], { target: { value: '9' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).selectedProducts[0].totalAmount).toBe('9'));
  view.unmount();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9']));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(screen.queryByText('Updating plan suggestions…')).toBeNull());
  expect(totals().map(input => input.value)).toEqual(['9']);
});

it('ignores an older area response arriving after the latest request', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  delayPlan = true;
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(planResolvers).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '3000' } });
  await waitFor(() => expect(planResolvers).toHaveLength(2));
  await act(async () => { planResolvers[1](); });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '6']));
  await act(async () => { planResolvers[0](); });
  expect(totals().map(input => input.value)).toEqual(['9', '6']);
});

it('clears derived amounts on a failed refresh while preserving recorded manual amounts', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(totals()[0], { target: { value: '7' } });
  failPlan = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await screen.findByText('Plan could not be refreshed. Enter actual amounts or retry.');
  expect(totals().map(input => input.value)).toEqual(['7', '']);
});

it('clearing the visit area clears calculated quantities and never restores the catalog rate', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['', '']));
  expect(screen.getAllByPlaceholderText('Sq ft').map(input => input.value)).toEqual(['', '']);
});

it('a partial visit inherits the remaining zones and clears unmeasured whole-lawn area', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const areas = document.getElementById('cp-areas-treated-desktop');
  fireEvent.click(areas);
  fireEvent.click(within(areas.parentElement).getByRole('button', { name: 'Back yard', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['', '']));
  expect(screen.getByLabelText('Area for this visit (sq ft)').value).toBe('');
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '2000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['6', '4']));
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products.map(row => row.applicationArea)).toEqual(['Front yard, Side yards', 'Front yard, Side yards']);
});

it('changing visits drops the first visit’s manual quantities and removed defaults', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(totals()[0], { target: { value: '7' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[1]);
  view.rerender(<CompletionPanel service={{ ...service, id: 'second-visit' }} products={catalog} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
});

it('an initial plan outage cannot fall back to customer-wide history or static lawn products', async () => {
  enableDefaults();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  expect(fetch.mock.calls.some(([url]) => /completion-actions|lawn-assessment\/history/.test(url))).toBe(false);
  expect(screen.queryByPlaceholderText('Total')).toBeNull();
  failPlan = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry plan' }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
});

it.each(['calculated', 'manual-amount', 'manual-unit', 'partial-zones', 'measured-zones'])('a manually added product keeps area and quantity aligned: %s', async mode => {
  enableDefaults();
  const added = { id: 'manual-product', name: 'Fixture optional product', category: 'adjuvant', rate_unit: 'fl_oz' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Rate')[2], { target: { value: '1' } });
  expect(totals()[2].value).toBe('5');
  if (mode === 'manual-amount') fireEvent.change(totals()[2], { target: { value: '7' } });
  if (mode === 'manual-unit') fireEvent.change(within(totals()[2].parentElement).getAllByRole('combobox')[1], { target: { value: 'gal' } });
  if (mode === 'measured-zones') {
    fireEvent.change(within(totals()[2].parentElement).getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Back yard', exact: true }).at(-1));
    expect(totals()[2].value).toBe('1');
  }
  if (mode === 'partial-zones') {
    fireEvent.click(screen.getAllByRole('button', { name: 'Back yard', exact: true }).at(-1));
    expect(totals()[2].value).toBe('');
    expect(screen.getAllByPlaceholderText('Sq ft')[2].value).toBe('');
  }
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(screen.getAllByPlaceholderText('Sq ft')[2].value).toBe(mode === 'partial-zones' ? '' : mode === 'measured-zones' ? '1000' : '4000'));
  const expectedAmount = { calculated: '4', 'manual-amount': '7', 'manual-unit': '5', 'partial-zones': '', 'measured-zones': '1' }[mode];
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['12', '8', expectedAmount]));
});

it('a withdrawn suggestion requires actual units and method instead of displaying hidden fallbacks', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getAllByPlaceholderText('Sq ft')[0], { target: { value: '1000' } });
  withdrawDefaults = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  const selects = within(totals()[0].parentElement).getAllByRole('combobox');
  expect(selects.slice(0, 3).map(select => select.value)).toEqual(['', '', '']);
  expect(screen.getByPlaceholderText('Rate').value).toBe('');
  fireEvent.change(totals()[0], { target: { value: '3' } });
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  fireEvent.change(selects[1], { target: { value: 'fl_oz' } });
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  fireEvent.change(selects[2], { target: { value: 'broadcast_spray' } });
  expect(screen.getByPlaceholderText('Sq ft').value).toBe('1000');
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[0]).toMatchObject({ rate: '', totalAmount: '3', amountUnit: 'fl_oz', applicationMethod: 'broadcast_spray', areaValue: '1000' });
});


it.each([false, true])('method changes clear suggested rates and preserve manually entered rates: manual=%s', async (manual) => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const rate = screen.getAllByPlaceholderText('Rate')[0];
  const selects = within(totals()[0].parentElement).getAllByRole('combobox');
  if (manual) fireEvent.change(rate, { target: { value: '2' } });
  fireEvent.change(selects[2], { target: { value: 'spot_treatment' } });
  expect(rate.value).toBe(manual ? '2' : '');
  expect(selects[0].value).toBe(manual ? 'fl_oz' : '');
  fireEvent.change(within(totals()[0].parentElement).getByPlaceholderText('Treated sq ft'), { target: { value: '1000' } });
  fireEvent.change(totals()[0], { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(totals()[1].value).toBe('10'));
  expect(rate.value).toBe(manual ? '2' : '');
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[0]).toMatchObject({ rate: manual ? '2' : '', rateUnit: manual ? 'fl_oz' : '', totalAmount: '3', applicationMethod: 'spot_treatment' });
});


it.each([false, true])('failed visit-area refresh preserves only measured product area: measured=%s', async measured => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const card = within(totals()[0].parentElement);
  if (measured) fireEvent.change(card.getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
  fireEvent.change(totals()[0], { target: { value: '7' } });
  failPlan = true;
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await screen.findByText('Plan could not be refreshed. Enter actual amounts or retry.');
  expect(card.getByPlaceholderText('Sq ft').value).toBe(measured ? '1000' : '');
  expect(totals()[0].value).toBe('7');
  expect(card.getByPlaceholderText('Rate').value).toBe('');
  expect(within(totals()[1].parentElement).getByPlaceholderText('Sq ft').value).toBe('');
  expect(screen.getByRole('button', {name: /Product Actuals Required/}).disabled).toBe(true);
});

it('a plan refresh that changes the products drops an untouched generated report', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const notes = screen.getByPlaceholderText(/Notes about this service/);
  fireEvent.change(notes, { target: { value: 'Hand notes before generating.' } });
  fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]);
  await waitFor(() => expect(notes.value).toContain('Applied the old products.'));
  withdrawDefaults = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(screen.queryByText('Updating plan suggestions…')).toBeNull());
  await waitFor(() => expect(screen.queryAllByPlaceholderText('Total')).toHaveLength(0));
  expect(notes.value).not.toContain('Applied the old products.');
  expect(notes.value).toContain('Hand notes before generating.');
});

it('an "Additional work" protocol option is built from the catalog product, not its bare id/name', async () => {
  enableDefaults();
  const optional = { id: 'test-hydretain', name: 'Hydretain', category: 'adjuvant', rate_unit: 'fl_oz', default_rate_per_1000: 6 };
  optionalOptions = [optional];
  render(<CompletionPanel service={service} products={[...catalog, optional]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getByText('Add protocol action...').parentElement, { target: { value: `lawn-plan-${optional.id}` } });
  await waitFor(() => expect(totals()).toHaveLength(3));
  const selects = within(totals()[2].parentElement).getAllByRole('combobox');
  // Rate unit, amount unit and method come from the catalog row (Codex r6 P1:
  // a bare { id, name } read Hydretain's fl_oz as oz and broke the inventory
  // conversion). The quantity itself stays an actual for the tech to enter.
  expect(selects.slice(0, 3).map((select) => select.value)).toEqual(['fl_oz', 'fl_oz', 'broadcast_spray']);
  expect(totals()[2].value).toBe('');
  expect(screen.getAllByPlaceholderText('Rate')[2].value).toBe('');
});
