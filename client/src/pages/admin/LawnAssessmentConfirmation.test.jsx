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
let visitAssessment;
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
  visitAssessment = null;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('lawn-assessment/customers')) data = { customers: [{ id: 'fixture-customer', firstName: 'Fixture', lastName: 'Lawn' }] };
    if (url.includes('lawn-assessment/service/')) data = { assessment: loadedAssessment, visitAssessment };
    if (url.endsWith('lawn-assessment/assess')) data = { assessment, adjustedScores: analysisScores, displayScores: analysisScores, visitAssessment };
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

const savedVisit = () => ({
  runId: 'fixture-run', status: 'complete',
  findings: [{ finding_id: 'F1', name: 'Possible drought', confidence: 'low', photo_refs: [1], observed_evidence: ['Dry leaf blades'], confirmation_step: 'Check soil moisture' }],
  reviewedFindings: [{ finding_id: 'F1', keep: false, name: 'thinning turf', renamed: true, tech_note: 'Checked soil moisture' }],
  addedDetails: [{ finding_id: 'T3', name: 'Thin patch by front walkway', zone: 'front' }],
  observations: 'Photo observations',
  reconciliation: { products: [{ product_name: 'Stored treatment', addresses_findings: ['T3'] }] },
  photoQuality: [],
});

it('restores saved review decisions in closeout and preserves them across a pending confirmation', async () => {
  visitAssessment = savedVisit();
  loadedAssessment = { ...assessment, observations: 'Previously edited observations' };
  confirmation = { ...confirmation, visitAssessment };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText(message);
  let sent = JSON.parse(fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm')).at(-1)[1].body);
  expect(sent.reviewedFindings).toEqual([{ finding_id: 'F1', keep: false, name: 'thinning turf', tech_note: 'Checked soil moisture' }]);
  expect(sent.addedDetails).toEqual([{ text: 'Thin patch by front walkway', zone: 'front' }]);
  expect(sent).not.toHaveProperty('appliedProducts');
  expect(sent).not.toHaveProperty('observationEdit');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm'))).toHaveLength(2));
  sent = JSON.parse(fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm')).at(-1)[1].body);
  expect(sent.reviewedFindings[0]).toMatchObject({ finding_id: 'F1', keep: false, name: 'thinning turf' });
});

it('sends visit review state from the field panel and adopts saved decisions returned by confirmation', async () => {
  visitAssessment = savedVisit();
  confirmation = { ...confirmation, visitAssessment: { ...savedVisit(), reviewedFindings: [{ finding_id: 'F1', keep: true, name: 'Possible drought', renamed: false, tech_note: 'Saved note' }] } };
  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText('Fixture Lawn'));
  fireEvent.change(view.container.querySelector('input[type="file"]'), {
    target: { files: [new File(['fixture'], 'lawn.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Analyze 1 Photo/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm Scores' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(message));
  const first = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(first.reviewedFindings[0]).toMatchObject({ keep: false, name: 'thinning turf' });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Scores' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm'))).toHaveLength(2));
  const second = JSON.parse(fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm')).at(-1)[1].body);
  expect(second.reviewedFindings[0]).toEqual({ finding_id: 'F1', keep: true, name: null, tech_note: 'Saved note' });
});

it('shows a confirmed saved review read-only and preserves an explicitly cleared observation', async () => {
  visitAssessment = savedVisit();
  loadedAssessment = { ...assessment, confirmed_by_tech: true, observations: null };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByText('Assessment confirmed');
  const observation = screen.getByLabelText('Observation');
  expect(observation.value).toBe('');
  expect(observation.disabled).toBe(true);
  expect(screen.getByRole('checkbox', { name: 'Keep Possible drought' }).disabled).toBe(true);
  expect(screen.getByLabelText('Technician detail 1').disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Add detail' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Confirm assessment' })).toBeNull();
});

it('posts explicit empty observation edits and locks the field review after final confirmation', async () => {
  visitAssessment = savedVisit();
  confirmation = { success: true, confirmed: true, assessment: { ...assessment, observations: '', confirmed_by_tech: true }, visitAssessment };
  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText('Fixture Lawn'));
  fireEvent.change(view.container.querySelector('input[type="file"]'), {
    target: { files: [new File(['fixture'], 'lawn.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Analyze 1 Photo/ }));
  const observation = await screen.findByLabelText('Observation');
  fireEvent.change(observation, { target: { value: '' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep Possible drought' }));
  fireEvent.change(screen.getByLabelText('Technician note for Possible drought'), { target: { value: 'Confirmed in field' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove technician detail 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Scores' }));
  await screen.findByRole('button', { name: 'Done' });
  const sent = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(sent.observationEdit).toBe('');
  expect(sent.reviewedFindings[0]).toMatchObject({ keep: true, tech_note: 'Confirmed in field' });
  expect(sent.addedDetails).toEqual([]);
  expect(screen.getByLabelText('Observation').disabled).toBe(true);
  expect(screen.getByRole('checkbox', { name: 'Keep Possible drought' }).disabled).toBe(true);
});
