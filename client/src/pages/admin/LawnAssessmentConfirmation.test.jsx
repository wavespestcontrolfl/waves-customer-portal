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
let serverAiScores;
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
  serverAiScores = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = {};
    if (url.includes('feature-flags')) data = { flags: {} };
    if (url.includes('lawn-assessment/customers')) data = { customers: [{ id: 'fixture-customer', firstName: 'Fixture', lastName: 'Lawn' }] };
    if (url.includes('lawn-assessment/service/')) data = { assessment: loadedAssessment, visitAssessment, ...(serverAiScores ? { aiScores: serverAiScores } : {}) };
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
  // color_health is the one AI-blank metric: its AI tile reads "—"; its TECH
  // tile is a fill-in input, not a second "—".
  expect(screen.getAllByText('—')).toHaveLength(1);
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
  // Every metric is AI-blank here, so every TECH cell is a fill-in input.
  fireEvent.change(await screen.findByLabelText('Enter Turf Density'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Enter Fungus Control'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Scores' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(message));
  const sent = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  expect(sent.adjustedScores).toEqual({ turf_density: 5, fungus_control: 0 });
  // Untouched unavailable metrics remain unknown, never invented defaults —
  // every AI tile reads "—" regardless of which ones were filled.
  expect(screen.getAllByText('—')).toHaveLength(5);
});

it('keeps a pending assessment out of closeout and allows a later completed confirmation', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('Fixture submit'));
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={submit} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText(message);
  expect(screen.queryByText('0/100')).toBeNull();
  // color_health is the one score the AI left blank: an empty field, never a 0.
  expect(screen.getByLabelText('Color score').value).toBe('');
  const confirmBody = JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('lawn-assessment/confirm'))[1].body);
  // Nothing was typed, so nothing is posted; the server keeps the saved scores.
  expect(confirmBody.adjustedScores).toEqual({});
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

// Owner ruling 2026-10-04 (replaces the 2026-09-24 read-only ruling): the
// four scores are editable until the assessment is confirmed.
const SCORE_FIELDS = ['Density score', 'Weed control score', 'Color score', 'Condition score'];
const confirmPosts = () => fetch.mock.calls.filter(([url]) => url.endsWith('lawn-assessment/confirm')).map(([, init]) => JSON.parse(init.body).adjustedScores);

it('lets the technician change a score the AI read, shows the AI read beside it, and posts only what was typed', async () => {
  visitAssessment = {
    runId: 'fixture-run', status: 'complete',
    aiScores: { turf_density: 80, weed_suppression: 80, color_health: null, fungus_control: 85, thatch_level: 85, stress_damage: 85 },
  };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  const density = screen.getByLabelText('Density score');
  expect(density.value).toBe('80');
  // Unchanged scores carry no AI line.
  expect(screen.queryByTestId('lawn-ai-score-turf_density')).toBeNull();
  fireEvent.change(density, { target: { value: '55' } });
  fireEvent.change(screen.getByLabelText('Condition score'), { target: { value: '140' } });
  expect(screen.getByTestId('lawn-ai-score-turf_density').textContent).toBe('AI 80');
  // Entries are held to 0-100.
  expect(screen.getByLabelText('Condition score').value).toBe('100');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await waitFor(() => expect(confirmPosts()).toHaveLength(1));
  expect(confirmPosts()[0]).toEqual({ turf_density: 55, stress_damage: 100 });
});

it('an earlier entry from a partial save is still shown and editable after reload', async () => {
  // The row holds the technician's 60 from a pending save; the run's
  // immutable snapshot still holds the AI's 80.
  loadedAssessment = { ...assessment, turf_density: 60 };
  visitAssessment = {
    runId: 'fixture-run', status: 'complete',
    aiScores: { turf_density: 80, weed_suppression: 80, color_health: null, fungus_control: 85, thatch_level: 85, stress_damage: 85 },
  };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(screen.getByLabelText('Density score').value).toBe('60');
  expect(screen.getByTestId('lawn-ai-score-turf_density').textContent).toBe('AI 80');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await waitFor(() => expect(confirmPosts()).toHaveLength(1));
  // Not retyped in this session, so not posted: the server keeps the saved 60.
  expect(confirmPosts()[0]).toEqual({});
});

it('an emptied score posts null, which the server reads as back to the AI score', async () => {
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  fireEvent.change(screen.getByLabelText('Density score'), { target: { value: '' } });
  expect(screen.getByTestId('lawn-ai-score-turf_density').textContent).toBe('AI 80');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await waitFor(() => expect(confirmPosts()).toHaveLength(1));
  expect(confirmPosts()[0]).toEqual({ turf_density: null });
});

it.each([null, 0])('shows an unavailable or genuinely zero score on reload and posts no untyped scores: %s', async (value) => {
  const expected = Object.fromEntries(Object.keys(scores).map((key) => [key, value]));
  loadedAssessment = { ...assessment, ...expected };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  const confirm = await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(SCORE_FIELDS.map((label) => screen.getByLabelText(label).value)).toEqual(Array(4).fill(value == null ? '' : '0'));
  fireEvent.click(confirm);
  await screen.findByText(message);
  expect(confirmPosts()[0]).toEqual({});
});

it('two partial saves: a server-derived Stress is never posted back as an explicit entry', async () => {
  // Stress is AI-blank and derived from fungus. Save 1 fills Color; the
  // server derives Stress 80 and returns it. Save 2 changes Density; the post
  // must not carry Stress, so the server keeps deriving it instead of
  // freezing 80 as a technician entry.
  loadedAssessment = { ...assessment, fungus_control: 80, stress_damage: null };
  confirmation = { success: true, confirmed: false, missingScores: ['color_health'], assessment: { ...loadedAssessment, stress_damage: 80 } };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  const confirm = await screen.findByRole('button', { name: 'Confirm assessment' });
  fireEvent.change(screen.getByLabelText('Color score'), { target: { value: '70' } });
  fireEvent.click(confirm);
  await screen.findByText(message);
  expect(screen.getByLabelText('Condition score').value).toBe('80');
  fireEvent.change(screen.getByLabelText('Density score'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
  await waitFor(() => expect(confirmPosts()).toHaveLength(2));
  expect(confirmPosts()).toEqual([{ color_health: 70 }, { turf_density: 50 }]);
});

it('a legacy reload shows the server AI read beside an earlier entry', async () => {
  // No run: the row carries the technician's 60 from a pending save; the
  // server says the AI read 80.
  loadedAssessment = { ...assessment, turf_density: 60 };
  serverAiScores = { turf_density: 80, weed_suppression: 80, color_health: null, fungus_control: 85, thatch_level: 85, stress_damage: 85 };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  expect(screen.getByLabelText('Density score').value).toBe('60');
  expect(screen.getByTestId('lawn-ai-score-turf_density').textContent).toBe('AI 80');
});

it('a confirmed assessment shows its saved scores as text, with nothing left to edit', async () => {
  // The technician changed turf to 40 before confirming; the customer report
  // uses 40, so the drawer must show 40.
  loadedAssessment = { ...assessment, turf_density: 40, color_health: 75, confirmed_by_tech: true };
  visitAssessment = {
    runId: 'fixture-run', status: 'complete',
    aiScores: { turf_density: 80, weed_suppression: 80, color_health: null, fungus_control: 85, thatch_level: 85, stress_damage: 85 },
  };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  expect(await screen.findByText('40/100')).toBeTruthy();
  for (const label of SCORE_FIELDS) expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.queryByTestId('lawn-ai-score-turf_density')).toBeNull();
});

it('offers the four scores only: no Fungus or Thatch field, even when the AI left them blank', async () => {
  loadedAssessment = { ...assessment, color_health: 80, fungus_control: null, thatch_level: null };
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={() => {}} />);
  await screen.findByRole('button', { name: 'Confirm assessment' });
  for (const label of SCORE_FIELDS) expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.queryByLabelText(/Fungus/i)).toBeNull();
  expect(screen.queryByLabelText(/Thatch/i)).toBeNull();
  expect(screen.queryByText('Fungus control')).toBeNull();
  expect(screen.queryByText('Thatch condition')).toBeNull();
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
