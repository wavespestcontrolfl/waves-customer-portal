// @vitest-environment jsdom
// Lawn Fast Complete (GATE_LAWN_FAST_COMPLETE): the sheet opens from the
// server's context, takes the lawn photos through the shared assessment step,
// and completes through the full /complete with the `lawnFast` block. Nothing
// blocks Complete but what the server enforces; every refusal the server names
// reads in plain words and sorts through the shared submit hook. Synthetic
// data only; no real provider is ever called (every request is a stub).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet, { LAWN_CONDITION_OPTIONS, plainRefusalMessage } from './FastCompleteLawnSheet';
import { PROJECT_TYPES } from '../../../../server/services/project-types.js';

// Each test mounts the whole sheet and taps through it: slow on a busy runner.
vi.setConfig({ testTimeout: 30000 });

const P_TALAK = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_IRON = 'aaaaaaaa-0000-4000-8000-000000000002';
const P_GRANULE = 'aaaaaaaa-0000-4000-8000-000000000003';
const CATALOG = [
  { id: P_TALAK, name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC' },
  { id: P_IRON, name: 'Iron Plus', category: 'micronutrient', formulation: 'SC' },
  { id: P_GRANULE, name: 'Green Granules', category: 'fertilizer', formulation: 'granular' },
];

// The context's whole `service` object, nulls included (what /complete wants back).
const VISIT = {
  id: 'svc-lawn',
  customerId: 'cust-1',
  customerName: 'Pat Jones',
  serviceType: 'Lawn Care',
  status: 'confirmed',
  scheduledDate: '2026-10-04T13:00:00.000Z',
  propertyId: 'prop-1',
  catalogServiceId: null,
  address: { line1: '123 Main St', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true,
  category: 'lawn_care',
  serviceKey: 'lawn_care_recurring',
  isCallback: false,
  technicianId: null,
};
const SERVICE = {
  id: 'svc-lawn',
  customerName: 'Pat Jones',
  serviceType: 'Lawn Care',
  address: '123 Main St',
  timeLabel: '2:00 PM',
  findingsType: null,
  routedCustomerId: 'cust-1',
  routedScheduledDate: '2026-10-04',
  routedPropertyId: 'prop-1',
  routedAddress: '123 Main St',
};

const PLANNED = [
  { productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'broadcast_spray', amount: 6.4, amountUnit: 'fl_oz', treatedSqft: 6000, areaUnit: 'sqft', ratePer1000: 1.07, rateUnit: 'fl_oz', approvedForReport: true, wateringRule: null, wateringSummary: 'Water in', mowHoldDays: null },
  { productId: P_IRON, name: 'Iron Plus', applicationMethod: 'spot_treatment', amount: null, amountUnit: 'fl_oz', approvedForReport: true, wateringRule: null, wateringSummary: 'No rule', mowHoldDays: null },
];

const context = (overrides = {}) => ({
  enabled: true,
  eligible: true,
  reason: null,
  visitType: 'recurring',
  findingsType: null,
  service: VISIT,
  visitDate: '2026-10-04',
  turfHeightCapture: false,
  plannedProducts: { source: 'plan', items: PLANNED },
  plannedProductsUnavailable: null,
  assessment: { exists: false, id: null, confirmed: false },
  photoStatus: null,
  previousFrontPhoto: null,
  readFailures: [],
  ...overrides,
});
const ONE_TIME = () => context({ visitType: 'one_time', plannedProducts: { source: null, items: [] } });

const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };
const ASSESSED = { id: 'assessment-1', confirmed_by_tech: false, ...SCORES };
const REVIEW = { status: 'complete', findings: [], photoQuality: [] };

const refusal = (status, code, message, details = {}) => Object.assign(new Error(message), { status, code, details: { code, error: message, ...details } });

let requests;
let completeErrors;
let previewAnswer;
let lookup;
let tips;
let catalogAnswer;

// A stub of the whole admin API the sheet talks to.
function makeRequest({ ctx = context(), contextError = null } = {}) {
  return vi.fn(async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    if (path.endsWith('/lawn-fast/context')) {
      if (contextError) throw contextError;
      return ctx;
    }
    if (path.endsWith('/lawn-fast/watering-preview')) {
      const answer = typeof previewAnswer === 'function' ? previewAnswer(body) : previewAnswer;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.endsWith('/tech-tips')) return tips;
    if (path === '/admin/dispatch/products/catalog') return catalogAnswer;
    if (path.includes('/lawn-assessment/service/')) {
      if (lookup instanceof Error) throw lookup;
      return lookup;
    }
    if (path.endsWith('/lawn-assessment/assess')) {
      return { success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' };
    }
    if (path.endsWith('/lawn-assessment/confirm')) {
      return { success: true, confirmed: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    }
    if (path.endsWith('/complete')) {
      const error = completeErrors.shift();
      if (error) throw error;
      return { success: true, invoiceId: null };
    }
    return {};
  });
}

class FixtureFileReader {
  readAsDataURL() {
    this.result = 'data:image/jpeg;base64,cGhvdG8=';
    this.onload({ target: { result: this.result } });
  }
}
class FixtureImage {
  set src(_value) {
    this.width = 800;
    this.height = 600;
    this.onload();
  }
}

beforeEach(() => {
  requests = [];
  completeErrors = [];
  previewAnswer = { products: [], state: null, lines: [], sentence: null, mowHold: null, asOf: '2026-10-04T14:00:00.000Z', provisional: [], omitted: [] };
  lookup = { shotListEnabled: true, assessment: null };
  tips = { available: false, groups: [] };
  catalogAnswer = { products: CATALOG };
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('FileReader', FixtureFileReader);
  vi.stubGlobal('Image', FixtureImage);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openSheet({ request = makeRequest(), props = {} } = {}) {
  const onFullForm = props.onFullForm || vi.fn();
  const onCompleted = props.onCompleted || vi.fn();
  render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onCompleted={onCompleted} onFullForm={onFullForm} {...props} />);
  await screen.findByRole('heading', { name: 'Lawn photos' });
  return { request, onFullForm, onCompleted };
}

// Photos in, Analyze, then confirm what the read found.
async function confirmAssessment() {
  const input = await screen.findByLabelText('Add turf photos');
  await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
  fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByLabelText('Slot for photo 1');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
}

const completeButton = () => screen.getByRole('button', { name: /^(Complete lawn visit|Retry)$/ });
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
const tile = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const editorFor = (name) => screen.getByRole('group', { name });
const footerReason = () => document.querySelector('.tech-visit-footer [role="status"]')?.textContent || '';

async function submit() {
  fireEvent.click(completeButton());
  await waitFor(() => expect(completeCalls().length).toBeGreaterThan(0));
}

describe('opening the sheet', () => {
  test('a visit the server calls ineligible opens the full form, once', async () => {
    const request = makeRequest({ ctx: context({ eligible: false, reason: 'has_companions' }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
  });

  test.each([404, 409])('a %s on the context (gate off, visit gone) opens the full form', async (status) => {
    const request = makeRequest({ contextError: Object.assign(new Error('x'), { status }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  });

  test('a failed read shows the error with Try again and a way to the full form, and does not leave on its own', async () => {
    const request = makeRequest({ contextError: Object.assign(new Error('Network down'), { status: 503 }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await screen.findByText('Network down');
    expect(onFullForm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open the full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('a visit that changed since the schedule loaded is named, not completed', async () => {
    const request = makeRequest({ ctx: context({ service: { ...VISIT, propertyId: 'prop-other' } }) });
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} />);
    await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.');
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
  });
});

describe('products', () => {
  test('a recurring visit opens with the plan\'s products on and their amounts filled', async () => {
    await openSheet();
    expect(tile('Talak 7.9%').getAttribute('aria-pressed')).toBe('true');
    expect(tile('Iron Plus').getAttribute('aria-pressed')).toBe('true');
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('6.4');
    expect(within(editorFor('Talak 7.9%')).getByText('Planned amount')).toBeTruthy();
    // The plan had no quantity for this one: blank, and said so, never invented.
    expect(within(editorFor('Iron Plus')).getByLabelText('Iron Plus').value).toBe('');
    expect(within(editorFor('Iron Plus')).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
  });

  test('a one-time visit opens with no products and still completes', async () => {
    const request = makeRequest({ ctx: ONE_TIME() });
    await openSheet({ request });
    expect(screen.queryByRole('button', { name: /^Talak/ })).toBeNull();
    expect(screen.getByText('No products yet. Add what you applied, or none if you applied nothing.')).toBeTruthy();
    expect(request.mock.calls.some(([path]) => path.includes('/treatment-plans/'))).toBe(false);
    await confirmAssessment();
    await submit();
    expect(completeCalls()[0].body.products).toEqual([]);
    expect(completeCalls()[0].body.lawnFast).toEqual({ visitType: 'one_time' });
  });

  test('turning a planned product off sends it as skipped, the way the full form does', async () => {
    await openSheet();
    fireEvent.click(tile('Iron Plus'));
    expect(screen.queryByRole('group', { name: 'Iron Plus' })).toBeNull();
    await confirmAssessment();
    await submit();
    const { body } = completeCalls()[0];
    expect(body.products.map((p) => p.productId)).toEqual([P_TALAK]);
    expect(body.lawnProtocolCompletion).toEqual({ skippedProducts: [{ productId: P_IRON, productName: 'Iron Plus' }] });
  });

  test('a sprayed product takes its area from the lawn plan, and Complete waits for one when there is none', async () => {
    // The plan has no area for it (treatedSqft null): the box is the technician's.
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray', { treatedSqft: null, areaUnit: null }) }) });
    await confirmAssessment();
    // Talak is a broadcast spray with no area yet.
    await waitFor(() => expect(footerReason()).toBe('Enter the square feet treated for Talak 7.9%.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Area treated (sq ft)'), { target: { value: '5000' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ productId: P_TALAK, applicationMethod: 'broadcast_spray', areaValue: 5000, areaUnit: 'sqft' });
  });

  test('the plan\'s area fills the box, labeled', async () => {
    await openSheet();
    const area = await waitFor(() => {
      const input = within(editorFor('Talak 7.9%')).getByLabelText('Area treated (sq ft)');
      expect(input.value).toBe('6000');
      return input;
    });
    expect(area).toBeTruthy();
    expect(within(editorFor('Talak 7.9%')).getByText('from the lawn plan')).toBeTruthy();
  });

  test('a product added from the picker joins as an applied row on its own default method', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    const editor = editorFor('Iron Plus');
    expect(within(editor).getByText(/added by you/)).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Broadcast spray' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Complete', () => {
  test('is off until the assessment is confirmed, and says why in plain words', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await waitFor(() => expect(footerReason()).toBe('Take your photos, tap Analyze lawn, then confirm the assessment. Complete turns on after that.'));
    expect(completeButton().disabled).toBe(true);
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(footerReason()).toBe('');
  });

  test('the photo hint never blocks: one photo, hint showing, assessment confirmed, Complete on', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await confirmAssessment();
    expect(completeButton().disabled).toBe(false);
  });

  test('the shot-list hint is shown with a single photo and Analyze works at any time', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    const input = await screen.findByLabelText('Add turf photos');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
    await screen.findByLabelText('Slot for photo 1');
    expect(screen.getByTestId('lawn-shot-list-hint').textContent).toMatch(/This is a guide only/);
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(false);
    expect(completeButton().disabled).toBe(true);
  });

  test('a one-time lawn visit asks for the lawn condition the server requires, and sends it as typed findings', async () => {
    const request = makeRequest({ ctx: { ...ONE_TIME(), findingsType: 'one_time_lawn_treatment' } });
    await openSheet({ request });
    await confirmAssessment();
    await waitFor(() => expect(footerReason()).toBe('Pick the lawn condition.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.structuredFindings).toEqual({ type: 'one_time_lawn_treatment', values: { lawn_condition: 'Good' } });
  });

  test('a recurring visit sends no typed findings', async () => {
    await openSheet();
    await confirmAssessment();
    await submit();
    expect(completeCalls()[0].body).not.toHaveProperty('structuredFindings');
  });

  test('the condition list is the server\'s one_time_lawn_treatment list', () => {
    const field = PROJECT_TYPES.one_time_lawn_treatment.findingsFields.find((f) => f.key === 'lawn_condition');
    expect(LAWN_CONDITION_OPTIONS).toEqual(field.options);
  });
});

describe('turf height', () => {
  test('is asked only when the context says so, sent when entered, and held to the server\'s range', async () => {
    const request = makeRequest({ ctx: context({ turfHeightCapture: true }) });
    await openSheet({ request });
    await confirmAssessment();
    const input = screen.getByPlaceholderText('e.g. 4');
    fireEvent.change(input, { target: { value: '12' } });
    await waitFor(() => expect(footerReason()).toBe('Lawn length must be between 0.5 and 8 inches.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '3.5' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.manualHeightIn).toBe(3.5);
  });

  test('with no reading the capture is optional and sends none, and without the flag there is no input or key', async () => {
    const withFlag = await openSheet({ request: makeRequest({ ctx: context({ turfHeightCapture: true }) }) });
    await confirmAssessment();
    await submit();
    expect(completeCalls()[0].body.manualHeightIn).toBeNull();
    expect(withFlag.request).toBeTruthy();
    cleanup();
    requests = [];
    await openSheet();
    expect(screen.queryByPlaceholderText('e.g. 4')).toBeNull();
    await confirmAssessment();
    await submit();
    expect(completeCalls()[0].body).not.toHaveProperty('manualHeightIn');
  });
});

describe('resume', () => {
  test('a visit that already has a confirmed assessment picks it up and uploads nothing', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: context({ assessment: { exists: true, id: 'assessment-1', confirmed: true, unusableReason: null } }) }) });
    await screen.findByText('Assessment confirmed');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
    expect(requests.some((r) => r.path.endsWith('/lawn-assessment/assess'))).toBe(false);
  });

  test('a confirmed assessment the report would reject (another property) does not count until redone', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: context({ assessment: { exists: true, id: 'assessment-1', confirmed: false, unusableReason: 'property_scope' } }) }) });
    await screen.findByText('Assessment confirmed');
    await waitFor(() => expect(footerReason()).toBe('This lawn check was made for a different property than this visit. Retake the photos, then analyze and confirm again.'));
    expect(completeButton().disabled).toBe(true);
  });
});

describe('the submit body', () => {
  test('echoes the context: the whole service object, the visit type, the assessment id, a fresh key, the full form\'s text defaults', async () => {
    await openSheet();
    await confirmAssessment();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Synthetic note' } });
    fireEvent.change(within(editorFor('Iron Plus')).getByLabelText('Iron Plus'), { target: { value: '2' } });
    await submit();
    const { body } = completeCalls()[0];
    expect(body.expectedVisit).toEqual(VISIT);
    // Every key, nulls included.
    expect(Object.keys(body.expectedVisit).sort()).toEqual(Object.keys(VISIT).sort());
    expect(body.expectedVisit.technicianId).toBeNull();
    expect(body.expectedVisit.catalogServiceId).toBeNull();
    expect(body.lawnFast).toEqual({ visitType: 'recurring' });
    expect(body.lawnAssessmentId).toBe('assessment-1');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(8);
    expect(body).toMatchObject({
      visitOutcome: 'completed', technicianNotes: 'Synthetic note', techTips: null,
      sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto',
    });
    expect(body.products).toEqual([
      { productId: P_TALAK, applicationMethod: 'broadcast_spray', totalAmount: 6.4, amountUnit: 'fl_oz', rate: 1.07, rateUnit: 'fl_oz', applicationArea: 'Front yard, Back yard, Side yards', areaValue: 6000, areaUnit: 'sqft', targets: [] },
      { productId: P_IRON, applicationMethod: 'spot_treatment', totalAmount: 2, amountUnit: 'fl_oz', applicationArea: 'Front yard, Back yard, Side yards', targets: [] },
    ]);
    expect(body).not.toHaveProperty('lawnProtocolCompletion');
  });

  test('a successful save shows the saved view and hands the response up', async () => {
    const { onCompleted } = await openSheet();
    await confirmAssessment();
    await submit();
    await screen.findByText('Next stop');
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalledWith({ success: true, invoiceId: null });
  });
});

describe('what the server refuses', () => {
  // [status, code, words from the server, extra body, the plain words shown]
  const TERMINAL = [
    [409, 'lawn_fast_disabled', 'Lawn Fast Complete is not available. Use the full completion form.', {}, 'The quick lawn sheet is off right now. Open the full form.'],
    [409, 'lawn_fast_not_eligible', 'This visit cannot be completed on the quick sheet. Use the full completion form.', { reason: 'grouped_visit' }, 'This visit needs the full form.'],
    [409, 'visit_identity_changed', 'This visit changed since it was opened.', { reason: 'visit_type_changed' }, 'This visit changed since you opened it. Close it and open it again from the schedule.'],
  ];

  test.each(TERMINAL)('%i %s is terminal: the words show, Complete stays off, the full form is offered', async (status, code, serverText, extra, shown) => {
    completeErrors.push(refusal(status, code, serverText, extra));
    const { onFullForm } = await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await confirmAssessment();
    await submit();
    await screen.findByText(shown);
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open the full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
    // Nothing is sent again.
    expect(completeCalls()).toHaveLength(1);
  });

  const CORRECTABLE = [
    [400, 'lawn_fast_expected_visit_required', 'Reopen this visit from the schedule so the sheet can confirm it is the same visit.', {}, 'Close this sheet and open the visit again from the schedule. The sheet must confirm it is the same visit.'],
    [400, 'lawn_fast_assessment_required', 'Analyze and confirm the lawn assessment before completing this visit.', {}, 'Analyze the lawn photos and confirm the assessment first.'],
    [400, 'lawn_fast_assessment_required', 'This lawn assessment was captured for a different property than this visit.', { reason: 'property_scope' }, 'This lawn check was made for a different property than this visit. Retake the photos, then analyze and confirm again.'],
    [400, 'lawn_assessment_unconfirmed', 'Confirm the lawn assessment before completing this service so it appears in the customer report.', {}, 'Confirm the lawn assessment, then tap Complete again.'],
  ];

  test.each(CORRECTABLE)('%i %s is correctable: the words show and the next try goes under a new key', async (status, code, serverText, extra, shown) => {
    completeErrors.push(refusal(status, code, serverText, extra));
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await confirmAssessment();
    await submit();
    await screen.findByText(shown);
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.idempotencyKey).not.toBe(completeCalls()[0].body.idempotencyKey);
  });

  const RETRY = [
    [503, 'completion_profile_lookup_failed', 'Could not verify the completion type for this service. Try again in a moment.'],
    [503, 'lawn_fast_visit_type_unavailable', 'Could not verify the visit type for this service. Try again in a moment.'],
  ];

  test.each(RETRY)('%i %s is a retry: the same body goes again under the same key', async (status, code, serverText) => {
    completeErrors.push(refusal(status, code, serverText));
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await confirmAssessment();
    await submit();
    await screen.findByText(/We could not check this visit type\. We couldn't confirm it saved\. Tap Retry/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body).toEqual(completeCalls()[0].body);
  });

  test('a code the sheet has no words for keeps the server\'s own message', () => {
    expect(plainRefusalMessage({ code: 'something_else', message: 'x' })).toBeNull();
    expect(plainRefusalMessage({ code: 'lawn_fast_assessment_required', reason: 'property_scope' })).toMatch(/different property/);
  });
});

describe('watering preview', () => {
  test('asks once after the product set settles, shows the sentence, and labels the times "if completed now"', async () => {
    previewAnswer = {
      products: [], state: 'hold', lines: ['Do not water until Thu 3 PM.'], sentence: 'Do not water until Thu 3 PM.',
      mowHold: { days: 2, untilDate: '2026-10-06', untilLabel: 'Tue', line: 'Hold off mowing until Tuesday.' },
      asOf: '2026-10-04T14:00:00.000Z', provisional: ['completionTime', 'assessment'], omitted: [],
    };
    const { request } = await openSheet();
    // Two quick changes inside the pause: one read.
    fireEvent.click(tile('Iron Plus'));
    fireEvent.click(tile('Iron Plus'));
    await screen.findByText('Do not water until Thu 3 PM.');
    expect(screen.getByText('Hold off mowing until Tuesday.')).toBeTruthy();
    expect(screen.getByText('Times are if completed now.')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const previews = request.mock.calls.filter(([path]) => path.endsWith('/lawn-fast/watering-preview'));
    expect(previews).toHaveLength(1);
    expect(previews[0][1].method).toBe('POST');
    expect(JSON.parse(previews[0][1].body).productIds.sort()).toEqual([P_TALAK, P_IRON].sort());
  });

  test('asks again, with the new set, when a product is turned off', async () => {
    previewAnswer = (body) => ({ products: [], state: 'hold', lines: [`Set of ${body.productIds.length}`], sentence: `Set of ${body.productIds.length}`, mowHold: null, provisional: [], omitted: [] });
    await openSheet();
    await screen.findByText('Set of 2');
    fireEvent.click(tile('Iron Plus'));
    await screen.findByText('Set of 1');
  });

  test('shows no times label when none are provisional', async () => {
    previewAnswer = { products: [], state: 'hold', lines: ['Water in by Fri.'], sentence: 'Water in by Fri.', mowHold: null, provisional: [], omitted: [] };
    await openSheet();
    await screen.findByText('Water in by Fri.');
    expect(screen.queryByText('Times are if completed now.')).toBeNull();
  });

  test('shows nothing but a neutral note when the server omitted part of it, even if it sent a sentence', async () => {
    previewAnswer = { products: [], state: 'hold', lines: ['Guess'], sentence: 'Guess', mowHold: null, provisional: [], omitted: ['week_plan'] };
    await openSheet();
    await screen.findByText('The watering instruction is not shown here. The customer report has its own.');
    expect(screen.queryByText('Guess')).toBeNull();
  });

  test('a failed read gets the same neutral note and never blocks Complete', async () => {
    previewAnswer = new Error('boom');
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    await screen.findByText('The watering instruction is not shown here. The customer report has its own.');
    await confirmAssessment();
    fireEvent.change(within(editorFor('Iron Plus')).getByLabelText('Area treated (sq ft)'), { target: { value: '100' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('asks nothing, and shows no panel, with no products on', async () => {
    const { request } = await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(request.mock.calls.some(([path]) => path.endsWith('/lawn-fast/watering-preview'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Watering after this visit' })).toBeNull();
  });

  test('shows no panel when the server has no instruction for these products', async () => {
    await openSheet();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: 'Watering after this visit' })).toBeNull();
  });
});

describe('text size', () => {
  test('no text on the sheet, including the shared photo step, is set under 14px', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ turfHeightCapture: true }) }) });
    await confirmAssessment();
    const sized = Array.from(document.querySelectorAll('[style]')).filter((el) => el.style.fontSize);
    expect(sized.length).toBeGreaterThan(10);
    for (const el of sized) expect(parseFloat(el.style.fontSize)).toBeGreaterThanOrEqual(14);
  });
});

// ── Codex round 1 on #5824 ──────────────────────────────────────────────────
const plannedOne = (applicationMethod, extra = {}) => context({
  plannedProducts: { source: 'plan', items: [{ productId: P_TALAK, name: 'Talak 7.9%', applicationMethod, amount: 2, amountUnit: 'fl_oz', ...extra }] },
});
const areaInput = (label) => within(editorFor('Talak 7.9%')).queryByLabelText(label);

describe('what /complete requires per application method', () => {
  // [method as the plan or catalog spells it, the unit the server wants or null, the box label]
  const TABLE = [
    ['perimeter_spray', 'linear_ft', 'Linear feet treated'],
    ['Perimeter Band', 'linear_ft', 'Linear feet treated'],
    ['broadcast_spray', 'sqft', 'Area treated (sq ft)'],
    ['Broadcast', 'sqft', 'Area treated (sq ft)'],
    ['granular_broadcast', 'sqft', 'Area treated (sq ft)'],
    ['spot_treatment', null],
    ['soil_drench', null],
    ['foliar_spray', null],
    ['bait_placement', null],
    ['station_check', null],
    ['fog_ulv', null],
    ['trunk_injection', null],
    ['pin_stream', null],
  ];

  test.each(TABLE)('%s needs %s', async (method, unit, label) => {
    await openSheet({ request: makeRequest({ ctx: plannedOne(method) }) });
    await confirmAssessment();
    if (!unit) {
      expect(areaInput(/treated/)).toBeNull();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      expect(completeCalls()[0].body.products[0]).not.toHaveProperty('areaValue');
      expect(completeCalls()[0].body.products[0]).not.toHaveProperty('areaUnit');
      return;
    }
    const noun = unit === 'linear_ft' ? 'linear feet' : 'square feet';
    await waitFor(() => expect(footerReason()).toBe(`Enter the ${noun} treated for Talak 7.9%.`));
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(areaInput(label), { target: { value: '120' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 120, areaUnit: unit });
  });

  test('a perimeter row is never seeded with the plan\'s square feet', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('perimeter_spray', { treatedSqft: 6000, areaUnit: 'sqft' }) }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(areaInput('Linear feet treated').value).toBe('');
  });

  test('switching a row from a perimeter spray to a spray drops the linear feet it held', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('perimeter_spray', { treatedSqft: 6000, areaUnit: 'sqft' }) }) });
    fireEvent.change(areaInput('Linear feet treated'), { target: { value: '90' } });
    fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Broadcast spray' }));
    // Square feet now: the plan's, never the 90 linear feet.
    await waitFor(() => expect(areaInput('Area treated (sq ft)').value).toBe('6000'));
  });

  test('the plan\'s treatedSqft seeds the box and no treatment-plan read is made', async () => {
    const request = makeRequest({ ctx: plannedOne('broadcast_spray', { treatedSqft: 4100, areaUnit: 'sqft' }) });
    await openSheet({ request });
    expect(areaInput('Area treated (sq ft)').value).toBe('4100');
    expect(request.mock.calls.some(([path]) => path.includes('/treatment-plans/'))).toBe(false);
  });

  test('the server\'s linear_ft_required gets plain words', () => {
    expect(plainRefusalMessage({ code: 'linear_ft_required' })).toBe('Enter the linear feet treated for each perimeter product.');
  });
});

describe('a visit type that could not be read', () => {
  test.each([
    ['unknown type', { visitType: 'unknown', readFailures: ['billing_mode'] }],
    ['billing read failure listed', { readFailures: ['billing_mode'] }],
    ['no type at all', { visitType: null }],
  ])('%s shows the retry state and no form', async (_label, overrides) => {
    const request = makeRequest({ ctx: context(overrides) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await screen.findByText('Couldn’t load this visit. Try again.');
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
    expect(onFullForm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open the full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/lawn-fast/context'))).toHaveLength(2));
  });

  test.each(['photo_status', 'turf_height_flag', 'planned_products', 'assessment'])('an advisory %s failure still opens the sheet', async (failure) => {
    await openSheet({ request: makeRequest({ ctx: context({ readFailures: [failure] }) }) });
    expect(screen.getByRole('heading', { name: 'Lawn photos' })).toBeTruthy();
  });
});

describe('zero stock', () => {
  const EMPTY_CATALOG = [{ ...CATALOG[0], inventory_on_hand: '0.0000', inventory_unit: 'fl_oz' }, CATALOG[1], CATALOG[2]];
  const open = (props = {}, ctx = plannedOne('spot_treatment')) => openSheet({ request: makeRequest({ ctx }), props: { catalog: EMPTY_CATALOG, ...props } });

  test('holds Complete on a non-member visit, says so, and a stock refresh releases it', async () => {
    await open();
    await confirmAssessment();
    await waitFor(() => expect(footerReason()).toBe('Talak 7.9% shows 0 in stock. Update inventory, then tap Check stock.'));
    expect(completeButton().disabled).toBe(true);
    catalogAnswer = { products: [{ ...EMPTY_CATALOG[0], inventory_on_hand: '40.0000' }] };
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(footerReason()).toBe('');
  });

  test('does not hold a product with no amount (the server deducts nothing)', async () => {
    await open({}, plannedOne('spot_treatment', { amount: null }));
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('does not hold a real WaveGuard tier lawn visit (the server lets stock go negative)', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Gold' } });
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('holds a tier the server does not count (Commercial, or none)', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Commercial' } });
    await confirmAssessment();
    await waitFor(() => expect(footerReason()).toMatch(/shows 0 in stock/));
  });

  test('the context\'s stockAdvisory wins over the schedule row, both ways', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Gold' } }, { ...plannedOne('spot_treatment'), stockAdvisory: false });
    await confirmAssessment();
    await waitFor(() => expect(footerReason()).toMatch(/shows 0 in stock/));
    cleanup();
    await open({}, { ...plannedOne('spot_treatment'), stockAdvisory: true });
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('waveguard_inventory_lockout from the server reads as a correctable stock message with Check stock offered', async () => {
    completeErrors.push(refusal(400, 'waveguard_inventory_lockout', 'Talak requires 2 fl_oz, but only 1 fl_oz is on hand.'));
    await openSheet({ request: makeRequest({ ctx: plannedOne('spot_treatment') }) });
    await confirmAssessment();
    await submit();
    await screen.findByText('A product is out of stock. Update inventory, tap Check stock, then complete again.');
    expect(screen.getByRole('button', { name: 'Check stock' })).toBeTruthy();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.idempotencyKey).not.toBe(completeCalls()[0].body.idempotencyKey);
  });
});

describe('a confirmed assessment when the detail lookup fails', () => {
  const confirmedContext = (assessment = {}) => context({ assessment: { exists: true, id: 'assessment-ctx', confirmed: true, unusableReason: null, ...assessment } });

  test('the context\'s confirmed id stands, so Complete stays on and sends it', async () => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-ctx');
  });

  test('a retake that starts (a new photo) ends it', async () => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    const input = screen.getByLabelText('Add turf photos');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(completeButton().disabled).toBe(true));
    // The new confirmed id then replaces it.
    await screen.findByLabelText('Slot for photo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
  });

  test.each([
    ['unusable (another property)', { confirmed: true, unusableReason: 'property_scope' }],
    ['unusable (check failed)', { confirmed: true, unusableReason: 'property_check_failed' }],
    ['not confirmed', { confirmed: false }],
  ])('is never used when the context says %s', async (_label, assessment) => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext(assessment) }) });
    await waitFor(() => expect(footerReason()).toMatch(/confirm the assessment/));
    expect(completeButton().disabled).toBe(true);
  });

  test('a lookup that succeeds with no assessment does not fall back to the context\'s id', async () => {
    lookup = { shotListEnabled: true, assessment: null };
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(footerReason()).toMatch(/confirm the assessment/));
  });

  test('the property-check wording differs from the property-scope wording', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: confirmedContext({ id: 'assessment-1', unusableReason: 'property_check_failed' }) }) });
    await waitFor(() => expect(footerReason()).toBe('We could not check this lawn assessment against this visit. Try again, or retake the photos and confirm again.'));
  });
});

describe('the saved-photo advisory', () => {
  const WARNING = 'Aim for at least 4 photos: front, back or side, canopy close-up, and blade and crown. Still needed: Back overview or Side overview. This is a guide only, and Analyze lawn works at any time.';
  const withWarning = (assessment) => context({ assessment, photoStatus: { soft: true, basis: 'shot_list', count: 1, minPhotos: 4, meetsFloor: false, missing: ['Back overview or Side overview'], warning: WARNING } });

  test('shows once, non-blocking, beside a saved confirmed assessment', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: withWarning({ exists: true, id: 'assessment-1', confirmed: true, unusableReason: null }) }) });
    await screen.findByText('Assessment confirmed');
    expect(await screen.findAllByText(WARNING)).toHaveLength(1);
    expect(screen.queryByTestId('lawn-shot-list-hint')).toBeNull();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('is not shown while the photo step\'s own hint is up, so it never reads twice', async () => {
    lookup = { shotListEnabled: true, assessment: null };
    await openSheet({ request: makeRequest({ ctx: withWarning({ exists: false, id: null, confirmed: false }) }) });
    const input = await screen.findByLabelText('Add turf photos');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
    await screen.findByLabelText('Slot for photo 1');
    expect(screen.getAllByText(/Aim for at least 4 photos/)).toHaveLength(1);
    expect(screen.getByTestId('lawn-shot-list-hint')).toBeTruthy();
  });

  test('goes once the technician starts a retake', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: withWarning({ exists: true, id: 'assessment-1', confirmed: true, unusableReason: null }) }) });
    await screen.findAllByText(WARNING);
    fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
    await waitFor(() => expect(screen.queryByText(WARNING)).toBeNull());
  });
});

// ── Codex round 2 on #5824 ──────────────────────────────────────────────────
describe('the original method stays on offer', () => {
  test('a perimeter row: tap Broadcast, the perimeter chip is still there, tap it, linear feet are required again', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('perimeter_spray') }) });
    const how = () => within(editorFor('Talak 7.9%'));
    const names = () => how().getAllByRole('button').map((b) => b.textContent).filter((t) => /spray|Granular|Spot/.test(t));
    expect(names()).toEqual(['Broadcast spray', 'Granular', 'Spot treatment', 'Perimeter spray']);
    fireEvent.click(how().getByRole('button', { name: 'Broadcast spray' }));
    expect(names()).toEqual(['Broadcast spray', 'Granular', 'Spot treatment', 'Perimeter spray']);
    expect(how().getByRole('button', { name: 'Perimeter spray' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(how().getByRole('button', { name: 'Perimeter spray' }));
    expect(how().getByRole('button', { name: 'Perimeter spray' }).getAttribute('aria-pressed')).toBe('true');
    expect(areaInput('Linear feet treated')).toBeTruthy();
    expect(areaInput('Linear feet treated').value).toBe('');
  });
});

describe('typed findings come from the context only', () => {
  test('the schedule row says recurring but the context says one-time: the condition is required and sent', async () => {
    const request = makeRequest({ ctx: { ...ONE_TIME(), findingsType: 'one_time_lawn_treatment' } });
    await openSheet({ request, props: { service: { ...SERVICE, findingsType: null } } });
    await confirmAssessment();
    await waitFor(() => expect(footerReason()).toBe('Pick the lawn condition.'));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    await submit();
    expect(completeCalls()[0].body.structuredFindings).toEqual({ type: 'one_time_lawn_treatment', values: { lawn_condition: 'Fair' } });
  });

  test('context findingsType null: no condition row and no typed findings, whatever the schedule row says', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { service: { ...SERVICE, findingsType: 'one_time_lawn_treatment' } } });
    expect(screen.queryByRole('heading', { name: 'Lawn condition' })).toBeNull();
    await confirmAssessment();
    await submit();
    expect(completeCalls()[0].body).not.toHaveProperty('structuredFindings');
  });

  test('the key absent (an older server) hands off to the full form instead of guessing; null is not absent', async () => {
    const { findingsType: _omit, ...older } = ONE_TIME();
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest({ ctx: older })} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
  });

  test('a findings type that is not the lawn one hands off too', async () => {
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest({ ctx: context({ findingsType: 'tree_shrub' }) })} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  });

  test.each([
    ['service type', { routedServiceType: 'Lawn Re-Service' }],
    ['catalog service', { routedCatalogServiceId: 'cat-other' }],
  ])('a visit whose %s changed since the schedule loaded shows the changed-visit message', async (_label, routed) => {
    render(<FastCompleteLawnSheet service={{ ...SERVICE, ...routed }} request={makeRequest({ ctx: context({ service: { ...VISIT, catalogServiceId: 'cat-1' } }) })} catalog={CATALOG} onClose={() => {}} />);
    await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.');
  });

  test('the same service type (any case) and a matching catalog id open the sheet', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ service: { ...VISIT, catalogServiceId: 'cat-1' } }) }), props: { service: { ...SERVICE, routedServiceType: 'lawn care', routedCatalogServiceId: 'cat-1' } } });
    expect(screen.getByRole('heading', { name: 'Lawn photos' })).toBeTruthy();
  });
});

describe('a product the plan lists twice', () => {
  const twice = () => context({
    plannedProducts: {
      source: 'plan',
      items: [
        { productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'spot_treatment', amount: 3, amountUnit: 'fl_oz' },
        { productId: P_TALAK.toUpperCase(), name: 'Talak 7.9%', applicationMethod: 'spot_treatment', amount: 5, amountUnit: 'fl_oz' },
        { productId: P_IRON, name: 'Iron Plus', applicationMethod: 'spot_treatment', amount: 1, amountUnit: 'fl_oz' },
      ],
    },
  });

  test('is one tile; on, it is one product row with the first amount (as the full form keeps the first)', async () => {
    await openSheet({ request: makeRequest({ ctx: twice() }) });
    expect(screen.getAllByRole('button', { name: /^Talak/ })).toHaveLength(1);
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('3');
    await confirmAssessment();
    await submit();
    const { body } = completeCalls()[0];
    expect(body.products.map((p) => p.productId)).toEqual([P_TALAK, P_IRON]);
    expect(body).not.toHaveProperty('lawnProtocolCompletion');
  });

  test('off, it is one skipped entry, so /complete\'s unique-list rule holds', async () => {
    await openSheet({ request: makeRequest({ ctx: twice() }) });
    fireEvent.click(tile('Talak'));
    await confirmAssessment();
    await submit();
    const { body } = completeCalls()[0];
    expect(body.lawnProtocolCompletion.skippedProducts).toEqual([{ productId: P_TALAK, productName: 'Talak 7.9%' }]);
    expect(body.products.map((p) => p.productId)).toEqual([P_IRON]);
  });

  test('every array in the body is unique where the server needs it', async () => {
    tips = { available: true, groups: [{ tips: [{ id: 'tip-a', label: 'Tip A', copy: 'Copy A' }] }] };
    await openSheet({ request: makeRequest({ ctx: twice() }) });
    fireEvent.click(tile('Iron Plus'));
    fireEvent.click(tile('Talak'));
    fireEvent.click(await screen.findByRole('button', { name: /Tip A/ }));
    await confirmAssessment();
    await submit();
    const { body } = completeCalls()[0];
    const skipped = body.lawnProtocolCompletion.skippedProducts.map((p) => p.productId);
    expect(new Set(skipped).size).toBe(skipped.length);
    expect(skipped.every((id) => id === id.toLowerCase())).toBe(true);
    expect(body.techTips).toEqual({ ids: ['tip-a'], custom: null });
    expect(body.products.every((p) => p.targets.length === 0)).toBe(true);
  });
});

// ── pre-push P1: planned rates in the completion record ─────────────────────
describe('application rate on the product rows', () => {
  const planned = (extra = {}, method = 'broadcast_spray') => plannedOne(method, { treatedSqft: 6000, areaUnit: 'sqft', ratePer1000: 1.07, rateUnit: 'fl_oz', ...extra });
  const rateBox = () => within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9% rate');
  const sentRow = () => completeCalls()[0].body.products[0];
  const run = async (ctx, after) => {
    await openSheet({ request: makeRequest({ ctx }) });
    if (after) await after();
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
  };

  test('a planned row whose amount, area and method are untouched sends the plan rate and unit, and shows it', async () => {
    await run(planned(), async () => expect(rateBox().value).toBe('1.07'));
    expect(sentRow()).toMatchObject({ rate: 1.07, rateUnit: 'fl_oz', totalAmount: 2, amountUnit: 'fl_oz', areaValue: 6000 });
  });

  test.each([
    ['the amount', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '3' } })],
    ['the amount unit', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Unit for Talak 7.9%'), { target: { value: 'gal' } })],
    ['the plan\'s area', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Area treated (sq ft)'), { target: { value: '4000' } })],
    ['the method', () => fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Granular' }))],
  ])('a change to %s makes the plan rate stale: it is not sent and the box empties (never recomputed)', async (_label, change) => {
    await run(planned(), async () => {
      change();
      await waitFor(() => expect(rateBox().value).toBe(''));
    });
    expect(sentRow()).not.toHaveProperty('rate');
    expect(sentRow()).not.toHaveProperty('rateUnit');
  });

  test('a rate the technician types after a change is sent, in the label\'s unit', async () => {
    await run(planned(), async () => {
      fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '3' } });
      fireEvent.change(rateBox(), { target: { value: '1.2' } });
    });
    // After a change the unit is the label's own, as the sibling does for a typed rate.
    expect(sentRow()).toMatchObject({ rate: 1.2, rateUnit: 'oz' });
  });

  test('a unit /complete does not accept is never sent (mL, an odd catalog unit)', async () => {
    await run(planned({ rateUnit: 'ml' }));
    expect(sentRow()).not.toHaveProperty('rate');
    cleanup();
    requests = [];
    await run(planned({ rateUnit: 'percent_solution' }));
    expect(sentRow()).not.toHaveProperty('rateUnit');
  });

  test('a plan with no rate sends none, and no catalog default is invented for a planned row', async () => {
    await run(planned({ ratePer1000: null, rateUnit: null }));
    expect(sentRow()).not.toHaveProperty('rate');
  });

  test('a perimeter row keeps the plan rate as the plan gave it, and linear feet are the area', async () => {
    await run(plannedOne('perimeter_spray', { ratePer1000: 0.5, rateUnit: 'fl_oz' }), async () => {
      fireEvent.change(areaInput('Linear feet treated'), { target: { value: '150' } });
    });
    expect(sentRow()).toMatchObject({ rate: 0.5, rateUnit: 'fl_oz', areaValue: 150, areaUnit: 'linear_ft' });
  });

  test('an added product has no prefilled rate (the sibling\'s rule); one the technician types is sent with the label unit', async () => {
    const catalog = [{ ...CATALOG[0], default_unit: 'fl_oz', default_rate_per_1000: 2 }, CATALOG[1], CATALOG[2]];
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog } });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Talak 7.9%'));
    expect(rateBox().value).toBe('');
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '2' } });
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Area treated (sq ft)'), { target: { value: '1000' } });
    await confirmAssessment();
    await submit();
    expect(sentRow()).not.toHaveProperty('rate');
    cleanup();
    requests = [];
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog } });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Talak 7.9%'));
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '2' } });
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Area treated (sq ft)'), { target: { value: '1000' } });
    fireEvent.change(rateBox(), { target: { value: '2' } });
    await confirmAssessment();
    await submit();
    expect(sentRow()).toMatchObject({ rate: 2, rateUnit: 'fl_oz' });
  });

  test('a rate over the label maximum is flagged to the technician, not blocked', async () => {
    const catalog = [{ ...CATALOG[0], rate_unit: 'fl_oz', default_unit: 'fl_oz', max_label_rate_per_1000: 1 }, CATALOG[1], CATALOG[2]];
    await run(planned(), null).catch(() => {});
    cleanup();
    await openSheet({ request: makeRequest({ ctx: planned() }), props: { catalog } });
    expect(await screen.findByText(/label max/)).toBeTruthy();
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });
});
