// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LawnAssessmentPanel from './LawnAssessmentPanel';
import { CompletionPanel } from './SchedulePage';

const scores = { turf_density: 80, weed_suppression: 80, color_health: null, fungus_control: 85, thatch_level: 85, stress_damage: 85 };
const assessment = { id: 'fixture-assessment', confirmed_by_tech: false, ...scores };
const message = 'Scores saved. Complete the missing scores before confirming.';
const service = { id: 'fixture-service', customerId: 'fixture-customer', serviceType: 'Every 6 Weeks Lawn Care Service', completionProfile: { serviceKey: 'lawn', requiresProducts: false }, scheduledDate: '2026-09-09', status: 'on_site', price: 0 };
let confirmation;
let loadedAssessment;
let analysisScores;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'fixture-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
  localStorage.setItem('lawn_guide_seen', '1');
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('Image', class { width = 1; height = 1; set src(_value) { queueMicrotask(() => this.onload?.()); } });
  confirmation = { success: true, confirmed: false, missingScores: ['color_health'], assessment };
  loadedAssessment = assessment;
  analysisScores = scores;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('lawn-assessment/customers')) data = { customers: [{ id: 'fixture-customer', firstName: 'Fixture', lastName: 'Lawn' }] };
    if (url.includes('lawn-assessment/service/')) data = { assessment: loadedAssessment };
    if (url.endsWith('lawn-assessment/assess')) data = { assessment, adjustedScores: analysisScores, displayScores: analysisScores };
    if (url.endsWith('lawn-assessment/confirm')) data = confirmation;
    if (url.includes('lawn-assessment/history')) data = { history: [] };
    if (url.includes('treatment-plans')) data = { plan: { protocol: {}, mixCalculator: { items: [] } } };
    if (url.includes('property-map')) data = { available: false, stationsLoaded: true };
    if (url.includes('completion-actions')) data = { actions: [] };
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the field panel editable after a pending save and accepts a later legacy success response', async () => {
  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText('Fixture Lawn'));
  fireEvent.change(view.container.querySelector('input[type="file"]'), {
    target: { files: [new File(['fixture'], 'lawn.jpg', { type: 'image/jpeg' })] },
  });
  const analyze = await screen.findByRole('button', { name: /Analyze 1 Photo/ });
  fireEvent.click(analyze);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm Scores' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(message));
  expect(screen.queryByText('0%')).toBeNull();
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Retake' }).disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Confirm Scores' }).disabled).toBe(false);

  // Existing deployments omit the new top-level confirmed field.
  confirmation = { success: true, assessment: { ...assessment, confirmed_by_tech: true } };
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Scores' }));
  await screen.findByRole('button', { name: 'Done' });
  expect(alert).toHaveBeenLastCalledWith('Assessment confirmed.');
});

it('allows explicit technician scores when analysis returned no scores', async () => {
  analysisScores = null;
  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText('Fixture Lawn'));
  fireEvent.change(view.container.querySelector('input[type="file"]'), {
    target: { files: [new File(['fixture'], 'lawn.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Analyze 1 Photo/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Increase Turf Density' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decrease Fungus Control' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Scores' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(message));
  const sent = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(sent.adjustedScores).toEqual({ turf_density: 5, fungus_control: 0 });
  // Untouched unavailable metrics remain unknown, never invented defaults.
  expect(screen.getAllByText('—')).toHaveLength(8);
});

it('keeps a pending assessment out of closeout and allows a later completed confirmation', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('Fixture submit'));
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={submit} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText(message);
  expect(screen.queryByText('0/100')).toBeNull();
  expect(screen.getByText('—')).toBeTruthy();
  const confirmBody = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(confirmBody.adjustedScores.color_health).toBeNull();
  expect(screen.queryByText('Assessment confirmed')).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirm assessment' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /complete & send recap/i }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1].lawnAssessmentId).toBeNull();

  confirmation = { success: true, confirmed: true, assessment: { ...assessment, confirmed_by_tech: true, color_health: 75 } };
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
  expect(screen.queryByText(message)).toBeNull();
});

it.each([null, 0])('preserves an unavailable or genuinely zero score when reloading and posting: %s', async (value) => {
  const expected = Object.fromEntries(Object.keys(scores).map((key) => [key, value]));
  loadedAssessment = { ...assessment, ...expected };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  const confirm = await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(screen.getAllByText(value == null ? '—' : '0/100')).toHaveLength(value == null ? 6 : 4);
  fireEvent.click(confirm);
  await screen.findByText(message);
  const sent = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(sent.adjustedScores).toEqual(expected);
});

it('lets the technician supply every missing confirmation score without changing known AI components', async () => {
  loadedAssessment = { ...assessment, color_health: 80, fungus_control: null, thatch_level: null };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  const confirm = await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(screen.getAllByText('—')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Increase Fungus control' }));
  fireEvent.click(screen.getByRole('button', { name: 'Increase Thatch condition' }));
  // Both controls remain editable until saving, including correcting an entry.
  fireEvent.click(screen.getByRole('button', { name: 'Increase Fungus control' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decrease Fungus control' }));
  fireEvent.click(confirm);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('lawn-assessment/confirm'))).toBe(true));
  const sent = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(sent.adjustedScores).toEqual({
    turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: 85,
    fungus_control: 5, thatch_level: 5,
  });
});

it('keeps known underlying scores out of the normal four-control workflow', async () => {
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(screen.queryByRole('button', { name: 'Increase Fungus control' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Increase Thatch condition' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /^Increase / })).toHaveLength(4);
});
