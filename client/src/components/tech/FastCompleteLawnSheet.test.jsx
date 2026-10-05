// @vitest-environment jsdom
// Lawn Fast Complete (GATE_LAWN_FAST_COMPLETE), the one-screen fast lane
// (owner 2026-10-04): note, photos (Analyze lawn, the four editable scores,
// Confirm assessment), the plan's products already on, tips, a blog post, the
// treatment zone map, and one Complete button. Nothing blocks Complete but what
// the server enforces (plus one product); every refusal the server names reads
// in plain words and sorts through the shared submit hook. Synthetic data only;
// no real provider is ever called (every request is a stub).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet, { LAWN_CONDITION_OPTIONS, plainRefusalMessage } from './FastCompleteLawnSheet';
import { PROJECT_TYPES } from '../../../../server/services/project-types.js';

vi.mock('./TechTreatmentZoneModal', () => ({
  default: ({ onClose, onSaved, lawnMode, serviceId }) => (
    <div role="dialog" aria-label="Tracer" data-lawn={String(!!lawnMode)} data-service={serviceId}>
      <button type="button" onClick={() => onSaved({ id: 'zone-1' })}>Save trace</button>
      <button type="button" onClick={onClose}>Close tracer</button>
    </div>
  ),
}));

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
const plannedOne = (applicationMethod, extra = {}) => context({
  plannedProducts: { source: 'plan', items: [{ productId: P_TALAK, name: 'Talak 7.9%', applicationMethod, amount: 2, amountUnit: 'fl_oz', ...extra }] },
});

const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };
const ASSESSED = { id: 'assessment-1', confirmed_by_tech: false, ...SCORES };
const REVIEW = { status: 'complete', findings: [{ finding_id: 'f-1', name: 'Dollarweed', confidence: 'high' }], photoQuality: [] };

const refusal = (status, code, message, details = {}) => Object.assign(new Error(message), { status, code, details: { code, error: message, ...details } });

let requests;
let completeErrors;
let lookup;
let turfProfile;
let tips;
let blogAnswer;
let catalogAnswer;
let assessAnswer;
let confirmAnswer;

// A stub of the whole admin API the sheet talks to.
function makeRequest({ ctx = context(), contextError = null } = {}) {
  return vi.fn(async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    if (path.endsWith('/lawn-fast/context')) {
      if (contextError) throw contextError;
      return ctx;
    }
    if (path.includes('/turf-profile')) { if (turfProfile instanceof Error) throw turfProfile; return turfProfile; }
    if (path.endsWith('/tech-tips')) { if (tips instanceof Error) throw tips; return tips; }
    if (path.includes('/blog-posts')) { if (blogAnswer instanceof Error) throw blogAnswer; return typeof blogAnswer === 'function' ? blogAnswer(path) : blogAnswer; }
    if (path === '/admin/dispatch/products/catalog') return catalogAnswer;
    if (path.includes('/lawn-assessment/service/')) {
      if (lookup instanceof Error) throw lookup;
      return lookup;
    }
    if (path.endsWith('/lawn-assessment/assess')) return assessAnswer;
    if (path.endsWith('/lawn-assessment/confirm')) {
      const answer = typeof confirmAnswer === 'function' ? confirmAnswer(body) : confirmAnswer;
      if (answer instanceof Error) throw answer;
      return answer;
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
  lookup = { shotListEnabled: true, assessment: null };
  turfProfile = { profile: { lawn_sqft: 5000 } };
  tips = { available: false, groups: [] };
  blogAnswer = { available: false, posts: [] };
  catalogAnswer = { products: CATALOG };
  assessAnswer = { success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' };
  confirmAnswer = { success: true, confirmed: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
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

async function addPhoto() {
  const input = await screen.findByLabelText('Add turf photos');
  await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
  fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByLabelText('Slot for photo 1');
}
// Photos in, then Analyze lawn: the four scores show (each a box). Nothing is confirmed yet.
async function analyzeOnly() {
  await addPhoto();
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  await screen.findByLabelText('Density score');
}

const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
const confirmCalls = () => requests.filter((r) => r.path.endsWith('/lawn-assessment/confirm'));
const editorFor = (name) => screen.getByRole('group', { name });
const footerNote = () => document.querySelector('.tech-visit-footer [role="status"]')?.textContent || '';

async function submit() {
  fireEvent.click(completeButton());
  await waitFor(() => expect(completeCalls().length).toBeGreaterThan(0));
}
// Confirm assessment: the button the full form has too.
async function confirm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
}
// Photos, Analyze lawn, Confirm assessment.
async function analyze() {
  await analyzeOnly();
  await confirm();
}
// ... then Complete.
async function analyzeAndComplete() {
  await analyze();
  await waitFor(() => expect(completeButton().disabled).toBe(false));
  await submit();
}

describe('opening the sheet', () => {
  test('a visit the server calls ineligible is handed to the parent once, with no button on the sheet', async () => {
    const request = makeRequest({ ctx: context({ eligible: false, reason: 'has_companions' }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
  });

  test.each([404, 409])('a %s on the context (gate off, visit gone) is handed to the parent', async (status) => {
    const request = makeRequest({ contextError: Object.assign(new Error('x'), { status }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  });

  test('a failed read shows the error with Try again, and no way to a full form', async () => {
    const request = makeRequest({ contextError: Object.assign(new Error('Network down'), { status: 503 }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await screen.findByText('Network down');
    expect(onFullForm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/lawn-fast/context'))).toHaveLength(2));
  });

  test('a visit that changed since the schedule loaded is named, not completed', async () => {
    const request = makeRequest({ ctx: context({ service: { ...VISIT, propertyId: 'prop-other' } }) });
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} />);
    await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.');
    expect(screen.queryByRole('heading', { name: 'Lawn photos' })).toBeNull();
  });
});

describe('the screen', () => {
  test('shows the note first, then the photos, then the products, and one Complete button', async () => {
    await openSheet();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn photos', 'Products used', 'Treatment zone map']);
    expect(document.querySelectorAll('.tech-visit-footer .tech-visit-complete')).toHaveLength(1);
    expect(screen.getByRole('dialog').querySelector('header h2').textContent).toBe('Complete lawn visit');
  });

  test('has no Full form button, watering preview, lawn length box or area box, and asks for none of them', async () => {
    const { request } = await openSheet({ request: makeRequest({ ctx: context({ turfHeightCapture: true }) }) });
    await analyze();
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Watering after this visit' })).toBeNull();
    expect(screen.queryByText('Lawn length')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. 4')).toBeNull();
    expect(screen.queryByLabelText(/Area treated|Linear feet/)).toBeNull();
    expect(screen.queryByText(/Re-check last visit/)).toBeNull();
    expect(screen.queryByText('Photo findings')).toBeNull();
    expect(request.mock.calls.some(([path]) => /watering-preview/.test(path))).toBe(false);
    // The only buttons in the header: Close.
    expect(within(screen.getByRole('dialog').querySelector('header')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Close']);
  });

  test('before the read: the shot list with its one-line guides and one Analyze lawn button, nothing else in the photo block', async () => {
    await openSheet();
    expect(screen.getByTestId('lawn-shot-list')).toBeTruthy();
    expect(screen.getByTestId('lawn-shot-front').textContent).toMatch(/\S+/);
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(true);
    expect(screen.queryByLabelText('Density score')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retake' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm assessment' })).toBeNull();
  });

  test('Analyze lawn works at one photo, with the guide hint showing', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await addPhoto();
    expect(screen.getByTestId('lawn-shot-list-hint').textContent).toMatch(/This is a guide only/);
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(false);
  });

  test('after the read: the four scores in one row, each a box with the AI read, then Confirm assessment and Retake; neither extra tile', async () => {
    await openSheet();
    await analyzeOnly();
    for (const [label, value] of [['Density', '80'], ['Weed control', '70'], ['Color', '60'], ['Condition', '50']]) {
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByLabelText(`${label} score`).value).toBe(value);
    }
    // The read left fungus and thatch blank; the full form would offer them. The sheet never does.
    expect(screen.queryByText('Fungus control')).toBeNull();
    expect(screen.queryByText('Thatch condition')).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm assessment' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retake' })).toBeTruthy();
    // The photo slots are gone with the Analyze button.
    expect(screen.queryByRole('button', { name: 'Analyze lawn' })).toBeNull();
    expect(screen.queryByTestId('lawn-shot-list')).toBeNull();
    expect(screen.queryByText(/^AI \d+$/)).toBeNull();
  });

  test('the tech can change any of the four; the AI read stays in view; Confirm posts only what was typed', async () => {
    await openSheet();
    await analyzeOnly();
    fireEvent.change(screen.getByLabelText('Density score'), { target: { value: '65' } });
    expect(screen.getByTestId('lawn-ai-score-turf_density').textContent).toBe('AI 80');
    fireEvent.change(screen.getByLabelText('Condition score'), { target: { value: '' } });
    await confirm();
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body.adjustedScores).toEqual({ turf_density: 65, stress_damage: null });
    // Confirmed: the scores are plain text again.
    expect(screen.queryByLabelText('Density score')).toBeNull();
  });

  test('a score the read left blank takes a typed value too, and it rides the Confirm', async () => {
    assessAnswer = { ...assessAnswer, assessment: { ...ASSESSED, color_health: null }, adjustedScores: { ...SCORES, color_health: null } };
    await openSheet();
    await analyzeOnly();
    expect(screen.getByLabelText('Color score').value).toBe('');
    fireEvent.change(screen.getByLabelText('Color score'), { target: { value: '55' } });
    await confirm();
    expect(confirmCalls()[0].body.adjustedScores).toEqual({ color_health: 55 });
  });

  test('Retake goes back to the photo slots, and Complete says Add a photo', async () => {
    await openSheet();
    await analyzeOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
    await screen.findByTestId('lawn-shot-list');
    expect(completeButton().textContent).toBe('Add a photo');
    expect(completeButton().disabled).toBe(true);
  });
});

describe('what Complete says while it is off', () => {
  test('Add a photo, Analyze the photos, Confirm the assessment, then it turns on; one thing at a time, in the button', async () => {
    await openSheet();
    expect(completeButton().textContent).toBe('Add a photo');
    expect(completeButton().disabled).toBe(true);
    await addPhoto();
    expect(completeButton().textContent).toBe('Analyze the photos');
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    expect(completeButton().disabled).toBe(true);
    await confirm();
    await waitFor(() => expect(completeButton().textContent).toBe('Complete lawn visit'));
    expect(completeButton().disabled).toBe(false);
    // The reason is the button, not a line above it.
    expect(footerNote()).toBe('');
  });

  test('with no products on, Add the products applied; adding one turns it on', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await analyze();
    await waitFor(() => expect(completeButton().textContent).toBe('Add the products applied'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    await waitFor(() => expect(completeButton().textContent).toBe('Complete lawn visit'));
    expect(completeButton().disabled).toBe(false);
  });

  test('removing every planned product asks for the products again', async () => {
    await openSheet();
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(editorFor('Iron Plus')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(completeButton().textContent).toBe('Add the products applied'));
  });
});

describe('Confirm assessment, then Complete', () => {
  test('Confirm sends the scores as shown and the default keep-all review; Complete then sends the confirmed id', async () => {
    await openSheet();
    await analyzeAndComplete();
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({
      assessmentId: 'assessment-1',
      adjustedScores: {},
      reviewedFindings: [{ finding_id: 'f-1', keep: true, name: null, tech_note: null }],
      addedDetails: [],
    });
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
    const order = requests.map((r) => r.path).filter((path) => /\/lawn-assessment\/confirm$|\/complete$/.test(path));
    expect(order).toEqual(['/admin/lawn-assessment/confirm', '/admin/dispatch/svc-lawn/complete']);
  });

  test('a failed confirm shows the error, leaves Complete off, and Confirm can be tapped again', async () => {
    confirmAnswer = Object.assign(new Error('Could not save the scores'), { status: 500 });
    await openSheet();
    await analyzeOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
    await screen.findByText('Could not save the scores');
    expect(completeButton().textContent).toBe('Confirm the assessment');
    expect(completeButton().disabled).toBe(true);
    expect(completeCalls()).toHaveLength(0);
  });

  test('a confirm that leaves the assessment unconfirmed says why and Complete stays off', async () => {
    confirmAnswer = { success: true, confirmed: false, missingScores: ['fungus_control'], assessment: ASSESSED, visitAssessment: REVIEW };
    await openSheet();
    await analyzeOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
    await screen.findByText('The photos did not give a full read. Fill any blank score, or tap Retake and analyze again.');
    expect(completeButton().disabled).toBe(true);
  });

  test('a visit that already has a confirmed assessment completes without confirming', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: context({ assessment: { exists: true, id: 'assessment-1', confirmed: true, unusableReason: null } }) }) });
    await screen.findByText('Assessment confirmed');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(confirmCalls()).toHaveLength(0);
    expect(requests.some((r) => r.path.endsWith('/lawn-assessment/assess'))).toBe(false);
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
  });

  test('a confirmed assessment the report would reject (another property) does not count until redone', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: context({ assessment: { exists: true, id: 'assessment-1', confirmed: false, unusableReason: 'property_scope' } }) }) });
    await screen.findByText('Assessment confirmed');
    await waitFor(() => expect(footerNote()).toBe('This lawn check was made for a different property than this visit. Retake the photos, then analyze and confirm again.'));
    expect(completeButton().disabled).toBe(true);
  });

  test('the property-check wording differs from the property-scope wording', async () => {
    lookup = { shotListEnabled: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    await openSheet({ request: makeRequest({ ctx: context({ assessment: { exists: true, id: 'assessment-1', confirmed: true, unusableReason: 'property_check_failed' } }) }) });
    await waitFor(() => expect(footerNote()).toBe('We could not check this lawn assessment against this visit. Try again, or retake the photos and confirm again.'));
  });
});

describe('a confirmed assessment when the detail lookup fails', () => {
  const confirmedContext = (assessment = {}) => context({ assessment: { exists: true, id: 'assessment-ctx', confirmed: true, unusableReason: null, ...assessment } });

  test('the context\'s confirmed id stands, so Complete stays on and sends it without confirming', async () => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-ctx');
    expect(confirmCalls()).toHaveLength(0);
  });

  test('a retake that starts (a new photo) ends it; the new assessment is confirmed, then Complete sends its id', async () => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    const input = screen.getByLabelText('Add turf photos');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(completeButton().disabled).toBe(true));
    await screen.findByLabelText('Slot for photo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    expect(completeButton().disabled).toBe(true);
    await confirm();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(confirmCalls()).toHaveLength(1);
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
  });

  test.each([
    ['unusable (another property)', { confirmed: true, unusableReason: 'property_scope' }],
    ['unusable (check failed)', { confirmed: true, unusableReason: 'property_check_failed' }],
    ['not confirmed', { confirmed: false }],
  ])('is never used when the context says %s', async (_label, assessment) => {
    lookup = new Error('lookup down');
    await openSheet({ request: makeRequest({ ctx: confirmedContext(assessment) }) });
    await waitFor(() => expect(completeButton().textContent).toBe('Add a photo'));
    expect(completeButton().disabled).toBe(true);
  });

  test('a lookup that succeeds with no assessment does not fall back to the context\'s id', async () => {
    lookup = { shotListEnabled: true, assessment: null };
    await openSheet({ request: makeRequest({ ctx: confirmedContext() }) });
    await waitFor(() => expect(completeButton().textContent).toBe('Add a photo'));
  });
});

describe('products', () => {
  test('a recurring visit opens with the plan\'s products on: name, method, amount, and the whole-lawn area as text', async () => {
    await openSheet();
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByText('Broadcast spray · whole lawn, 6,000 sq ft')).toBeTruthy();
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('6.4');
    expect(within(talak).getByLabelText('Unit for Talak 7.9%').value).toBe('fl_oz');
    const iron = editorFor('Iron Plus');
    expect(within(iron).getByText('Spot treatment')).toBeTruthy();
    // The plan had no quantity for this one: blank, and said so, never invented.
    expect(within(iron).getByLabelText('Iron Plus').value).toBe('');
    expect(within(iron).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
  });

  test('no area box and no rate box, and no way to change the method', async () => {
    await openSheet();
    expect(screen.queryByLabelText(/Area treated|Linear feet/)).toBeNull();
    expect(screen.queryByLabelText(/ rate$/)).toBeNull();
    expect(screen.queryByLabelText(/label max/)).toBeNull();
    expect(within(editorFor('Talak 7.9%')).queryByRole('button', { name: /Broadcast spray|Granular|Spot treatment/ })).toBeNull();
  });

  test('a visit with no planned products shows the empty state and the add control only', async () => {
    const request = makeRequest({ ctx: ONE_TIME() });
    await openSheet({ request });
    expect(screen.queryByRole('group', { name: 'Talak 7.9%' })).toBeNull();
    expect(screen.getByText('No products yet. Add what you applied.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Other product' })).toBeTruthy();
    expect(request.mock.calls.some(([path]) => path.includes('/treatment-plans/'))).toBe(false);
    await analyze();
    expect(completeButton().textContent).toBe('Add the products applied');
  });

  test('a planned product the tech removes is sent as skipped, the way the full form does', async () => {
    await openSheet();
    fireEvent.click(within(editorFor('Iron Plus')).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Iron Plus' })).toBeNull();
    await analyzeAndComplete();
    const { body } = completeCalls()[0];
    expect(body.products.map((p) => p.productId)).toEqual([P_TALAK]);
    expect(body.lawnProtocolCompletion).toEqual({ skippedProducts: [{ productId: P_IRON, productName: 'Iron Plus' }] });
  });

  test('a product added from the picker joins on its own default method, with Remove', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    const editor = editorFor('Iron Plus');
    expect(within(editor).getByText(/added by you/)).toBeTruthy();
    expect(within(editor).getByText(/^Broadcast spray/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Iron Plus' })).toBeNull();
  });

  test('a sprayed product the tech adds goes down on the lawn area the plan gives; nobody types one', async () => {
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Green Granules'));
    expect(within(editorFor('Green Granules')).getByText(/whole lawn, 6,000 sq ft/)).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_GRANULE)).toMatchObject({ areaValue: 6000, areaUnit: 'sqft' });
  });

  test('a plan with no area uses the lawn area on the customer\'s turf profile', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    expect(await within(editorFor('Talak 7.9%')).findByText('Broadcast spray · whole lawn, 5,000 sq ft')).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 5000, areaUnit: 'sqft' });
  });

  test.each([
    ['has none', { profile: { lawn_sqft: null } }],
    ['cannot be read', new Error('down')],
  ])('a plan with no area and a profile that %s holds Complete in words, and invents none', async (_label, answer) => {
    turfProfile = answer;
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('The lawn area is not on file for Talak 7.9%. Tell the office.'));
    expect(completeButton().disabled).toBe(true);
    expect(completeCalls()).toHaveLength(0);
  });

  test('a perimeter product is held in words: this sheet has no linear-feet entry', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('perimeter_spray', { treatedSqft: 6000, areaUnit: 'sqft' }) }) });
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Talak 7.9% needs linear feet, which this sheet does not take. Tell the office.'));
    expect(completeButton().disabled).toBe(true);
  });

  // [method as the plan or catalog spells it, the unit the server wants or null]
  test.each([
    ['broadcast_spray', 'sqft'],
    ['Broadcast', 'sqft'],
    ['granular_broadcast', 'sqft'],
    ['spot_treatment', null],
    ['soil_drench', null],
    ['foliar_spray', null],
    ['bait_placement', null],
    ['station_check', null],
    ['fog_ulv', null],
    ['trunk_injection', null],
    ['pin_stream', null],
  ])('%s sends %s as /complete needs it', async (method, unit) => {
    await openSheet({ request: makeRequest({ ctx: plannedOne(method, { treatedSqft: 4100, areaUnit: 'sqft' }) }) });
    await analyzeAndComplete();
    const sent = completeCalls()[0].body.products[0];
    if (unit) expect(sent).toMatchObject({ areaValue: 4100, areaUnit: unit });
    else {
      expect(sent).not.toHaveProperty('areaValue');
      expect(sent).not.toHaveProperty('areaUnit');
    }
  });

  test('the server\'s area refusals get plain words with no button to follow', () => {
    expect(plainRefusalMessage({ code: 'area_sqft_required' })).toBe('The lawn area is missing for a sprayed or spread product. Tell the office.');
    expect(plainRefusalMessage({ code: 'linear_ft_required' })).toBe('A perimeter product needs linear feet, which this sheet does not take. Tell the office.');
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

  test('is one row with the first amount (as the full form keeps the first)', async () => {
    await openSheet({ request: makeRequest({ ctx: twice() }) });
    expect(screen.getAllByRole('group', { name: /^Talak/ })).toHaveLength(1);
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('3');
    await analyzeAndComplete();
    const { body } = completeCalls()[0];
    expect(body.products.map((p) => p.productId)).toEqual([P_TALAK, P_IRON]);
    expect(body).not.toHaveProperty('lawnProtocolCompletion');
  });

  test('removed, it is one skipped entry, so /complete\'s unique-list rule holds', async () => {
    await openSheet({ request: makeRequest({ ctx: twice() }) });
    fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Remove' }));
    await analyzeAndComplete();
    const { body } = completeCalls()[0];
    expect(body.lawnProtocolCompletion.skippedProducts).toEqual([{ productId: P_TALAK, productName: 'Talak 7.9%' }]);
    expect(body.products.map((p) => p.productId)).toEqual([P_IRON]);
  });
});

describe('the one-time lawn condition (a server requirement)', () => {
  test('a one-time lawn visit asks for the lawn condition, after the products, and sends it as typed findings', async () => {
    const request = makeRequest({ ctx: { ...ONE_TIME(), findingsType: 'one_time_lawn_treatment' } });
    await openSheet({ request });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Pick the lawn condition.'));
    expect(completeButton().disabled).toBe(true);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn photos', 'Products used', 'Lawn condition', 'Treatment zone map']);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.structuredFindings).toEqual({ type: 'one_time_lawn_treatment', values: { lawn_condition: 'Good' } });
  });

  test('a recurring visit sends no typed findings', async () => {
    await openSheet();
    await analyzeAndComplete();
    expect(completeCalls()[0].body).not.toHaveProperty('structuredFindings');
  });

  test('the condition list is the server\'s one_time_lawn_treatment list', () => {
    const field = PROJECT_TYPES.one_time_lawn_treatment.findingsFields.find((f) => f.key === 'lawn_condition');
    expect(LAWN_CONDITION_OPTIONS).toEqual(field.options);
  });

  test('typed findings come from the context only: null there means no row, whatever the schedule row says', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { service: { ...SERVICE, findingsType: 'one_time_lawn_treatment' } } });
    expect(screen.queryByRole('heading', { name: 'Lawn condition' })).toBeNull();
  });

  test('the key absent (an older server) is handed to the parent instead of guessed; a findings type that is not the lawn one too', async () => {
    const { findingsType: _omit, ...older } = ONE_TIME();
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest({ ctx: older })} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    cleanup();
    const second = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest({ ctx: context({ findingsType: 'tree_shrub' }) })} catalog={CATALOG} onClose={() => {}} onFullForm={second} />);
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  });
});

describe('the submit body', () => {
  test('echoes the context and sends no mowing height or watering token', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ turfHeightCapture: true }) }) });
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Synthetic note' } });
    fireEvent.change(within(editorFor('Iron Plus')).getByLabelText('Iron Plus'), { target: { value: '2' } });
    await analyzeAndComplete();
    const { body } = completeCalls()[0];
    expect(body.expectedVisit).toEqual(VISIT);
    // Every key, nulls included.
    expect(Object.keys(body.expectedVisit).sort()).toEqual(Object.keys(VISIT).sort());
    expect(body.lawnFast).toEqual({ visitType: 'recurring' });
    expect(body.lawnAssessmentId).toBe('assessment-1');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(8);
    expect(body).toMatchObject({
      visitOutcome: 'completed', technicianNotes: 'Synthetic note', techTips: null,
      sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto',
    });
    expect(body).not.toHaveProperty('manualHeightIn');
    expect(body).not.toHaveProperty('blogPostId');
    expect(JSON.stringify(body)).not.toMatch(/watering/i);
    expect(body.products).toEqual([
      { productId: P_TALAK, applicationMethod: 'broadcast_spray', totalAmount: 6.4, amountUnit: 'fl_oz', rate: 1.07, rateUnit: 'fl_oz', applicationArea: 'Front yard, Back yard, Side yards', areaValue: 6000, areaUnit: 'sqft', targets: [] },
      { productId: P_IRON, applicationMethod: 'spot_treatment', totalAmount: 2, amountUnit: 'fl_oz', applicationArea: 'Front yard, Back yard, Side yards', targets: [] },
    ]);
    expect(body).not.toHaveProperty('lawnProtocolCompletion');
  });

  test('the note typed before Analyze rides along to the photo read', async () => {
    await openSheet();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Chinch bugs by the curb' } });
    await analyze();
    expect(requests.find((r) => r.path.endsWith('/lawn-assessment/assess')).body.technicianNotes).toBe('Chinch bugs by the curb');
  });

  test('a successful save shows the saved view and hands the response up', async () => {
    const { onCompleted } = await openSheet();
    await analyzeAndComplete();
    await screen.findByText('Next stop');
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalledWith({ success: true, invoiceId: null });
  });
});

describe('application rate on the product rows', () => {
  const planned = (extra = {}, method = 'broadcast_spray') => plannedOne(method, { treatedSqft: 6000, areaUnit: 'sqft', ratePer1000: 1.07, rateUnit: 'fl_oz', ...extra });
  const sentRow = () => completeCalls()[0].body.products[0];
  const noRateKeys = () => { expect(sentRow()).not.toHaveProperty('rate'); expect(sentRow()).not.toHaveProperty('rateUnit'); };
  const run = async (ctx, before) => {
    await openSheet({ request: makeRequest({ ctx }) });
    if (before) before();
    await analyzeAndComplete();
  };

  test('an untouched planned row sends the plan rate and unit exactly as given', async () => {
    await run(planned());
    expect(sentRow()).toMatchObject({ rate: 1.07, rateUnit: 'fl_oz', totalAmount: 2, amountUnit: 'fl_oz', areaValue: 6000 });
  });

  test.each([
    ['the amount', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '3' } })],
    ['the amount unit', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Unit for Talak 7.9%'), { target: { value: 'gal' } })],
  ])('a change to %s sends no rate keys', async (_label, change) => {
    await run(planned(), change);
    noRateKeys();
  });

  test.each(['ml', 'percent_solution'])('a plan rate in %s (a unit /complete does not accept) is not sent', async (rateUnit) => {
    await run(planned({ rateUnit }));
    noRateKeys();
  });

  test('a plan with no rate sends none', async () => {
    await run(planned({ ratePer1000: null, rateUnit: null }));
    noRateKeys();
  });

  test('an added product sends no rate keys, even with a catalog default rate', async () => {
    const catalog = [{ ...CATALOG[0], default_unit: 'fl_oz', default_rate_per_1000: 2, max_label_rate_per_1000: 1 }, CATALOG[1], CATALOG[2]];
    await openSheet({ request: makeRequest({ ctx: plannedOne('spot_treatment') }), props: { catalog } });
    fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Talak 7.9%'));
    fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '2' } });
    await analyzeAndComplete();
    noRateKeys();
  });
});

// ── tips, the blog post and the treatment zone map (owner 2026-10-04) ───────
const lib = (labels) => ({ available: true, groups: [{ id: 'lawn', tips: labels.map((label) => ({ id: `tip-${label.toLowerCase().replace(/\W+/g, '-')}`, label, copy: `Copy ${label}.`, keywords: [label.toLowerCase()] })) }] });
const tipRead = (path) => path.endsWith('/tech-tips');
const POST = { id: '99999999-9999-4999-8999-999999999999', title: 'Why St. Augustine Thins in Summer', url: 'https://www.wavespestcontrol.com/lawn-care/st-augustine-summer-thinning/' };

describe('tips from your tech', () => {
  test('sits after the products, finds a tip by keyword, and sends the pick', async () => {
    tips = lib(['Mow high', 'Dollarweed', 'Sedge']);
    await openSheet();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn photos', 'Products used', 'Tip for the customer', 'Treatment zone map']);
    fireEvent.change(await screen.findByLabelText('Search tips'), { target: { value: 'sedge' } });
    expect(screen.queryByRole('button', { name: /Mow high/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Sedge/ }));
    await analyzeAndComplete();
    expect(completeCalls()[0].body.techTips).toEqual({ ids: ['tip-sedge'], custom: null });
  });

  test('no tip library, no section, and techTips is null', async () => {
    await openSheet();
    expect(screen.queryByLabelText('Search tips')).toBeNull();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.techTips).toBeNull();
  });

  test('reads the list again once the assessment settles, and keeps the tip already picked', async () => {
    tips = lib(['Mow high', 'Dollarweed']);
    await openSheet();
    fireEvent.click(await screen.findByRole('button', { name: /Mow high/ }));
    expect(requests.filter((r) => tipRead(r.path))).toHaveLength(1);
    tips = lib(['Dollarweed', 'Mow high']);
    await analyze();
    // the open, the analysis settling, the confirm settling
    await waitFor(() => expect(requests.filter((r) => tipRead(r.path))).toHaveLength(3));
    await waitFor(() => {
      const names = screen.getAllByRole('button', { name: /Mow high|Dollarweed/ }).map((b) => b.textContent);
      expect(names[0]).toMatch(/Dollarweed/);
    });
    expect(screen.getByRole('button', { name: /Mow high/ }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a re-read that answers unavailable clears the tips (the server would drop the pick)', async () => {
    tips = lib(['Mow high']);
    await openSheet();
    await screen.findByRole('button', { name: /Mow high/ });
    tips = { available: false, groups: [] };
    await analyze();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Mow high/ })).toBeNull());
  });
});

describe('the blog post for the customer', () => {
  test('is offered only while the server says it is available (GATE_REPORT_BLOG_POST), after the tips', async () => {
    await openSheet();
    expect(screen.queryByRole('heading', { name: 'Blog post for the customer' })).toBeNull();
    cleanup();
    tips = lib(['Mow high']);
    blogAnswer = { available: true, posts: [] };
    await openSheet();
    await screen.findByRole('heading', { name: 'Blog post for the customer' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn photos', 'Products used', 'Tip for the customer', 'Blog post for the customer', 'Treatment zone map']);
  });

  test('a failed availability read is no section', async () => {
    blogAnswer = new Error('down');
    await openSheet();
    await analyze();
    expect(screen.queryByRole('heading', { name: 'Blog post for the customer' })).toBeNull();
  });

  test('searches the Waves blog, and the pick rides /complete as blogPostId', async () => {
    blogAnswer = (path) => (path.includes('?q=') ? { available: true, posts: [POST] } : { available: true, posts: [] });
    await openSheet();
    fireEvent.change(await screen.findByLabelText('Search the Waves blog'), { target: { value: 'augustine' } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(POST.title) }));
    expect(screen.getByText('1 picked')).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.blogPostId).toBe(POST.id);
  });

  test('with no pick, no blogPostId is sent', async () => {
    blogAnswer = { available: true, posts: [] };
    await openSheet();
    await screen.findByRole('heading', { name: 'Blog post for the customer' });
    await analyzeAndComplete();
    expect(completeCalls()[0].body).not.toHaveProperty('blogPostId');
  });
});

describe('the treatment zone map', () => {
  test('is one closed, optional row after the rest; it never blocks Complete', async () => {
    await openSheet();
    const row = screen.getByRole('region', { name: 'Treatment zone map' });
    expect(within(row).getByText('Optional')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Tracer' })).toBeNull();
    await analyzeAndComplete();
    expect(completeCalls()).toHaveLength(1);
  });

  test('opens the lawn tracer over the sheet for this visit, makes the sheet inert, and marks it saved', async () => {
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Outline the treated lawn' }));
    const tracer = await screen.findByRole('dialog', { name: 'Tracer' });
    expect(tracer.getAttribute('data-lawn')).toBe('true');
    expect(tracer.getAttribute('data-service')).toBe('svc-lawn');
    expect(document.querySelector('section[role="dialog"][aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(within(tracer).getByRole('button', { name: 'Save trace' }));
    fireEvent.click(within(tracer).getByRole('button', { name: 'Close tracer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tracer' })).toBeNull());
    const row = screen.getByRole('region', { name: 'Treatment zone map' });
    expect(within(row).getByText('Saved')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Change the treated lawn outline' })).toBeTruthy();
  });

  test('a visit the schedule says cannot be traced shows no row', async () => {
    await openSheet({ props: { service: { ...SERVICE, traceEligible: false } } });
    expect(screen.queryByRole('region', { name: 'Treatment zone map' })).toBeNull();
  });
});

describe('what the server refuses', () => {
  // [status, code, words from the server, extra body, the plain words shown]
  const TERMINAL = [
    [409, 'lawn_fast_disabled', 'Lawn Fast Complete is not available. Use the full completion form.', {}, 'The quick lawn sheet is off right now. Close it and tell the office.'],
    [409, 'lawn_fast_not_eligible', 'This visit cannot be completed on the quick sheet. Use the full completion form.', { reason: 'grouped_visit' }, 'This visit cannot be completed on this sheet. Close it and tell the office.'],
    [409, 'visit_identity_changed', 'This visit changed since it was opened.', { reason: 'visit_type_changed' }, 'This visit changed since you opened it. Close it and open it again from the schedule.'],
  ];

  test.each(TERMINAL)('%i %s is terminal: the words show, Complete stays off, and no full form is offered', async (status, code, serverText, extra, shown) => {
    completeErrors.push(refusal(status, code, serverText, extra));
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(await screen.findByText('Iron Plus'));
    await analyzeAndComplete();
    await screen.findByText(shown);
    expect(completeButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
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
    await openSheet();
    await analyzeAndComplete();
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
    await openSheet();
    await analyzeAndComplete();
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
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/lawn-fast/context'))).toHaveLength(2));
  });

  test.each(['photo_status', 'turf_height_flag', 'planned_products', 'assessment'])('an advisory %s failure still opens the sheet', async (failure) => {
    await openSheet({ request: makeRequest({ ctx: context({ readFailures: [failure] }) }) });
    expect(screen.getByRole('heading', { name: 'Lawn photos' })).toBeTruthy();
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

describe('zero stock', () => {
  const EMPTY_CATALOG = [{ ...CATALOG[0], inventory_on_hand: '0.0000', inventory_unit: 'fl_oz' }, CATALOG[1], CATALOG[2]];
  const open = (props = {}, ctx = plannedOne('spot_treatment')) => openSheet({ request: makeRequest({ ctx }), props: { catalog: EMPTY_CATALOG, ...props } });

  test('holds Complete on a non-member visit, says so, and a stock refresh releases it', async () => {
    await open();
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Talak 7.9% shows 0 in stock. Update inventory, then tap Check stock.'));
    expect(completeButton().disabled).toBe(true);
    catalogAnswer = { products: [{ ...EMPTY_CATALOG[0], inventory_on_hand: '40.0000' }] };
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(footerNote()).toBe('');
  });

  test('does not hold a product with no amount (the server deducts nothing)', async () => {
    await open({}, plannedOne('spot_treatment', { amount: null }));
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('does not hold a real WaveGuard tier lawn visit (the server lets stock go negative)', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Gold' } });
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('holds a tier the server does not count (Commercial, or none)', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Commercial' } });
    await analyze();
    await waitFor(() => expect(footerNote()).toMatch(/shows 0 in stock/));
  });

  test('the context\'s stockAdvisory wins over the schedule row, both ways', async () => {
    await open({ service: { ...SERVICE, waveguardTier: 'Gold' } }, { ...plannedOne('spot_treatment'), stockAdvisory: false });
    await analyze();
    await waitFor(() => expect(footerNote()).toMatch(/shows 0 in stock/));
    cleanup();
    await open({}, { ...plannedOne('spot_treatment'), stockAdvisory: true });
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });

  test('waveguard_inventory_lockout from the server reads as a correctable stock message with Check stock offered', async () => {
    completeErrors.push(refusal(400, 'waveguard_inventory_lockout', 'Talak requires 2 fl_oz, but only 1 fl_oz is on hand.'));
    await openSheet({ request: makeRequest({ ctx: plannedOne('spot_treatment') }) });
    await analyzeAndComplete();
    await screen.findByText('A product is out of stock. Update inventory, tap Check stock, then complete again.');
    expect(screen.getByRole('button', { name: 'Check stock' })).toBeTruthy();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.idempotencyKey).not.toBe(completeCalls()[0].body.idempotencyKey);
    expect(confirmCalls()).toHaveLength(1);
  });
});

describe('text size and look', () => {
  test('no text on the sheet, including the shared photo step, is set under 14px', async () => {
    await openSheet();
    await analyze();
    const sized = Array.from(document.querySelectorAll('[style]')).filter((el) => el.style.fontSize);
    for (const el of sized) expect(parseFloat(el.style.fontSize)).toBeGreaterThanOrEqual(14);
    const small = Array.from(document.querySelectorAll('[class]')).filter((el) => /(^|\s)text-(11|12|13)(\s|$)/.test(el.getAttribute('class')));
    expect(small).toEqual([]);
  });

  test('one admin look: Analyze lawn and Confirm assessment are the standard dark button, Retake the light one, and nothing is green', async () => {
    await openSheet();
    await addPhoto();
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).className).toContain('bg-zinc-900');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    expect(screen.getByRole('button', { name: 'Confirm assessment' }).className).toContain('bg-zinc-900');
    expect(screen.getByRole('button', { name: 'Retake' }).className).toContain('bg-white');
    await confirm();
    // The confirmed state is a neutral row, not a green box.
    expect(screen.getByText('Assessment confirmed').className).toContain('bg-zinc-50');
    expect(document.body.innerHTML).not.toMatch(/green|emerald|#16A34A|#10B981|rgba?\(22, 163, 74/i);
  });

  test('the lawn sheet marks its form so a selected tile is soft (the style is scoped to .tech-lawn-fast)', async () => {
    await openSheet();
    expect(document.querySelector('.tech-visit-form-area.tech-lawn-fast')).not.toBeNull();
  });

  test('each of the four scores has Lower and Raise buttons in the sheet too', async () => {
    await openSheet();
    await analyzeOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Raise Condition score' }));
    expect(screen.getByLabelText('Condition score').value).toBe('51');
    fireEvent.click(screen.getByRole('button', { name: 'Lower Condition score' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lower Condition score' }));
    expect(screen.getByLabelText('Condition score').value).toBe('49');
    await confirm();
    expect(confirmCalls()[0].body.adjustedScores).toEqual({ stress_damage: 49 });
  });

  test('the sheet shows no price and no estimate card', async () => {
    await openSheet();
    await analyze();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText(/estimate|pricing/i)).toBeNull();
  });
});
