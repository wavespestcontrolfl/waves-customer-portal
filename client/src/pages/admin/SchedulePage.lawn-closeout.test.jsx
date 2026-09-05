// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompletionPanel } from './SchedulePage';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const products = [{ id: 'test-k', name: 'Test liquid fertilizer', category: 'fertilizer', rate_unit: 'fl_oz', default_rate_per_1000: 99 }];
const service = { id: 'test-visit', customerId: 'test-property', serviceType: 'Every 6 Weeks Lawn Care Service', completionProfile: { serviceKey: 'lawn', requiresProducts: true }, scheduledDate: '2026-09-05', waveguardTier: 'Silver', status: 'on_site', price: 0 };
let submit;
let planResolvers;
let delayPlan;
let mixAmount;
let improvementsEnabled;
let history;
beforeEach(async () => {
  history = [{ confirmed_by_tech: true, service_date: '2026-07-10', overall_score: 81 }];
  improvementsEnabled = true;
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  window.history.replaceState({}, '', '/?completionImprovements=1');
  vi.stubGlobal('alert', vi.fn());
  delayPlan = false;
  mixAmount = 15;
  planResolvers = [];
  submit = vi.fn().mockRejectedValue(new Error('Synthetic submit'));
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: { 'lawn-completion-improvements': improvementsEnabled } };
    if (url.includes('turf-profile')) data = { profile: { lawn_sqft: 5000 } };
    if (url.includes('lawn-assessment/service')) data = { assessment: { id: 'assessment-current', confirmed_by_tech: true, turf_density: 82, weed_suppression: 85, color_health: 85, stress_damage: 80 } };
    if (url.includes('lawn-assessment/history')) data = { history };
    if (url.includes('treatment-plans')) {
      if (delayPlan) await new Promise((resolve) => { planResolvers.push(resolve); });
      data = { plan: { protocol: {}, mixCalculator: { items: [{ product: products[0], mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: mixAmount, amountUnit: 'fl_oz', treatedSqft: 5000 } }] } } };
    }
    if (url.includes('tech-tips')) data = { available: true, groups: [{ id: 'lawn', label: 'Lawn care', tips: [{ id: 'lawn_water_morning', label: 'Water in the morning', copy: 'Use the morning irrigation window.' }] }] };
    if (url.includes('completion-actions')) data = { actions: [] };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    return { ok: true, json: async () => data };
  }));
  await refetchFlags();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<CompletionPanel service={service} products={products} onClose={() => {}} onSubmit={submit} />);

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
