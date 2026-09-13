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
let delayFlags;
let flagResolvers;
beforeEach(async () => {
  delayFlags = false;
  flagResolvers = [];
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
    if (url.includes('feature-flags')) {
      if (delayFlags) await new Promise((resolve) => { flagResolvers.push(resolve); });
      data = { flags: { 'lawn-completion-improvements': improvementsEnabled } };
    }
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
          items, options: [...items, ...optionalOptions.map(({ applicationMethod, ...product }) => ({ product: { id: product.id, name: product.name }, applicationMethod }))], propertyMatchesProfile: true,
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

it('keeps removed defaults out of the plan after refresh and submits them as skipped products, named from the catalog when the refreshed plan no longer lists them', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  // The refreshed plan drops the removed product entirely (Codex #4113 P2):
  // its id must still reach the server's unlisted-skip audit with a name.
  catalog = [secondProduct];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(screen.queryByText('Updating plan suggestions…')).toBeNull());
  expect(totals()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].lawnProtocolCompletion).toEqual({
    treatedSqft: 5000,
    skippedProducts: [{ productId: products[0].id, productName: products[0].name }],
  });
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
  // manual-unit: the derived 5 was fl oz; under the tech's gallons it is
  // withdrawn rather than kept or re-derived (Codex r8 P1).
  const expectedAmount = { calculated: '4', 'manual-amount': '7', 'manual-unit': '', 'partial-zones': '', 'measured-zones': '1' }[mode];
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['12', '8', expectedAmount]));
  if (mode === 'manual-unit') expect(within(totals()[2].parentElement).getAllByRole('combobox')[1].value).toBe('gal');
});

// A hand-added product is ungoverned: its catalog per-1k rate and the derived
// total prefill as on a non-defaults closeout (owner 2026-09-11); the tech
// confirms rather than retypes, and an edit still re-derives / withdraws as
// the manual-add case above pins.
it('a manually added product with a catalog per-1k rate prefills its rate and derived total', async () => {
  enableDefaults();
  const added = { id: 'manual-talak', name: 'Fixture bifenthrin', category: 'insecticide', rate_unit: 'fl_oz', default_rate_per_1000: '0.5000', min_label_rate_per_1000: 0.25, max_label_rate_per_1000: 1 };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  expect(screen.getAllByPlaceholderText('Rate')[2].value).toBe('0.5');
  expect(screen.getAllByPlaceholderText('Sq ft')[2].value).toBe('5000');
  expect(totals()[2].value).toBe('2.5');
  expect(screen.getByText('Suggested from the label rate for the visit area. Confirm the actual amount.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /complete & send recap/i }).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals()[2].value).toBe('2'));
  fireEvent.click(await screen.findByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[2]).toMatchObject({ productId: 'manual-talak', rate: 0.5, rateUnit: 'fl_oz', totalAmount: 2, amountUnit: 'fl_oz', areaValue: '4000' });
});

// A per-gallon rate is a tank concentration; gallons of finished mix turn it
// into an applied quantity. One tank serves the whole mix, so gallons typed on
// one row fill the other per-gallon rows that are still blank.
it('a per-gallon product derives its total from gallons mixed, and shares them across the tank', async () => {
  enableDefaults();
  const taurus = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  const surfactant = { id: 'manual-surf', name: 'Fixture surfactant', category: 'adjuvant', default_unit: 'fl_oz/gal', default_rate: '0.5' };
  render(<CompletionPanel service={service} products={[...catalog, taurus, surfactant]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2));
  let count = 2;
  for (const product of [taurus, surfactant]) {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    count += 1;
    await waitFor(() => expect(totals()).toHaveLength(count));
  }
  // The label band's low end prefills the rate; the total waits for gallons.
  expect(screen.getAllByPlaceholderText('Rate')[2].value).toBe('0.8');
  expect(totals()[2].value).toBe('');
  expect(totals()[3].value).toBe('');
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  // Typed once: the second per-gallon row took the same tank volume.
  expect(screen.getAllByPlaceholderText('Gal')[1].value).toBe('25');
  expect(totals()[3].value).toBe('12.5');
  // A hand-entered total is the actual and survives a gallons change.
  fireEvent.change(totals()[3], { target: { value: '14' } });
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '30' } });
  await waitFor(() => expect(totals()[2].value).toBe('24'));
  expect(totals()[3].value).toBe('14');
  fireEvent.click(await screen.findByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[2]).toMatchObject({ productId: 'manual-taurus', rate: 0.8, rateUnit: 'fl_oz/gal', totalAmount: 24, amountUnit: 'fl_oz' });
  expect(submit.mock.calls[0][1].products[2].carrierGallons).toBeUndefined();
});

// The other order: gallons first, then a second tank product is remembered.
// Adding it must not ask for the same tank volume again (pre-push audit P1).
it('a per-gallon product added after the gallons were typed joins the same tank', async () => {
  enableDefaults();
  const taurus = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  const surfactant = { id: 'manual-surf', name: 'Fixture surfactant', category: 'adjuvant', default_unit: 'fl_oz/gal', default_rate: '0.5' };
  render(<CompletionPanel service={service} products={[...catalog, taurus, surfactant]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: taurus.name } });
  fireEvent.click(screen.getByText(taurus.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: surfactant.name } });
  fireEvent.click(screen.getByText(surfactant.name));
  await waitFor(() => expect(totals()).toHaveLength(4));
  expect(screen.getAllByPlaceholderText('Gal')[1].value).toBe('25');
  expect(totals()[3].value).toBe('12.5');
});

// A correction to the tank must reach the rows that only followed it; a row
// the tech gave its own gallons stops following (pre-push audit P1).
it('a corrected tank volume cascades to followers and spares a row with its own gallons', async () => {
  enableDefaults();
  const taurus = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  const surfactant = { id: 'manual-surf', name: 'Fixture surfactant', category: 'adjuvant', default_unit: 'fl_oz/gal', default_rate: '0.5' };
  render(<CompletionPanel service={service} products={[...catalog, taurus, surfactant]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  let count = 2;
  for (const product of [taurus, surfactant]) {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    count += 1;
    await waitFor(() => expect(totals()).toHaveLength(count));
  }
  const gal = () => screen.getAllByPlaceholderText('Gal');
  fireEvent.change(gal()[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[3].value).toBe('12.5'));
  // The follower tracks the correction rather than freezing at 25.
  fireEvent.change(gal()[0], { target: { value: '30' } });
  await waitFor(() => expect(totals()[2].value).toBe('24'));
  expect(gal()[1].value).toBe('30');
  expect(totals()[3].value).toBe('15');
  // Its own gallons make it independent of the next correction.
  fireEvent.change(gal()[1], { target: { value: '10' } });
  await waitFor(() => expect(totals()[3].value).toBe('5'));
  fireEvent.change(gal()[0], { target: { value: '40' } });
  await waitFor(() => expect(totals()[2].value).toBe('32'));
  expect(gal()[1].value).toBe('10');
  expect(totals()[3].value).toBe('5');
});

// Three rows: a follower given its own gallons detaches alone and leaves the
// rows still following the tank owner alone (Codex r1 P1).
it('a follower given its own gallons does not drag the tank\'s other followers', async () => {
  enableDefaults();
  const mk = (id, rate) => ({ id, name: `Fixture tank ${id}`, category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: rate });
  const [a, b, c] = [mk('tank-a', '1'), mk('tank-b', '2'), mk('tank-c', '4')];
  render(<CompletionPanel service={service} products={[...catalog, a, b, c]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  let count = 2;
  for (const product of [a, b, c]) {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    count += 1;
    await waitFor(() => expect(totals()).toHaveLength(count));
  }
  const gal = () => screen.getAllByPlaceholderText('Gal');
  fireEvent.change(gal()[0], { target: { value: '25' } });
  await waitFor(() => expect(totals().slice(2).map(i => i.value)).toEqual(['25', '50', '100']));
  // B goes on its own 10-gallon mix; C stays on A's tank.
  fireEvent.change(gal()[1], { target: { value: '10' } });
  await waitFor(() => expect(totals()[3].value).toBe('20'));
  expect(gal()[2].value).toBe('25');
  expect(totals()[4].value).toBe('100');
  // Clearing B's override rejoins it to A's tank immediately, rather than
  // leaving it blank until A is edited again (Codex r4 P2).
  fireEvent.change(gal()[1], { target: { value: '' } });
  await waitFor(() => expect(gal()[1].value).toBe('25'));
  expect(totals()[3].value).toBe('50');
  fireEvent.change(gal()[1], { target: { value: '10' } });
  await waitFor(() => expect(totals()[3].value).toBe('20'));
  // A second edit on detached B still leaves C alone — typing "12" is two
  // edits, and the first must not make B an owner (pre-push audit P1).
  fireEvent.change(gal()[1], { target: { value: '12' } });
  await waitFor(() => expect(totals()[3].value).toBe('24'));
  expect(gal()[2].value).toBe('25');
  expect(totals()[4].value).toBe('100');
  // A's correction still reaches C, and still not independent B.
  fireEvent.change(gal()[0], { target: { value: '30' } });
  await waitFor(() => expect(totals()[4].value).toBe('120'));
  expect(gal()[1].value).toBe('12');
  expect(totals()[3].value).toBe('24');
  // A follower's dose is labelled by its own rate, never by a hand-picked
  // unit — 160 fl oz, never "160 gal" (pre-push audit P1).
  const cUnit = () => within(totals()[4].parentElement).getAllByRole('combobox')[1];
  fireEvent.change(cUnit(), { target: { value: 'gal' } });
  expect(cUnit().value).toBe('fl_oz');
  fireEvent.change(gal()[0], { target: { value: '40' } });
  await waitFor(() => expect(totals()[4].value).toBe('160'));
  expect(cUnit().value).toBe('fl_oz');
});

// A per-gallon row on a NON-lawn lane (pest perimeter: area unit linear_ft)
// never reached the lawn rate-unit branch, so the tank total and the hidden
// gallons survived the unit change (Codex r1 P1).
it('leaving per-gallon clears the tank on a non-lawn row too', async () => {
  const shrubs = { ...service, serviceType: 'Tree & Shrub Care', completionProfile: { serviceKey: 'tree_shrub', requiresProducts: true }, waveguardTier: null };
  const added = { id: 'manual-demand', name: 'Fixture foliar product', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  render(<CompletionPanel service={shrubs} products={[added]} onClose={() => {}} onSubmit={submit} />);
  fireEvent.change(await screen.findByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(1));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[0].value).toBe('20'));
  const unit = () => within(totals()[0].parentElement).getAllByRole('combobox')[0];
  fireEvent.change(unit(), { target: { value: 'g' } });
  expect(totals()[0].value).toBe('');
  expect(screen.queryAllByPlaceholderText('Gal')).toHaveLength(0);
  // Back to per-gallon: no stale 25 gallons revives a quantity.
  fireEvent.change(unit(), { target: { value: 'fl_oz/gal' } });
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('');
  expect(totals()[0].value).toBe('');
});

// A hand-picked amount unit must not relabel a derived tank dose: 0.8 fl oz/gal
// x 30 is not "24 gal" (Codex r1 P1).
it('changing the amount unit withdraws a derived tank total', async () => {
  enableDefaults();
  const added = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  const amountUnit = () => within(totals()[2].parentElement).getAllByRole('combobox')[1];
  // The unit of a derived tank dose is the rate's: 0.8 fl_oz/gal x 25 is
  // 20 fl oz and can never be relabelled 20 gal, which would deduct the wrong
  // inventory quantity. Entering a total is how the tech takes the unit.
  fireEvent.change(amountUnit(), { target: { value: 'gal' } });
  expect(totals()[2].value).toBe('20');
  expect(amountUnit().value).toBe('fl_oz');
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '30' } });
  expect(totals()[2].value).toBe('24');
  expect(amountUnit().value).toBe('fl_oz');
  fireEvent.change(totals()[2], { target: { value: '26' } });
  fireEvent.change(amountUnit(), { target: { value: 'gal' } });
  expect(totals()[2].value).toBe('26');
  expect(amountUnit().value).toBe('gal');
});

// The governed area and method handlers blank derived totals the plan cannot
// express; a measured tank dose is not one of them (Codex r1 P1).
it('a tank dose survives an application-area and a method change', async () => {
  enableDefaults();
  const added = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Back yard', exact: true }).at(-1));
  expect(totals()[2].value).toBe('20');
  fireEvent.change(within(totals()[2].parentElement).getAllByRole('combobox')[2], { target: { value: 'spot_treatment' } });
  expect(totals()[2].value).toBe('20');
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('25');
});

// Small doses keep the precision the record stores (Codex r1 P2).
it('a fractional tank dose keeps its precision', async () => {
  enableDefaults();
  const added = { id: 'manual-micro', name: 'Fixture micro dose', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.03' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '0.5' } });
  await waitFor(() => expect(totals()[2].value).toBe('0.015'));
});

// A product added while one row sits on its own mix takes the TANK's volume,
// not the detached row's (pre-push audit P1).
it('a new product seeds from the tank owner, not a detached row', async () => {
  enableDefaults();
  const mk = (id, rate) => ({ id, name: `Fixture seed ${id}`, category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: rate });
  const [a, b, c] = [mk('seed-a', '1'), mk('seed-b', '2'), mk('seed-c', '4')];
  render(<CompletionPanel service={service} products={[...catalog, a, b, c]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  const add = async (product, expected) => {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    await waitFor(() => expect(totals()).toHaveLength(expected));
  };
  await add(a, 3);
  await add(b, 4);
  const gal = () => screen.getAllByPlaceholderText('Gal');
  // B sets the tank; A then goes on its own mix and detaches.
  fireEvent.change(gal()[1], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('25'));
  fireEvent.change(gal()[0], { target: { value: '10' } });
  await waitFor(() => expect(totals()[2].value).toBe('10'));
  await add(c, 5);
  expect(gal()[2].value).toBe('25');
  expect(totals()[4].value).toBe('100');
});

// A tank dose comes from the tank, not the square footage: neither a typed
// product area nor a visit-area refresh may erase it (audit P1).
it('a tank total survives product-area and visit-area changes', async () => {
  enableDefaults();
  const added = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  const card = () => within(totals()[2].parentElement);
  fireEvent.change(card().getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
  expect(totals()[2].value).toBe('20');
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals()[0].value).toBe('12'));
  expect(totals()[2].value).toBe('20');
});

// The governed path: a plan row whose suggested amount is unavailable, given
// an actual rate and gallons, keeps its dose through a plan refresh — the
// reconciliation used to blank every derived total the plan could not express
// (Codex r1 P1).
it('a governed plan row keeps its tank dose through a plan refresh', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const card = () => within(totals()[0].parentElement);
  // The tech records what actually went out: a tank concentration.
  fireEvent.change(card().getAllByRole('combobox')[0], { target: { value: 'fl_oz/gal' } });
  fireEvent.change(card().getByPlaceholderText('Rate'), { target: { value: '0.8' } });
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[0].value).toBe('20'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await waitFor(() => expect(totals()[1].value).toBe('10'));
  expect(totals()[0].value).toBe('20');
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('25');
  fireEvent.click(await screen.findByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[0]).toMatchObject({ rate: '0.8', rateUnit: 'fl_oz/gal', totalAmount: 20, amountUnit: 'fl_oz' });
});

// Removing the tank's owner leaves its followers holding the same mix: the
// next product added joins that tank rather than asking again (Codex r2 P2).
it('the shared tank survives removing the row that owned it', async () => {
  enableDefaults();
  const mk = (id, rate) => ({ id, name: `Fixture heir ${id}`, category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: rate });
  const [a, b, c] = [mk('heir-a', '1'), mk('heir-b', '2'), mk('heir-c', '4')];
  render(<CompletionPanel service={service} products={[...catalog, a, b, c]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  const add = async (product, expected) => {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    await waitFor(() => expect(totals()).toHaveLength(expected));
  };
  await add(a, 3);
  await add(b, 4);
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[3].value).toBe('50'));
  // A owned the tank; remove it and B still holds the same 25-gallon mix.
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[2]);
  await waitFor(() => expect(totals()).toHaveLength(3));
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('25');
  await add(c, 4);
  expect(screen.getAllByPlaceholderText('Gal')[1].value).toBe('25');
  expect(totals()[3].value).toBe('100');
});

// An owner that leaves per-gallon frees the slot just like removal does; the
// rows still on its mix keep the tank, so a detached row's next edit cannot
// propagate over them (pre-push audit P1).
it('the tank survives its owner changing rate unit, and a detached row still cannot claim it', async () => {
  enableDefaults();
  const mk = (id, rate) => ({ id, name: `Fixture unit ${id}`, category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: rate });
  const [a, b, c] = [mk('unit-a', '1'), mk('unit-b', '2'), mk('unit-c', '4')];
  render(<CompletionPanel service={service} products={[...catalog, a, b, c]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  let count = 2;
  for (const product of [a, b, c]) {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    count += 1;
    await waitFor(() => expect(totals()).toHaveLength(count));
  }
  const gal = () => screen.getAllByPlaceholderText('Gal');
  fireEvent.change(gal()[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[4].value).toBe('100'));
  fireEvent.change(gal()[1], { target: { value: '10' } });
  await waitFor(() => expect(totals()[3].value).toBe('20'));
  // A owned the tank; take it off per-gallon and C keeps the 25-gallon mix.
  fireEvent.change(within(totals()[2].parentElement).getAllByRole('combobox')[0], { target: { value: 'fl_oz' } });
  await waitFor(() => expect(screen.getAllByPlaceholderText('Gal')).toHaveLength(2));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '12' } });
  await waitFor(() => expect(totals()[3].value).toBe('24'));
  expect(screen.getAllByPlaceholderText('Gal')[1].value).toBe('25');
  expect(totals()[4].value).toBe('100');
});

// Converting a row into a per-gallon rate joins the mix already in the tank,
// and clearing the tank lets the next entry establish it again (Codex r3 P2).
it('a row converted to per-gallon joins the tank, and clearing the tank frees it', async () => {
  enableDefaults();
  const mk = (id, rate, unit) => ({ id, name: `Fixture join ${id}`, category: 'insecticide', ...(unit === 'gal' ? { default_unit: 'fl_oz/gal', default_rate: rate } : { rate_unit: 'fl_oz', default_rate_per_1000: rate }) });
  const [a, b] = [mk('join-a', '0.8', 'gal'), mk('join-b', '2')];
  render(<CompletionPanel service={service} products={[...catalog, a, b]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  let count = 2;
  for (const product of [a, b]) {
    fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
    fireEvent.click(screen.getByText(product.name));
    count += 1;
    await waitFor(() => expect(totals()).toHaveLength(count));
  }
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  // B is a per-1k product; switching it to a tank concentration joins the mix.
  fireEvent.change(within(totals()[3].parentElement).getAllByRole('combobox')[0], { target: { value: 'fl_oz/gal' } });
  await waitFor(() => expect(screen.getAllByPlaceholderText('Gal')).toHaveLength(2));
  expect(screen.getAllByPlaceholderText('Gal')[1].value).toBe('25');
  expect(totals()[3].value).toBe('50');
  // Clearing the tank clears both doses and frees the owner slot, so an entry
  // on the other row establishes the tank again rather than detaching.
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '' } });
  await waitFor(() => expect(totals()[2].value).toBe(''));
  expect(totals()[3].value).toBe('');
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[1], { target: { value: '10' } });
  await waitFor(() => expect(totals()[3].value).toBe('20'));
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('10');
  expect(totals()[2].value).toBe('8');
});

// The recurring-pest default mix seeds house totals marked manual so a rate or
// area edit cannot recompute them. Stating the carrier volume is the tech
// saying what actually went out, so the seed gives way (Codex r5 P1).
it('gallons replace a seeded pest-mix total', async () => {
  const pest = { ...service, serviceType: 'Quarterly Pest Control', completionProfile: { serviceKey: 'pest', requiresProducts: true }, waveguardTier: null };
  const surfactant = { id: 'mix-surf', name: 'Non-ionic surfactant', category: 'adjuvant', default_unit: 'fl_oz/gal', default_rate: '0.5' };
  render(<CompletionPanel service={pest} products={[surfactant]} onClose={() => {}} onSubmit={submit} />);
  // Seeded at the house total of 0.25, with a per-gallon rate.
  await waitFor(() => expect(totals()).toHaveLength(1));
  expect(totals()[0].value).toBe('0.25');
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '10' } });
  await waitFor(() => expect(totals()[0].value).toBe('5'));
  // Derived from here on: a correction tracks rather than sticking at 5.
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '20' } });
  await waitFor(() => expect(totals()[0].value).toBe('10'));
});

it('a rate unit moving off per-gallon does not strand the tank total', async () => {
  enableDefaults();
  const added = { id: 'manual-taurus', name: 'Fixture termiticide', category: 'insecticide', default_unit: 'fl_oz/gal', default_rate: '0.8' };
  render(<CompletionPanel service={service} products={[...catalog, added]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2), { timeout: 5000 });
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: added.name } });
  fireEvent.click(screen.getByText(added.name));
  await waitFor(() => expect(totals()).toHaveLength(3));
  fireEvent.change(screen.getAllByPlaceholderText('Gal')[0], { target: { value: '25' } });
  await waitFor(() => expect(totals()[2].value).toBe('20'));
  // 20 fl oz of tank mix is not 0.8 fl oz per 1,000 sq ft of anything.
  fireEvent.change(within(totals()[2].parentElement).getAllByRole('combobox')[0], { target: { value: 'fl_oz' } });
  expect(totals()[2].value).toBe('4');
  expect(screen.queryAllByPlaceholderText('Gal')).toHaveLength(0);
  // Back again: the old tank volume is gone, so nothing re-drives a
  // quantity from a stale 25 gallons (pre-push audit P1).
  fireEvent.change(within(totals()[2].parentElement).getAllByRole('combobox')[0], { target: { value: 'fl_oz/gal' } });
  expect(screen.getAllByPlaceholderText('Gal')[0].value).toBe('');
  expect(totals()[2].value).toBe('');
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
  // conversion). An optional row is added by hand, so its catalog per-1k rate
  // and the derived total prefill like any other manual add (owner
  // 2026-09-11); the quantity stays the tech's actual to confirm or edit.
  expect(selects.slice(0, 3).map((select) => select.value)).toEqual(['fl_oz', 'fl_oz', 'broadcast_spray']);
  expect(screen.getAllByPlaceholderText('Rate')[2].value).toBe('6');
  expect(totals()[2].value).toBe('30');
});

it.each([
  ['broadcast_spray', 'broadcast_spray'],
  [undefined, 'spot_treatment'],
])('an added herbicide records the protocol row\'s application mode (%s → %s), not the catalog category\'s spot default', async (applicationMethod, expected) => {
  enableDefaults();
  const optional = { id: 'test-speedzone', name: 'SpeedZone', category: 'herbicide', rate_unit: 'fl_oz', default_rate_per_1000: 1.5, applicationMethod };
  optionalOptions = [optional];
  const { applicationMethod: _mode, ...catalogRow } = optional;
  render(<CompletionPanel service={service} products={[...catalog, catalogRow]} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.change(screen.getByText('Add protocol action...').parentElement, { target: { value: `lawn-plan-${optional.id}` } });
  await waitFor(() => expect(totals()).toHaveLength(3));
  const selects = within(totals()[2].parentElement).getAllByRole('combobox');
  // The option's mode governs the row (Codex r7 P1): SpeedZone is a broadcast
  // herbicide in its window while the catalog category alone reads it as spot
  // work. Without a mode on the option the catalog default still applies.
  expect(selects[2].value).toBe(expected);
  // Broadcast derives the label total over the visit area; spot work has no
  // area to derive against, so the tech enters the actual.
  expect(totals()[2].value).toBe(expected === 'broadcast_spray' ? '7.5' : '');
});

it('changing only the amount unit withdraws a plan-suggested total: blank through a refresh and a rate edit, and a typed total keeps its number under the chosen unit', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  const unitOf = (index) => within(totals()[index].parentElement).getAllByRole('combobox')[1];
  fireEvent.change(unitOf(0), { target: { value: 'gal' } });
  // The suggestion was 15 fl oz; 15 gal must never stand (Codex r8 P1).
  expect(totals()[0].value).toBe('');
  expect(unitOf(0).value).toBe('gal');
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals()[1].value).toBe('8'));
  expect(totals()[0].value).toBe('');
  expect(unitOf(0).value).toBe('gal');
  // The untouched product area still follows the visit (Codex r9 P1): a unit
  // choice alone does not freeze the row's rate or treated area.
  expect(screen.getAllByPlaceholderText('Sq ft')[0].value).toBe('4000');
  // A rate edit derives the total in the RATE's unit — not under the tech's gallons.
  fireEvent.change(screen.getAllByPlaceholderText('Rate')[0], { target: { value: '4' } });
  expect(totals()[0].value).toBe('');
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  fireEvent.change(totals()[0], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products[0]).toMatchObject({ productId: 'test-k', totalAmount: '2', amountUnit: 'gal', rate: '4' });
});

it('a draft restored during a plan outage withdraws the suggestions saved under the earlier plan', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(totals()[0], { target: { value: '9' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).selectedProducts[0].totalAmount).toBe('9'));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  // The entered 9 survives; the saved 10 was a suggestion the failed plan can
  // no longer stand behind (Codex r8 P1).
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '']));
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  // The saved application mode was that plan's suggestion too: the tech must
  // confirm it even after entering the amount and area (Codex r12 P1).
  const methodOf = (index) => within(totals()[index].parentElement).getAllByRole('combobox')[2];
  expect(totals().map((_, index) => methodOf(index).value)).toEqual(['', '']);
  expect(screen.queryAllByPlaceholderText('Sq ft')).toHaveLength(0);
  failPlan = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry plan' }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '10']));
  expect(totals().map((_, index) => methodOf(index).value)).toEqual(['broadcast_spray', 'broadcast_spray']);
});

it('a governed draft restored before a delayed initial plan failure withdraws its saved application mode when that request fails', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(totals()[0], { target: { value: '9' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).selectedProducts[0].totalAmount).toBe('9'));
  view.unmount();
  delayPlan = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '10']));
  await waitFor(() => expect(planResolvers).toHaveLength(1));
  // The request this restore raced was the visit's first: its failure leaves
  // the saved method unverified exactly as a restore after the failure would
  // (pre-push audit P1 on Codex r12).
  failPlan = true;
  await act(async () => { planResolvers[0](); });
  await screen.findByText('Lawn plan unavailable.');
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '']));
  expect(totals().map(input => within(input.parentElement).getAllByRole('combobox')[2].value)).toEqual(['', '']);
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
});

it('a cold feature-flag cache defers the first plan request: no ungoverned legacy rows are seeded before the flag is known', async () => {
  enableDefaults();
  delayFlags = true;
  refetchFlags();
  mount();
  await waitFor(() => expect(flagResolvers).toHaveLength(1));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('turf-profile'))).toBe(true));
  // The member visit would otherwise fetch the plan without completion
  // defaults and seed legacy rows when the flag flipped (Codex r13 P1).
  expect(fetch.mock.calls.some(([url]) => String(url).includes('treatment-plans'))).toBe(false);
  expect(screen.queryAllByPlaceholderText('Total')).toHaveLength(0);
  await act(async () => { flagResolvers[0](); });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  // Governed rows: the visit-area refresh scales them and the protocol method is on.
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['12', '8']));
  expect(within(totals()[0].parentElement).getAllByRole('combobox')[2].value).toBe('broadcast_spray');
});

it('a governed draft restored under an initial plan outage still submits its removed defaults as skipped products, named from the catalog', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).lawnRemovedDefaultIds).toEqual([products[0].id]));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  const card = within(totals()[0].parentElement);
  fireEvent.change(card.getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } });
  fireEvent.change(card.getAllByRole('combobox')[1], { target: { value: 'fl_oz' } });
  fireEvent.change(card.getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
  fireEvent.change(totals()[0], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  // No plan loaded, yet the removed default reaches the server's unlisted-skip audit (Codex #4113 P2).
  expect(submit.mock.calls[0][1].lawnProtocolCompletion.skippedProducts).toEqual([{ productId: products[0].id, productName: products[0].name }]);
});

it('a governed draft restored under a plan outage keeps its removed defaults through the next autosave, and a second restore still submits them', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  const key = `waves_completion_draft_${service.id}`;
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).lawnRemovedDefaultIds).toEqual([products[0].id]));
  view.unmount();
  failPlan = true;
  const second = mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  // Typed input after the restore triggers the debounced autosave with no live defaults loaded.
  fireEvent.change(totals()[0], { target: { value: '2' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).selectedProducts?.[0]?.amount ?? JSON.parse(localStorage.getItem(key)).selectedProducts?.[0]?.totalAmount).toBeTruthy(), { timeout: 3000 });
  expect(JSON.parse(localStorage.getItem(key)).lawnRemovedDefaultIds).toEqual([products[0].id]);
  expect(JSON.parse(localStorage.getItem(key)).lawnRemovedDefaultNames).toEqual({ [products[0].id]: products[0].name });
  second.unmount();
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  const card = within(totals()[0].parentElement);
  fireEvent.change(card.getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } });
  fireEvent.change(card.getAllByRole('combobox')[1], { target: { value: 'fl_oz' } });
  fireEvent.change(card.getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
  fireEvent.change(totals()[0], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].lawnProtocolCompletion.skippedProducts).toEqual([{ productId: products[0].id, productName: products[0].name }]);
});

it('a removed default deleted from the catalog before the draft is restored is still submitted as a skipped product, named from the draft', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).lawnRemovedDefaultNames).toEqual({ [products[0].id]: products[0].name }));
  view.unmount();
  // Hard-deleted from the catalog and gone from the reloaded plan: no live lookup can name it.
  failPlan = true;
  catalog = [];
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  const card = within(totals()[0].parentElement);
  fireEvent.change(card.getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } });
  fireEvent.change(card.getAllByRole('combobox')[1], { target: { value: 'fl_oz' } });
  fireEvent.change(card.getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
  fireEvent.change(totals()[0], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].lawnProtocolCompletion.skippedProducts).toEqual([{ productId: products[0].id, productName: products[0].name }]);
});

it('a removed default re-added under a plan outage is applied, not skipped (pre-push audit P1)', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).lawnRemovedDefaultIds).toEqual([products[0].id]));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals()).toHaveLength(1));
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: products[0].name } });
  fireEvent.click(screen.getByText(products[0].name));
  await waitFor(() => expect(totals()).toHaveLength(2));
  totals().forEach((input) => {
    const card = within(input.parentElement);
    fireEvent.change(card.getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } });
    fireEvent.change(card.getAllByRole('combobox')[1], { target: { value: 'fl_oz' } });
    fireEvent.change(card.getByPlaceholderText('Sq ft'), { target: { value: '1000' } });
    fireEvent.change(input, { target: { value: '2' } });
  });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const payload = submit.mock.calls[0][1];
  expect(payload.products.map((row) => row.productId).sort()).toEqual([products[0].id, secondProduct.id].sort());
  expect(payload.lawnProtocolCompletion?.skippedProducts ?? []).toEqual([]);
});

it('changing only the rate unit withdraws a plan-suggested rate and total instead of relabeling them, and returning to the plan unit restores them', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  const rate = () => screen.getAllByPlaceholderText('Rate')[0];
  const rateUnit = () => within(totals()[0].parentElement).getAllByRole('combobox')[0];
  expect(rate().value).toBe('3');
  fireEvent.change(rateUnit(), { target: { value: 'lb' } });
  // 3 fl oz per 1,000 sq ft and 15 fl oz must never stand as 3 lb and 15 lb (Codex r12 P1).
  expect(rate().value).toBe('');
  expect(totals()[0].value).toBe('');
  expect(rateUnit().value).toBe('lb');
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  // A visit-area refresh cannot restore the withdrawn rate under the foreign unit; the area still follows.
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '4000' } });
  await waitFor(() => expect(totals()[1].value).toBe('8'));
  expect(rate().value).toBe('');
  expect(totals()[0].value).toBe('');
  expect(screen.getAllByPlaceholderText('Sq ft')[0].value).toBe('4000');
  fireEvent.change(rateUnit(), { target: { value: 'fl_oz' } });
  await waitFor(() => expect(rate().value).toBe('3'));
  expect(totals()[0].value).toBe('12');
});

it('a failed refresh that withdraws plan suggestions drops an untouched generated report', async () => {
  enableDefaults();
  mount();
  await waitFor(() => expect(totals()).toHaveLength(2));
  const notes = screen.getByPlaceholderText(/Notes about this service/);
  fireEvent.change(notes, { target: { value: 'Hand notes before generating.' } });
  fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]);
  await waitFor(() => expect(notes.value).toContain('Applied the old products.'));
  failPlan = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  await screen.findByText('Plan could not be refreshed. Enter actual amounts or retry.');
  // The withdrawn rows are a changed product payload: prose grounded in the old rate cannot ride along (Codex r12 P1).
  expect(totals().map(input => input.value)).toEqual(['', '']);
  expect(notes.value).not.toContain('Applied the old products.');
  expect(notes.value).toContain('Hand notes before generating.');
});

it('a tierless visit with governed defaults still requires every product\'s actual amount', async () => {
  enableDefaults();
  render(<CompletionPanel service={{ ...service, waveguardTier: null }} products={catalog} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(totals()[1], { target: { value: '' } });
  // No WaveGuard tier, but the server enabled completion defaults for the
  // explicit assignment: a governed row without an amount cannot close out
  // (Codex r8 P1).
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /complete & send recap/i })).toBeNull();
  fireEvent.change(totals()[1], { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products.map(product => product.totalAmount)).toEqual([15, '6']);
});

it('a governed draft restored on a tierless visit whose plan failed at open still requires every actual amount', async () => {
  enableDefaults();
  const tierless = { ...service, waveguardTier: null };
  const view = render(<CompletionPanel service={tierless} products={catalog} onClose={() => {}} onSubmit={submit} />);
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(totals()[0], { target: { value: '9' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).selectedProducts[0].totalAmount).toBe('9'));
  view.unmount();
  failPlan = true;
  render(<CompletionPanel service={tierless} products={catalog} onClose={() => {}} onSubmit={submit} />);
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '']));
  // No tier and no loaded defaults, yet the restored row carries a withdrawn
  // suggestion: it cannot close out without its actual (pre-push audit P1).
  expect(screen.getByRole('button', { name: /Product Actuals Required/ }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /complete & send recap/i })).toBeNull();
});

it('edits and removals on a governed draft restored under an initial plan outage survive a successful retry', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(totals()[0], { target: { value: '9' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).selectedProducts[0].totalAmount).toBe('9'));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['9', '']));
  // Defaults never loaded, but the rows are governed: a confirmed method, a
  // measured area and a removal recorded now must not be undone by the retry
  // (pre-push audit P1; the method is confirmed first — Codex r12 P1).
  fireEvent.change(within(totals()[1].parentElement).getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } });
  fireEvent.change(screen.getAllByPlaceholderText('Sq ft')[0], { target: { value: '1000' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(totals()).toHaveLength(1));
  failPlan = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry plan' }));
  await waitFor(() => expect(screen.queryByText('Lawn plan unavailable.')).toBeNull());
  await waitFor(() => expect(screen.queryByText('Updating plan suggestions…')).toBeNull());
  expect(totals()).toHaveLength(1);
  expect(screen.getAllByPlaceholderText('Sq ft')[0].value).toBe('1000');
});

it('a governed draft restored under an initial plan outage still submits its saved visit area', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '1000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['3', '2']));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).lawnAreaOverride).toBe('1000'));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['', '']));
  // The withdrawn rows ask for the method, the actual area and amount; the
  // visit area itself was restored from the draft.
  // The unverified plan's units went with its values (Codex r13 P1): the tech picks the amount unit too.
  totals().forEach((input) => fireEvent.change(within(input.parentElement).getAllByRole('combobox')[2], { target: { value: 'broadcast_spray' } }));
  totals().forEach((input) => fireEvent.change(within(input.parentElement).getAllByRole('combobox')[1], { target: { value: 'fl_oz' } }));
  screen.getAllByPlaceholderText('Sq ft').forEach((input) => fireEvent.change(input, { target: { value: '1000' } }));
  fireEvent.change(totals()[0], { target: { value: '3' } });
  fireEvent.change(totals()[1], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  // Defaults never loaded, but the entered 1,000 sq ft is the visit area the
  // server must plan and record against — not the full saved lawn.
  expect(submit.mock.calls[0][1].lawnProtocolCompletion).toEqual({ treatedSqft: 1000 });
});

it('an area-only governed draft (no default rows, nothing removed) restored under a plan outage is not deleted when a typed field is erased again', async () => {
  withdrawDefaults = true;
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(screen.getByLabelText('Area for this visit (sq ft)')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '1000' } });
  const key = `waves_completion_draft_${service.id}`;
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).lawnAreaOverride).toBe('1000'));
  view.unmount();
  failPlan = true;
  mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  // Typing mints this mount's snapshot; erasing it again re-evaluates the
  // draft. With no live defaults and nothing removed, the restored visit
  // area alone must keep the draft alive — before the fix the form read as
  // empty and the autosave deleted the draft, so a reload or billing detour
  // lost the measured area and the ledger recorded it as null.
  const notes = screen.getByPlaceholderText(/Notes about this service/);
  fireEvent.change(notes, { target: { value: 'x' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).notes).toBe('x'), { timeout: 3000 });
  fireEvent.change(notes, { target: { value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(key)).lawnAreaOverride).toBe('1000');
});

it('an area-only draft restored while the completion flag is still cold keeps its area once the flag resolves under a plan outage', async () => {
  withdrawDefaults = true;
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(screen.getByLabelText('Area for this visit (sq ft)')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '1000' } });
  const key = `waves_completion_draft_${service.id}`;
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).lawnAreaOverride).toBe('1000'));
  view.unmount();
  failPlan = true;
  delayFlags = true;
  refetchFlags();
  mount();
  await waitFor(() => expect(flagResolvers).toHaveLength(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  // While the flag is cold the flag-derived area clause reads false, so
  // the autosave's verdict on this draft is provisional. Typing and erasing
  // a field re-evaluates it in that state.
  const notes = screen.getByPlaceholderText(/Notes about this service/);
  fireEvent.change(notes, { target: { value: 'x' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).notes).toBe('x'), { timeout: 3000 });
  fireEvent.change(notes, { target: { value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // The flag resolves true while the plan request fails. The autosave
  // re-evaluates on the flag itself (a dependency since Codex #4365 r2):
  // the measured area is draft content under the resolved flag, so a later
  // erase cycle, unmount or reload cannot lose it.
  await act(async () => { flagResolvers[0](); });
  await screen.findByText('Lawn plan unavailable.');
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key) || 'null')?.lawnAreaOverride).toBe('1000'), { timeout: 3000 });
  fireEvent.change(notes, { target: { value: 'y' } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)).notes).toBe('y'), { timeout: 3000 });
  fireEvent.change(notes, { target: { value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(JSON.parse(localStorage.getItem(key) || 'null')?.lawnAreaOverride).toBe('1000');
}, 15000);

it('changing visits after a governed draft was restored under a plan outage drops the first visit\'s area and rows', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  fireEvent.change(screen.getByLabelText('Area for this visit (sq ft)'), { target: { value: '1000' } });
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['3', '2']));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`)).lawnAreaOverride).toBe('1000'));
  view.unmount();
  failPlan = true;
  const second = mount();
  await screen.findByText('Lawn plan unavailable.');
  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['', '']));
  failPlan = false;
  second.rerender(<CompletionPanel service={{ ...service, id: 'second-visit' }} products={catalog} onClose={() => {}} onSubmit={submit} />);
  // The second visit plans against its own saved lawn: no build request
  // carries the first visit's 1,000 sq ft, and its rows are its own.
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  expect(screen.getByLabelText('Area for this visit (sq ft)').value).toBe('5000');
  expect(fetch.mock.calls.filter(([url, options]) => url.includes('treatment-plans/second-visit') && options?.body)
    .map(([, options]) => JSON.parse(options.body).lawnSqft)).toEqual([]);
});

it('changing visits after a partial-zone edit gives the next visit its own full zones, saved area and defaults', async () => {
  enableDefaults();
  const view = mount();
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  const areas = document.getElementById('cp-areas-treated-desktop');
  fireEvent.click(areas);
  fireEvent.click(within(areas.parentElement).getByRole('button', { name: 'Back yard', exact: true }));
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['', '']));
  expect(screen.getByLabelText('Area for this visit (sq ft)').value).toBe('');
  view.rerender(<CompletionPanel service={{ ...service, id: 'second-visit' }} products={catalog} onClose={() => {}} onSubmit={submit} />);
  // The first visit's zone subset must not seed the second visit or clear its
  // saved lawn area (Codex r10 P1).
  await waitFor(() => expect(totals().map(input => input.value)).toEqual(['15', '10']));
  expect(screen.getByLabelText('Area for this visit (sq ft)').value).toBe('5000');
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].products.map(row => row.applicationArea)).toEqual(['Front yard, Back yard, Side yards', 'Front yard, Back yard, Side yards']);
});
