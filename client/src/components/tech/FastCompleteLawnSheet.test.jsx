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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet, { LAWN_CONDITION_OPTIONS, plainRefusalMessage } from './FastCompleteLawnSheet';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_TYPES } from '../../../../server/services/project-types.js';

vi.mock('./TechTreatmentZoneModal', () => ({
  default: ({ onClose, onSaved, lawnMode, serviceId, openVisitOnly }) => (
    <div role="dialog" aria-label="Tracer" data-lawn={String(!!lawnMode)} data-service={serviceId} data-open-only={String(openVisitOnly === true)}>
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
  // The server's method list (lawn-reservice-fast-context LAWN_METHODS), trimmed.
  methods: [
    { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
    { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
    { value: 'granular_broadcast', label: 'Granular broadcast', common: true, requiresSqft: true },
    { value: 'soil_drench', label: 'Soil drench', common: false, requiresSqft: false },
  ],
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

// GET /admin/schedule/:id/property-areas for the visit's own property.
const VERSION = 'a'.repeat(64);
const areasAnswer = (areas, extra = {}) => ({ enabled: true, propertyId: 'prop-1', customerId: 'cust-1', addressKey: 'k', version: VERSION, areas: { beds: null, lawn: null, mosquito: null, ...areas }, ...extra });

const refusal = (status, code, message, details = {}) => Object.assign(new Error(message), { status, code, details: { code, error: message, ...details } });

let requests;
let completeErrors;
let lookup;
let propertyAreasAnswer;
let tips;
let blogAnswer;
let customerAnswer;
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
    if (path.endsWith('/property-areas')) {
      const answer = typeof propertyAreasAnswer === 'function' ? await propertyAreasAnswer() : propertyAreasAnswer;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (/^\/admin\/customers\/[^/]+$/.test(path)) return customerAnswer;
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
  propertyAreasAnswer = areasAnswer({ lawn: { sqft: 5000, source: 'recorded', reviewedAt: null } });
  tips = { available: false, groups: [] };
  blogAnswer = { available: false, posts: [] };
  customerAnswer = { customer: { email: '' } };
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
  await screen.findByRole('heading', { name: 'Lawn assessment' });
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

// The inline product search: type, then tap the match. No sheet opens.
async function addProductByName(name) {
  fireEvent.change(await screen.findByLabelText('Search products'), { target: { value: name } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
}

const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
const confirmCalls = () => requests.filter((r) => r.path.endsWith('/lawn-assessment/confirm'));
const editorFor = (name) => screen.getByRole('group', { name });
// The product card's method dropdown ("How"), its selected label, and a pick by label.
const methodSelect = (editor) => within(editor).getByRole('combobox', { name: /^Method for / });
const pressedMethod = (editor) => { const sel = methodSelect(editor); return sel.value ? sel.options[sel.selectedIndex].textContent : null; };
const pickMethod = (editor, label) => {
  const sel = methodSelect(editor);
  fireEvent.change(sel, { target: { value: [...sel.options].find((o) => o.textContent === label).value } });
};
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
    expect(screen.queryByRole('heading', { name: 'Lawn assessment' })).toBeNull();
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
    expect(screen.queryByRole('heading', { name: 'Lawn assessment' })).toBeNull();
  });
});

describe('the screen', () => {
  test('shows the note first, then the photos, then the products, and one Complete button', async () => {
    await openSheet();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn assessment', 'Products used', 'Customer', 'Treatment zone map']);
    expect(document.querySelectorAll('.tech-visit-footer .tech-visit-complete')).toHaveLength(1);
    expect(screen.getByRole('dialog').querySelector('header h2').textContent).toBe('Complete service');
  });

  test('has no Full form button, watering preview or area box, and asks for none of them', async () => {
    const { request } = await openSheet();
    await analyze();
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Watering after this visit' })).toBeNull();
    // The server did not ask for a lawn length: no box.
    expect(screen.queryByText('Lawn length')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. 4')).toBeNull();
    expect(screen.queryByLabelText(/Area treated|Linear feet/)).toBeNull();
    expect(screen.queryByText(/Re-check last visit/)).toBeNull();
    expect(screen.queryByText('Photo findings')).toBeNull();
    expect(request.mock.calls.some(([path]) => /watering-preview/.test(path))).toBe(false);
    // The only button in the header without a Details handler: the round Back arrow (no X).
    expect(within(screen.getByRole('dialog').querySelector('header')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Back']);
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

  test('Analyze lawn works at one photo, and the sheet shows no minimum-photos guide', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await addPhoto();
    expect(screen.queryByTestId('lawn-shot-list-hint')).toBeNull();
    expect(screen.queryByText(/Aim for at least|Still needed|guide only/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).disabled).toBe(false);
  });

  test('the photo list is four named slots with one short guide each, and the count is a plain number', async () => {
    await openSheet();
    const slots = within(screen.getByTestId('lawn-shot-list')).getAllByRole('listitem');
    expect(slots.map((li) => li.getAttribute('data-testid'))).toEqual(['lawn-shot-front', 'lawn-shot-back', 'lawn-shot-close_up', 'lawn-shot-trouble']);
    expect(slots.map((li) => li.querySelector('.font-medium').textContent)).toEqual(['Front', 'Back or side', 'Close-up', 'Problem area']);
    for (const li of slots) expect(li.querySelector('.text-zinc-500').textContent.split(/\s+/).length).toBeLessThanOrEqual(9);
    for (const hidden of ['side', 'blade_crown', 'hot_edge', 'shade']) expect(screen.queryByTestId(`lawn-shot-${hidden}`)).toBeNull();
    expect(screen.getByText('0 added')).toBeTruthy();
    expect(screen.queryByText(/\/8/)).toBeNull();
    // A slot's own Add button tags the photo with the existing key it maps to.
    expect(screen.getByRole('button', { name: 'Add photo for Back or side' })).toBeTruthy();
  });

  test('a photo with a hidden shot key (an older visit, the generic button) still shows and counts', async () => {
    await openSheet();
    // The generic button adds an untagged photo; give it a hidden key from the slot menu.
    await addPhoto();
    expect(screen.getByText('1 added')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Slot for photo 1'), { target: { value: 'blade_crown' } });
    expect(screen.getByLabelText('Slot for photo 1').value).toBe('blade_crown');
    expect(screen.getByText('1 added')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove assessment photo' })).toBeTruthy();
    // It still feeds Analyze, tagged as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    expect(requests.find((r) => r.path.endsWith('/lawn-assessment/assess')).body.photos[0].zone).toBe('blade_crown');
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
    // Add a photo is a step the bar does itself now (it opens the photo chooser); it is never a completion.
    expect(completeButton().disabled).toBe(false);
  });
});

describe('what Complete says while it is off', () => {
  test('Add a photo, Analyze the photos, Confirm the assessment, then it turns on; one thing at a time, in the button', async () => {
    await openSheet();
    expect(completeButton().textContent).toBe('Add a photo');
    // Each photo step's label is a button that does that step (see the bar tests below).
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await addPhoto();
    expect(completeButton().textContent).toBe('Analyze the photos');
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    expect(completeButton().disabled).toBe(false);
    await confirm();
    await waitFor(() => expect(completeButton().textContent).toBe('Complete service'));
    expect(completeButton().disabled).toBe(false);
    // The reason is the button, not a line above it.
    expect(footerNote()).toBe('');
  });

  test('the bar does the step its label names: Analyze the photos runs the same assess request as Analyze lawn, once', async () => {
    await openSheet();
    await addPhoto();
    await waitFor(() => expect(completeButton().textContent).toBe('Analyze the photos'));
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await screen.findByLabelText('Density score');
    const assessCalls = requests.filter((r) => r.path.endsWith('/lawn-assessment/assess'));
    expect(assessCalls).toHaveLength(1);
    expect(assessCalls[0].body).toEqual({
      customerId: 'cust-1',
      serviceId: 'svc-lawn',
      photos: [{ data: 'cGhvdG8=', mimeType: 'image/jpeg' }],
      turfHeightIn: null,
      technicianNotes: '',
    });
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    expect(completeCalls()).toHaveLength(0);
  });

  test('while it analyzes the bar shows the in-flow busy text and is off; a second press adds no request', async () => {
    let finish;
    assessAnswer = new Promise((resolve) => { finish = resolve; });
    await openSheet();
    await addPhoto();
    await waitFor(() => expect(completeButton().textContent).toBe('Analyze the photos'));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeButton().textContent).toBe('Analyzing...'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(completeButton());
    expect(requests.filter((r) => r.path.endsWith('/lawn-assessment/assess'))).toHaveLength(1);
    await act(async () => { finish({ success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' }); });
    await screen.findByLabelText('Density score');
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
  });

  test('the bar confirms the assessment with the same request as Confirm assessment, and Complete only comes after', async () => {
    await openSheet();
    await analyzeOnly();
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await screen.findByText('Assessment confirmed');
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({
      assessmentId: 'assessment-1',
      adjustedScores: {},
      reviewedFindings: [{ finding_id: 'f-1', keep: true, name: null, tech_note: null }],
      addedDetails: [],
    });
    // The confirming press completed nothing.
    expect(completeCalls()).toHaveLength(0);
    await waitFor(() => expect(completeButton().textContent).toBe('Complete service'));
    await submit();
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
  });

  test('while it confirms the bar shows the busy text and is off, and a confirm that leaves it unconfirmed still blocks Complete', async () => {
    let finish;
    confirmAnswer = new Promise((resolve) => { finish = resolve; });
    await openSheet();
    await analyzeOnly();
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeButton().textContent).toBe('Confirming...'));
    expect(completeButton().disabled).toBe(true);
    await act(async () => { finish({ success: true, confirmed: false, missingScores: ['fungus_control'], assessment: ASSESSED, visitAssessment: REVIEW }); });
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
    fireEvent.click(completeButton());
    await waitFor(() => expect(confirmCalls()).toHaveLength(2));
    expect(completeCalls()).toHaveLength(0);
  });

  test('Add a photo in the bar opens the same photo chooser as Add turf photos', async () => {
    await openSheet();
    const input = await screen.findByLabelText('Add turf photos');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    const open = vi.spyOn(input, 'click');
    expect(completeButton().textContent).toBe('Add a photo');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    expect(open).toHaveBeenCalledTimes(1);
    expect(completeCalls()).toHaveLength(0);
  });

  test('with no products on, Add the products applied; adding one turns it on', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    await analyze();
    await waitFor(() => expect(completeButton().textContent).toBe('Products applied required'));
    expect(completeButton().disabled).toBe(true);
    await addProductByName('Iron Plus');
    await waitFor(() => expect(completeButton().textContent).toBe('Complete service'));
    expect(completeButton().disabled).toBe(false);
  });

  test('removing every planned product asks for the products again', async () => {
    await openSheet();
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(within(editorFor('Talak 7.9%')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(editorFor('Iron Plus')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(completeButton().textContent).toBe('Products applied required'));
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
    // The bar's Confirm can try again; it is still no completion.
    expect(completeButton().disabled).toBe(false);
    expect(completeCalls()).toHaveLength(0);
  });

  test('a confirm that leaves the assessment unconfirmed says why and Complete stays off', async () => {
    confirmAnswer = { success: true, confirmed: false, missingScores: ['fungus_control'], assessment: ASSESSED, visitAssessment: REVIEW };
    await openSheet();
    await analyzeOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm assessment' }));
    await screen.findByText('The photos did not give a full read. Fill any blank score, or tap Retake and analyze again.');
    expect(completeButton().textContent).toBe('Confirm the assessment');
    expect(completeCalls()).toHaveLength(0);
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
    await waitFor(() => expect(completeButton().textContent).toBe('Analyze the photos'));
    await screen.findByLabelText('Slot for photo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
    await screen.findByLabelText('Density score');
    await waitFor(() => expect(completeButton().textContent).toBe('Confirm the assessment'));
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
    // Not a completion: the bar opens the photo chooser here.
    expect(completeCalls()).toHaveLength(0);
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
    // The plan's own area for this product (6,000) is not the saved whole lawn (5,000): it is named a planned area.
    expect(pressedMethod(talak)).toBe('Broadcast spray');
    expect(within(talak).getByText('Planned area, 6,000 sq ft')).toBeTruthy();
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('6.4');
    expect(within(talak).getByLabelText('Unit for Talak 7.9%').value).toBe('fl_oz');
    const iron = editorFor('Iron Plus');
    expect(pressedMethod(iron)).toBe('Spot treatment');
    // A spot treatment goes down on no area, so none is named.
    expect(within(iron).queryByText(/sq ft/)).toBeNull();
    // The plan had no quantity for this one: blank, and said so, never invented.
    expect(within(iron).getByLabelText('Iron Plus').value).toBe('');
    expect(within(iron).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
  });

  test('no area box and no rate box', async () => {
    await openSheet();
    expect(screen.queryByLabelText(/Area treated|Linear feet/)).toBeNull();
    expect(screen.queryByLabelText(/ rate$/)).toBeNull();
    expect(screen.queryByLabelText(/label max/)).toBeNull();
  });

  test('the method is one dropdown from the context\'s list, the common three first, no chips and no More methods box', async () => {
    await openSheet();
    const talak = editorFor('Talak 7.9%');
    expect([...methodSelect(talak).options].map((o) => o.textContent)).toEqual(['Spot treatment', 'Broadcast spray', 'Granular broadcast', 'Soil drench']);
    expect(within(talak).queryByRole('group', { name: 'How' })).toBeNull();
    expect(within(talak).queryByLabelText('More methods for Talak 7.9%')).toBeNull();
    expect(within(talak).queryByText('Perimeter spray? Use Full form.')).toBeNull();
  });

  test('a planned row starts on the protocol\'s own application mode', async () => {
    await openSheet();
    expect(pressedMethod(editorFor('Talak 7.9%'))).toBe('Broadcast spray');
    expect(pressedMethod(editorFor('Iron Plus'))).toBe('Spot treatment');
  });

  test('an older context with no methods still offers the common three', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ methods: undefined }) }) });
    expect([...methodSelect(editorFor('Talak 7.9%')).options].map((o) => o.textContent)).toEqual(['Spot treatment', 'Broadcast spray', 'Granular broadcast']);
  });

  test('moving a planned broadcast row to Spot treatment drops its area and the plan\'s rate; the amount stays', async () => {
    await openSheet();
    const talak = editorFor('Talak 7.9%');
    pickMethod(talak, 'Spot treatment');
    expect(pressedMethod(talak)).toBe('Spot treatment');
    expect(within(talak).queryByText(/sq ft/)).toBeNull();
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('6.4');
    await analyze();
    await submit();
    const sent = completeCalls()[0].body.products.find((p) => p.productId === P_TALAK);
    expect(sent).toMatchObject({ applicationMethod: 'spot_treatment', totalAmount: 6.4, amountUnit: 'fl_oz' });
    expect(sent.areaValue).toBeUndefined();
    expect(sent.areaUnit).toBeUndefined();
    expect(sent.rate).toBeUndefined();
    expect(sent.rateUnit).toBeUndefined();
  });

  test('a planned row left on the plan\'s method keeps the plan\'s rate; re-choosing that method is not a change', async () => {
    await openSheet();
    const talak = editorFor('Talak 7.9%');
    pickMethod(talak, 'Broadcast spray');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_TALAK)).toMatchObject({ applicationMethod: 'broadcast_spray', rate: 1.07, rateUnit: 'fl_oz', areaValue: 6000, areaUnit: 'sqft' });
  });

  test('a spot row moved to Broadcast spray goes down on the whole lawn, as a broadcast does', async () => {
    await openSheet();
    const iron = editorFor('Iron Plus');
    pickMethod(iron, 'Broadcast spray');
    expect(within(iron).getByText('Whole lawn, 5,000 sq ft')).toBeTruthy();
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_IRON)).toMatchObject({ applicationMethod: 'broadcast_spray', areaValue: 5000, areaUnit: 'sqft' });
  });

  // ── "Also in October's protocol": the window's products as add-ons ────────
  const P_ART = 'aaaaaaaa-0000-4000-8000-000000000004';
  const WINDOW = () => ({
    title: 'October Fall Feeding + Pre-Emergent (spreader)', month: 10, visitType: 'granular_production_plus_spots',
    products: [
      { productId: P_GRANULE, name: 'Green Granules', role: 'fall_pre_emergent_nutrition', defaultInPlan: true, applicationMethod: 'granular_broadcast', ratePer1000: 4.02, rateUnit: 'lb', trigger: null, tankMixWith: null },
      { productId: P_ART, name: 'Artavia 2 SC', role: 'fungicide_spot', defaultInPlan: false, applicationMethod: 'spot_treatment', ratePer1000: null, rateUnit: null, trigger: 'mapped_large_patch_with_velista_and_take_all_fall_2', tankMixWith: null },
      { productId: P_TALAK, name: 'Talak 7.9%', role: 'insecticide_spot', defaultInPlan: false, applicationMethod: 'spot_treatment', ratePer1000: null, rateUnit: null, trigger: 'chinch_20_to_25_per_sqft', tankMixWith: null },
      { productId: P_IRON, name: 'Iron Plus', role: 'post_emergent_spot', defaultInPlan: false, applicationMethod: 'broadcast_spray', ratePer1000: 0.5, rateUnit: 'fl_oz', trigger: null, tankMixWith: 'Celsius WG' },
      // Not in the catalog the sheet has: cannot be built, so not offered.
      { productId: 'aaaaaaaa-0000-4000-8000-000000000099', name: 'Ghost', role: 'x', defaultInPlan: false, applicationMethod: 'spot_treatment', ratePer1000: null, rateUnit: null, trigger: null, tankMixWith: null },
    ],
  });
  const ARTAVIA = { id: P_ART, name: 'Artavia 2 SC', category: 'fungicide', formulation: 'SC' };
  const addons = () => screen.getByRole('group', { name: "Also in October’s protocol" });

  test('a recurring visit offers the window\'s opt-in products, not its plan default, each with its words, method and rate; the planned ones read On the sheet', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ protocolWindow: WINDOW() }) }), props: { catalog: [...CATALOG, ARTAVIA] } });
    const row = addons();
    expect(within(row).getByText('Spot work for this visit. Tap what you applied.')).toBeTruthy();
    expect(within(row).queryByText('Green Granules')).toBeNull();
    expect(within(row).queryByText('Ghost')).toBeNull();
    expect(within(row).getByText('Mapped large patch (with Velista) or fall take-all · spot treatment')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Add Artavia 2 SC' }).disabled).toBe(false);
    // Talak and Iron Plus are planned rows already.
    expect(within(row).getAllByText('On the sheet')).toHaveLength(2);
    expect(within(row).getByRole('button', { name: 'Talak 7.9% is on the sheet' }).disabled).toBe(true);
  });

  test('tapping Add puts the product on the sheet on the protocol\'s method, marked from the protocol, and the row then reads On the sheet', async () => {
    await openSheet({ request: makeRequest({ ctx: context({ protocolWindow: WINDOW() }) }), props: { catalog: [...CATALOG, ARTAVIA] } });
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add Artavia 2 SC' }));
    const artavia = editorFor('Artavia 2 SC');
    expect(pressedMethod(artavia)).toBe('Spot treatment');
    expect(within(artavia).getByText(/from the protocol/)).toBeTruthy();
    expect(within(artavia).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
    expect(within(addons()).getByRole('button', { name: 'Artavia 2 SC is on the sheet' }).disabled).toBe(true);
    await analyze();
    await submit();
    const sent = completeCalls()[0].body.products.find((p) => p.productId === P_ART);
    expect(sent).toMatchObject({ applicationMethod: 'spot_treatment' });
    expect(sent.rate).toBeUndefined();
  });

  test('a one-time visit offers every window product, the plan default included, and a protocol rate figures the amount on the lawn', async () => {
    await openSheet({ request: makeRequest({ ctx: { ...ONE_TIME(), protocolWindow: WINDOW() } }), props: { catalog: [...CATALOG, ARTAVIA] } });
    const row = addons();
    expect(within(row).getByText('Green Granules')).toBeTruthy();
    expect(within(row).getByText('Granular broadcast · 4.02 lb per 1,000 sq ft')).toBeTruthy();
    expect(within(row).getByText('Weed spots · tank mix with Celsius WG · broadcast spray · 0.5 fl oz per 1,000 sq ft')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Add Green Granules' }));
    const granules = editorFor('Green Granules');
    expect(pressedMethod(granules)).toBe('Granular broadcast');
    // 4.02 lb per 1,000 on the 5,000 sq ft lawn.
    expect(within(granules).getByLabelText('Green Granules').value).toBe('20.1');
    expect(within(granules).getByLabelText('Unit for Green Granules').value).toBe('lb');
    expect(within(granules).getByText('4.02 lb per 1,000 sq ft × 5,000 sq ft')).toBeTruthy();
  });

  test('no window, or a window with nothing the sheet can offer, shows no row', async () => {
    await openSheet();
    expect(screen.queryByRole('group', { name: /protocol$/ })).toBeNull();
    cleanup();
    await openSheet({ request: makeRequest({ ctx: context({ protocolWindow: { title: 'x', month: 10, products: [WINDOW().products[4]] } }) }) });
    expect(screen.queryByRole('group', { name: /protocol$/ })).toBeNull();
  });

  // ── the figured amount (owner 2026-10-05: nobody types one on a fast complete) ──
  const RATED = [{ ...CATALOG[0], default_rate_per_1000: 2, default_unit: 'fl_oz/1000sf' }, CATALOG[1], { ...CATALOG[2], default_rate_per_1000: 3, default_unit: 'lb' }];

  test('an added sprayed product is figured from the catalog rate per 1,000 sq ft on the whole lawn, says so, and sends that amount with no rate keys', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    // 2 fl oz per 1,000 on the 5,000 sq ft lawn.
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('10');
    expect(within(talak).getByLabelText('Unit for Talak 7.9%').value).toBe('fl_oz');
    expect(within(talak).getByText('2 fl oz per 1,000 sq ft × 5,000 sq ft')).toBeTruthy();
    expect(within(talak).queryByText('No amount entered. It is recorded without one.')).toBeNull();
    await analyze();
    await submit();
    const sent = completeCalls()[0].body.products.find((p) => p.productId === P_TALAK);
    expect(sent).toMatchObject({ applicationMethod: 'broadcast_spray', totalAmount: 10, amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft' });
    expect(sent.rate).toBeUndefined();
  });

  test('a granular product is figured in its dry unit, and a small liquid dose reads in spoons', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Green Granules');
    const granules = editorFor('Green Granules');
    expect(within(granules).getByLabelText('Green Granules').value).toBe('15');
    expect(within(granules).getByLabelText('Unit for Green Granules').value).toBe('lb');
    // 0.1 fl oz per 1,000 on 5,000 sq ft is half a fluid ounce: 3 tsp.
    cleanup();
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: [{ ...RATED[0], default_rate_per_1000: 0.1 }] } });
    await addProductByName('Talak 7.9%');
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('3');
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Unit for Talak 7.9%').value).toBe('tsp');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 0.5, amountUnit: 'fl_oz' });
  });

  test('a tiny liquid dose is rounded once, to the record\'s precision, and still recorded (never zeroed by a two-decimal pre-round)', async () => {
    // 0.0008 fl oz per 1,000 on 5,000 sq ft is 0.004 fl oz: no spoon reading
    // (not an eighth of a teaspoon), so it stays in fl oz at three decimals.
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: [{ ...RATED[0], default_rate_per_1000: 0.0008 }] } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('0.004');
    expect(within(talak).getByLabelText('Unit for Talak 7.9%').value).toBe('fl_oz');
    expect(within(talak).queryByText('No amount entered. It is recorded without one.')).toBeNull();
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 0.004, amountUnit: 'fl_oz' });
  });

  test('moved to Spot treatment, an added product has no area, so nothing is figured and the box is empty again', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    pickMethod(talak, 'Spot treatment');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('');
    expect(within(talak).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
    pickMethod(talak, 'Broadcast spray');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('10');
  });

  test('an amount the tech types wins over the figured one and survives a method change', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    fireEvent.change(within(talak).getByLabelText('Talak 7.9%'), { target: { value: '12' } });
    expect(within(talak).queryByText(/per 1,000 sq ft/)).toBeNull();
    pickMethod(talak, 'Spot treatment');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('12');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ applicationMethod: 'spot_treatment', totalAmount: 12, amountUnit: 'fl_oz' });
  });

  test('a planned product with no plan quantity is figured on the plan\'s own area; one with a quantity keeps the plan\'s', async () => {
    const ctx = context({ plannedProducts: { source: 'plan', items: [
      { productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'broadcast_spray', amount: 6.4, amountUnit: 'fl_oz', treatedSqft: 6000, areaUnit: 'sqft' },
      { productId: P_IRON, name: 'Iron Plus', applicationMethod: 'spot_treatment', amount: null, amountUnit: 'fl_oz', treatedSqft: 1500, areaUnit: 'sqft' },
    ] } });
    const catalog = [RATED[0], { ...CATALOG[1], default_rate_per_1000: 4, default_unit: 'fl_oz' }, RATED[2]];
    await openSheet({ request: makeRequest({ ctx }), props: { catalog } });
    // The plan's 6.4 stands, not 2 x 6 = 12.
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('6.4');
    expect(within(editorFor('Talak 7.9%')).queryByText(/per 1,000 sq ft/)).toBeNull();
    // 4 fl oz per 1,000 on the plan's 1,500 sq ft spot area.
    expect(within(editorFor('Iron Plus')).getByLabelText('Iron Plus').value).toBe('6');
    expect(within(editorFor('Iron Plus')).getByText('4 fl oz per 1,000 sq ft × 1,500 sq ft')).toBeTruthy();
  });

  test.each([
    ['a per-gallon rate', { default_rate_per_1000: 2, default_unit: 'fl_oz/gal' }],
    ['a rate in mL', { default_rate_per_1000: 2, default_unit: 'ml' }],
    ['no catalog rate', {}],
  ])('%s figures nothing: the box stays empty', async (_label, fields) => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: [{ ...CATALOG[0], ...fields }] } });
    await addProductByName('Talak 7.9%');
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('');
    expect(within(editorFor('Talak 7.9%')).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
  });

  test('a method past the common three is sent as is', async () => {
    await openSheet();
    const talak = editorFor('Talak 7.9%');
    pickMethod(talak, 'Soil drench');
    expect(pressedMethod(talak)).toBe('Soil drench');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_TALAK)).toMatchObject({ applicationMethod: 'soil_drench' });
  });

  test('a visit with no planned products shows the inline search and no empty-state text', async () => {
    const request = makeRequest({ ctx: ONE_TIME() });
    await openSheet({ request });
    expect(screen.queryByRole('group', { name: 'Talak 7.9%' })).toBeNull();
    expect(screen.queryByText(/No products yet/)).toBeNull();
    expect(screen.getByLabelText('Search products').getAttribute('placeholder')).toBe('Search products');
    expect(screen.queryByRole('button', { name: '+ Other product' })).toBeNull();
    expect(request.mock.calls.some(([path]) => path.includes('/treatment-plans/'))).toBe(false);
    await analyze();
    expect(completeButton().textContent).toBe('Products applied required');
  });

  test('the search sits in the Products section: typing filters the catalog in place and one tap adds the row, with no sheet opened', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    const box = screen.getByLabelText('Search products');
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
    // Nothing is listed until the tech types.
    expect(screen.queryByRole('button', { name: /Green Granules/ })).toBeNull();
    fireEvent.change(box, { target: { value: 'granul' } });
    expect(screen.queryByRole('button', { name: /Iron Plus/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Green Granules/ }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
    expect(within(editorFor('Green Granules')).getByText(/added by you/)).toBeTruthy();
    // The box clears for the next product, and the added one is marked as on the sheet.
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'granul' } });
    expect(screen.getByRole('button', { name: /Green Granules/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Green Granules/ }).textContent).toMatch(/Already on the sheet/);
  });

  test('matches that appear are scrolled into view (nearest), so they are not left under the bar; no match scrolls nothing', async () => {
    // jsdom has no scrollIntoView; the picker guards for that and calls it where it exists.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
      const box = screen.getByLabelText('Search products');
      fireEvent.change(box, { target: { value: 'zzzz' } });
      expect(screen.getByText('No products match.')).toBeTruthy();
      expect(scrollIntoView).not.toHaveBeenCalled();
      fireEvent.change(box, { target: { value: 'granul' } });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('group', { name: 'Matching products' }));
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  test('a search with no match says so', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }) });
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No products match.')).toBeTruthy();
  });

  test('with no catalog to pick from, + Other product hands the visit to the full form instead of doing nothing', async () => {
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest({ ctx: ONE_TIME() })} catalog={[]} onClose={() => {}} onFullForm={onFullForm} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Other product' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
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
    await addProductByName('Iron Plus');
    const editor = editorFor('Iron Plus');
    expect(within(editor).getByText(/added by you/)).toBeTruthy();
    expect(within(editor).getByText(/^Broadcast spray/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Iron Plus' })).toBeNull();
  });

  test('a sprayed product the tech adds goes down on the WHOLE-lawn area (the property\'s saved one), not a planned product\'s area; nobody types one', async () => {
    await openSheet();
    await addProductByName('Green Granules');
    expect(within(editorFor('Green Granules')).getByText(/Whole lawn, 5,000 sq ft/)).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_GRANULE)).toMatchObject({ areaValue: 5000, areaUnit: 'sqft' });
    // The planned Talak row keeps its own area.
    expect(completeCalls()[0].body.products.find((p) => p.productId === P_TALAK)).toMatchObject({ areaValue: 6000 });
  });

  test('a spot-factor plan: the spot row submits its own partial area, an added broadcast product the whole lawn, and the visit coverage is the whole lawn', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: { sqft: 5750, source: 'recorded', reviewedAt: null } });
    const ctx = context({ plannedProducts: { source: 'plan', items: [
      { productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'broadcast_spray', amount: 2, amountUnit: 'fl_oz', treatedSqft: 1437.5, areaUnit: 'sqft' },
    ] } });
    await openSheet({ request: makeRequest({ ctx }) });
    // Named for what it is: never "whole lawn" for a partial area.
    expect(within(editorFor('Talak 7.9%')).getByText('Planned area, 1,437.5 sq ft')).toBeTruthy();
    expect(within(editorFor('Talak 7.9%')).queryByText(/whole lawn/)).toBeNull();
    await addProductByName('Green Granules');
    expect(await within(editorFor('Green Granules')).findByText(/Whole lawn, 5,750 sq ft/)).toBeTruthy();
    await analyzeAndComplete();
    const { body } = completeCalls()[0];
    expect(body.products.find((p) => p.productId === P_TALAK)).toMatchObject({ areaValue: 1437.5, areaUnit: 'sqft' });
    expect(body.products.find((p) => p.productId === P_GRANULE)).toMatchObject({ areaValue: 5750, areaUnit: 'sqft' });
    expect(body.propertyServiceArea).toEqual({ propertyId: 'prop-1', version: VERSION, kind: 'lawn', treatedSqft: 5750 });
  });

  test('a planned row\'s own area equal to the saved whole lawn is called the whole lawn', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: { sqft: 6000, source: 'recorded', reviewedAt: null } });
    await openSheet();
    expect(await within(editorFor('Talak 7.9%')).findByText('Whole lawn, 6,000 sq ft')).toBeTruthy();
  });

  test('plan area only, property areas off: the planned row completes with its own area, and no visit coverage is sent', async () => {
    propertyAreasAnswer = { enabled: false };
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray', { treatedSqft: 1437.5, areaUnit: 'sqft' }) }) });
    expect(within(editorFor('Talak 7.9%')).getByText('Planned area, 1,437.5 sq ft')).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 1437.5 });
    expect(completeCalls()[0].body).not.toHaveProperty('propertyServiceArea');
  });

  test('an added broadcast product with no whole-lawn area known stays held, though the planned row has its own area', async () => {
    propertyAreasAnswer = { enabled: false };
    await openSheet({ request: makeRequest({ ctx: plannedOne('spot_treatment', { treatedSqft: 1437.5, areaUnit: 'sqft' }) }) });
    await addProductByName('Green Granules');
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('The lawn area is not on file for Green Granules. Tell the office.'));
    expect(completeButton().disabled).toBe(true);
  });

  const talakNeedsArea = async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
  };
  const heldInWords = async () => {
    await talakNeedsArea();
    await waitFor(() => expect(footerNote()).toBe('The lawn area is not on file for Talak 7.9%. Tell the office.'));
    expect(completeButton().disabled).toBe(true);
    expect(completeCalls()).toHaveLength(0);
  };

  test('a plan with no area uses the lawn area its own property has recorded (the primary property), read from the visit, never the customer\'s turf profile', async () => {
    const { request } = await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    expect(await within(editorFor('Talak 7.9%')).findByText('Whole lawn, 5,000 sq ft')).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 5000, areaUnit: 'sqft' });
    expect(request.mock.calls.some(([path]) => path === '/admin/schedule/svc-lawn/property-areas')).toBe(true);
    expect(request.mock.calls.some(([path]) => /turf-profile/.test(path))).toBe(false);
  });

  test('a secondary property\'s own reviewed area is the one used', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: { sqft: 2200, source: 'measured', reviewedAt: '2026-09-01T00:00:00.000Z', reviewedBy: 'tech-1' } }, { propertyId: 'prop-2' });
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    expect(await within(editorFor('Talak 7.9%')).findByText('Whole lawn, 2,200 sq ft')).toBeTruthy();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 2200, areaUnit: 'sqft' });
  });

  test('a secondary property with no saved area is held in words, and the primary\'s figure is not borrowed', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: null }, { propertyId: 'prop-2' });
    await heldInWords();
  });

  test.each([
    ['a lookup estimate from imagery', { lawn: { sqft: 4100, source: 'imagery', reviewedAt: null } }],
    ['a computed county estimate', { lawn: { sqft: 4100, source: 'computed', reviewedAt: null } }],
    ['a recorded area of zero', { lawn: { sqft: 0, source: 'recorded', reviewedAt: null } }],
  ])('%s is not a saved area: held in words', async (_label, areas) => {
    propertyAreasAnswer = areasAnswer(areas);
    await heldInWords();
  });

  test.each([
    ['the feature is off (enabled false)', { enabled: false }],
    ['the feature answers 404', Object.assign(new Error('Not found'), { status: 404 })],
    ['the read fails', new Error('down')],
  ])('when %s, no lawn area is known: held in words, and no turf profile is read', async (_label, answer) => {
    propertyAreasAnswer = answer;
    const request = makeRequest({ ctx: plannedOne('broadcast_spray') });
    await openSheet({ request });
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('The lawn area is not on file for Talak 7.9%. Tell the office.'));
    expect(completeButton().disabled).toBe(true);
    expect(request.mock.calls.some(([path]) => /turf-profile/.test(path))).toBe(false);
  });

  test('a plan that gives the area still completes with the property areas off, and sends no property coverage', async () => {
    propertyAreasAnswer = { enabled: false };
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray', { treatedSqft: 4100, areaUnit: 'sqft' }) }) });
    await analyzeAndComplete();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 4100 });
    expect(completeCalls()[0].body).not.toHaveProperty('propertyServiceArea');
  });

  test('the completion carries the visit\'s coverage as the full form does: property, version, lawn, the area treated', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: { sqft: 2200, source: 'measured', reviewedAt: '2026-09-01T00:00:00.000Z' } }, { propertyId: 'prop-2' });
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyzeAndComplete();
    expect(completeCalls()[0].body.propertyServiceArea).toEqual({ propertyId: 'prop-2', version: VERSION, kind: 'lawn', treatedSqft: 2200 });
  });

  test('no coverage is sent for a visit the server would not read as a lawn service', async () => {
    const ctx = plannedOne('spot_treatment', { treatedSqft: 4100, areaUnit: 'sqft' });
    await openSheet({ request: makeRequest({ ctx: { ...ctx, service: { ...VISIT, serviceType: 'Quarterly Pest Control' } } }), props: { service: { ...SERVICE, routedServiceType: undefined } } });
    await analyzeAndComplete();
    expect(completeCalls()[0].body).not.toHaveProperty('propertyServiceArea');
  });

  test('the visit coverage is the saved whole lawn, never a planned product\'s own area', async () => {
    await openSheet({ request: makeRequest({ ctx: plannedOne('spot_treatment', { treatedSqft: 4100, areaUnit: 'sqft' }) }) });
    await analyzeAndComplete();
    expect(completeCalls()[0].body.propertyServiceArea).toMatchObject({ kind: 'lawn', treatedSqft: 5000, version: VERSION });
    expect(completeCalls()[0].body.products[0]).toMatchObject({ applicationMethod: 'spot_treatment' });
  });

  test('property_service_area_changed (409): the areas are read again once, the words say tap Complete again, and the next tap sends the new version under a new key', async () => {
    completeErrors.push(refusal(409, 'property_service_area_changed', 'Property areas changed. Reload and review the job coverage.'));
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
    const reads = () => requests.filter((r) => r.path.endsWith('/property-areas')).length;
    expect(reads()).toBe(1);
    propertyAreasAnswer = areasAnswer({ lawn: { sqft: 5200, source: 'recorded', reviewedAt: null } }, { version: 'b'.repeat(64) });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    await screen.findByText('This property\u2019s lawn area changed. We reloaded it. Tap Complete again.');
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(within(editorFor('Talak 7.9%')).getByText(/5,200 sq ft/)).toBeTruthy());
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.propertyServiceArea).toMatchObject({ version: 'b'.repeat(64), treatedSqft: 5200 });
    expect(completeCalls()[1].body.idempotencyKey).not.toBe(completeCalls()[0].body.idempotencyKey);
    expect(confirmCalls()).toHaveLength(1);
    expect(reads()).toBe(2);
  });

  const refuseOnce = () => completeErrors.push(refusal(409, 'property_service_area_changed', 'Property areas changed. Reload and review the job coverage.'));
  const FRESH = () => areasAnswer({ lawn: { sqft: 5200, source: 'recorded', reviewedAt: null } }, { version: 'b'.repeat(64) });

  test('after property_service_area_changed Complete is held until the fresh areas have loaded, then released', async () => {
    refuseOnce();
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    let release;
    propertyAreasAnswer = () => new Promise((resolve) => { release = () => resolve(FRESH()); });
    await submit();
    await screen.findByText('This property\u2019s lawn area changed. We reloaded it. Tap Complete again.');
    await waitFor(() => expect(footerNote()).toBe('Reloading the property areas\u2026'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(completeButton());
    expect(completeCalls()).toHaveLength(1);
    release();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(footerNote()).toBe('');
  });

  test('a failed refresh keeps the hold with a visible Retry, and Retry brings the fresh version back', async () => {
    refuseOnce();
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    propertyAreasAnswer = new Error('down');
    await submit();
    await waitFor(() => expect(footerNote()).toBe('The property areas did not reload. Tap Retry, then Complete.'));
    expect(completeButton().disabled).toBe(true);
    propertyAreasAnswer = FRESH();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.propertyServiceArea).toMatchObject({ version: 'b'.repeat(64), treatedSqft: 5200 });
  });

  test('a failed refresh never lets a row that carries its own area go out without the version fence', async () => {
    refuseOnce();
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray', { treatedSqft: 4100, areaUnit: 'sqft' }) }) });
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    propertyAreasAnswer = new Error('down');
    await submit();
    await waitFor(() => expect(footerNote()).toBe('The property areas did not reload. Tap Retry, then Complete.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(completeButton());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completeCalls()).toHaveLength(1);
  });

  test('a lawn with no recorded area takes the area the technician sets for this visit, and says so', async () => {
    propertyAreasAnswer = areasAnswer({ lawn: null });
    await openSheet({ request: makeRequest({ ctx: plannedOne('broadcast_spray') }) });
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('The lawn area is not on file for Talak 7.9%. Tell the office.'));
    fireEvent.change(await screen.findByLabelText('Area treated today (sq ft)'), { target: { value: '3000' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ areaValue: 3000, areaUnit: 'sqft' });
    expect(completeCalls()[0].body.propertyServiceArea).toEqual({ propertyId: 'prop-1', version: VERSION, kind: 'lawn', treatedSqft: 3000, explicitVisitArea: true });
  });

  test('a recorded lawn shows no Property areas card and no area box', async () => {
    await openSheet();
    expect(screen.queryByText('Property areas')).toBeNull();
    expect(screen.queryByLabelText('Area treated today (sq ft)')).toBeNull();
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
    await addProductByName('Iron Plus');
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Pick the lawn condition.'));
    expect(completeButton().disabled).toBe(true);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn assessment', 'Products used', 'Lawn condition', 'Customer', 'Treatment zone map']);
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
  test('echoes the context and sends no mowing height (not asked for) or watering token', async () => {
    await openSheet();
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
      customerInteraction: 'tech_home_spoke_with_them',
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

  // Owner 2026-10-04: customer home is the default (replaces 2026-10-01).
  test('Customer is preset to home, spoke with them, sits after the products before the tips, and rides /complete as customerInteraction', async () => {
    await openSheet();
    const chips = within(screen.getByRole('heading', { name: 'Customer' }).closest('section')).getAllByRole('button');
    expect(chips.map((b) => b.textContent)).toEqual(['Home — spoke with them', 'Not home — full access', 'Not home — partial access']);
    expect(screen.getByRole('button', { name: 'Home — spoke with them' }).getAttribute('aria-pressed')).toBe('true');
    await analyzeAndComplete();
    expect(completeCalls()[0].body.customerInteraction).toBe('tech_home_spoke_with_them');
  });

  test('a different customer choice is the one sent', async () => {
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Not home — partial access' }));
    await analyzeAndComplete();
    expect(completeCalls()[0].body.customerInteraction).toBe('not_home_partial_access');
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
    await addProductByName('Talak 7.9%');
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
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn assessment', 'Products used', 'Customer', 'Tip for the customer', 'Treatment zone map']);
    fireEvent.change(await screen.findByLabelText('Search tips'), { target: { value: 'sedge' } });
    expect(screen.queryByRole('button', { name: /Mow high/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Sedge/ }));
    await analyzeAndComplete();
    expect(completeCalls()[0].body.techTips).toEqual({ ids: ['tip-sedge'], custom: null });
  });

  test('a tip the note calls for leads the list, ahead of the library order', async () => {
    tips = lib(['Mow high', 'Dollarweed', 'Chinch bugs']);
    await openSheet();
    const order = () => screen.getAllByRole('button', { name: /^(Mow high|Dollarweed|Chinch bugs)/ }).map((b) => b.textContent.split('Copy')[0].trim());
    expect(order()[0]).toBe('Mow high');
    fireEvent.change(screen.getByLabelText(/tell me about the visit/i), { target: { value: 'Chinch bugs in the trouble spot, treated with Arena.' } });
    expect(order()[0]).toBe('Chinch bugs');
    // Two matches: the tip with more matched keywords leads, not the library's earlier one.
    tips = lib(['Dollarweed', 'Chinch bugs']);
    tips.groups[0].tips[1].keywords.push('side strip');
    cleanup();
    await openSheet();
    fireEvent.change(screen.getByLabelText(/tell me about the visit/i), { target: { value: 'Dollarweed near the lanai. Chinch bugs by the drive, chinch bugs in the side strip.' } });
    expect(order().slice(0, 2)).toEqual(['Chinch bugs', 'Dollarweed']);
  });

  test('no tip library, no section, and techTips is null', async () => {
    await openSheet();
    expect(screen.queryByLabelText('Search tips')).toBeNull();
    await analyzeAndComplete();
    expect(completeCalls()[0].body.techTips).toBeNull();
  });

  test('no "Search tips" label and no "Pick 1 (optional)" hint; the box is reachable by aria-label and one tip still caps at one', async () => {
    tips = lib(['Mow high', 'Sedge']);
    await openSheet();
    const box = await screen.findByLabelText('Search tips');
    expect(box.tagName).toBe('INPUT');
    expect([...document.querySelectorAll('label')].some((l) => l.textContent === 'Search tips')).toBe(false);
    expect(screen.queryByText('Pick 1 (optional)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Mow high/ }));
    fireEvent.click(screen.getByRole('button', { name: /Sedge/ }));
    expect(screen.getByRole('button', { name: /Mow high/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Sedge/ }).getAttribute('aria-pressed')).toBe('true');
    await analyzeAndComplete();
    expect(completeCalls()[0].body.techTips).toEqual({ ids: ['tip-sedge'], custom: null });
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
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tell me about the visit', 'Lawn assessment', 'Products used', 'Customer', 'Tip for the customer', 'Blog post for the customer', 'Treatment zone map']);
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

  test('no "Search the Waves blog" label and no "Pick 1 (optional)" hint; the box is reachable by aria-label', async () => {
    blogAnswer = { available: true, posts: [] };
    await openSheet();
    const box = await screen.findByLabelText('Search the Waves blog');
    expect(box.tagName).toBe('INPUT');
    expect([...document.querySelectorAll('label')].some((l) => l.textContent === 'Search the Waves blog')).toBe(false);
    expect(screen.queryByText('Pick 1 (optional)')).toBeNull();
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
  test('is one closed row after the rest with no "Optional" hint; it never blocks Complete', async () => {
    await openSheet();
    const row = screen.getByRole('region', { name: 'Treatment zone map' });
    expect(within(row).queryByText('Optional')).toBeNull();
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
    // Codex r1: a visit completed elsewhere while the map is open must refuse the save.
    expect(tracer.getAttribute('data-open-only')).toBe('true');
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

describe('the lawn length (the full form\'s optional mowing height box)', () => {
  const lengthCtx = () => makeRequest({ ctx: context({ turfHeightCapture: true }) });

  test('shows only when the server asks for it, in the Lawn assessment section, and is optional: Analyze, Confirm and Complete never wait for it', async () => {
    await openSheet({ request: lengthCtx() });
    expect(screen.getByText('Lawn length')).toBeTruthy();
    // With the shot list it is one more row under the photo slots; without it, the box beside the photo button.
    expect(screen.queryByTestId('lawn-length-row') || screen.getByText('inches')).toBeTruthy();
    expect(screen.getByPlaceholderText('e.g. 4').closest('section').querySelector('h3').textContent).toBe('Lawn assessment');
    await analyzeAndComplete();
    // Left empty: the body carries the key as null, as the full form's does.
    expect(completeCalls()[0].body.manualHeightIn).toBeNull();
  });

  test('a typed length rides /complete as manualHeightIn, and Analyze gets it as turfHeightIn', async () => {
    await openSheet({ request: lengthCtx() });
    fireEvent.change(screen.getByPlaceholderText('e.g. 4'), { target: { value: '3.5' } });
    await analyzeAndComplete();
    expect(requests.find((r) => r.path.endsWith('/lawn-assessment/assess')).body.turfHeightIn).toBe(3.5);
    expect(completeCalls()[0].body.manualHeightIn).toBe(3.5);
  });

  test('the box stays after the read, and a length the server would refuse (outside 0.5 to 8 inches) holds Complete in words', async () => {
    await openSheet({ request: lengthCtx() });
    await analyze();
    fireEvent.change(screen.getByPlaceholderText('e.g. 4'), { target: { value: '12' } });
    await waitFor(() => expect(footerNote()).toBe('Lawn length must be between 0.5 and 8 inches.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('e.g. 4'), { target: { value: '' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
  });
});

describe('the note box', () => {
  test('the mic sits inside the note\'s box, not beside it', async () => {
    await openSheet();
    const note = screen.getByLabelText('Tell me about the visit');
    const row = note.closest('.tech-visit-note-row');
    expect(row.classList.contains('tech-visit-note-row--inside')).toBe(true);
    expect(row.querySelector('.tech-visit-note-mic')).not.toBeNull();
    // The textarea is the row's first child: nothing to its left.
    expect(row.firstElementChild).toBe(note);
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
    await addProductByName('Iron Plus');
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
    expect(screen.queryByRole('heading', { name: 'Lawn assessment' })).toBeNull();
    expect(onFullForm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /full form/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/lawn-fast/context'))).toHaveLength(2));
  });

  test.each(['photo_status', 'turf_height_flag', 'planned_products', 'assessment'])('an advisory %s failure still opens the sheet', async (failure) => {
    await openSheet({ request: makeRequest({ ctx: context({ readFailures: [failure] }) }) });
    expect(screen.getByRole('heading', { name: 'Lawn assessment' })).toBeTruthy();
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
    expect(screen.getByRole('heading', { name: 'Lawn assessment' })).toBeTruthy();
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
    expect(screen.getByText('Assessment confirmed').className).toContain('bg-[#F5F5F5]');
    expect(document.body.innerHTML).not.toMatch(/green|emerald|#16A34A|#10B981|rgba?\(22, 163, 74/i);
  });

  test('the sheet wears the full form\'s page look: the dialog carries the scoped class', async () => {
    await openSheet();
    expect(document.querySelector('section[role="dialog"].tech-lawn-sheet')).not.toBeNull();
    expect(document.querySelector('.tech-visit-footer .tech-visit-complete')).not.toBeNull();
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

// ── the full form's mobile page look: header, Details, customer block ───────
describe('header and customer block, as on the full form\'s Complete service page', () => {
  test('the title is Complete service, with a round Back arrow that closes, and no X', async () => {
    const onClose = vi.fn();
    await openSheet({ props: { onClose } });
    expect(screen.getByRole('heading', { name: 'Complete service' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByText('×')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a Details pill shows only when the parent can open the details, and opens them', async () => {
    await openSheet();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    cleanup();
    const onViewDetails = vi.fn();
    await openSheet({ props: { onViewDetails } });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });

  test('the customer block: the name links to the customer, then directions, call and email links', async () => {
    customerAnswer = { customer: { email: 'pat@example.com' } };
    await openSheet({ props: { service: { ...SERVICE, customerId: 'cust-1', fullAddress: '123 Main St, Bradenton, FL 34205', customerPhone: '+19415550100' } } });
    expect(screen.getByRole('link', { name: 'Pat Jones' }).getAttribute('href')).toBe('/admin/customers?customerId=cust-1');
    const maps = screen.getByRole('link', { name: '123 Main St, Bradenton, FL 34205' });
    expect(maps.getAttribute('href')).toBe('https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St%2C%20Bradenton%2C%20FL%2034205');
    expect(maps.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: '+19415550100' }).getAttribute('href')).toBe('tel:+19415550100');
    expect((await screen.findByRole('link', { name: 'pat@example.com' })).getAttribute('href')).toBe('mailto:pat@example.com');
  });

  test('the bottom pill reads Complete service when ready, and the page\'s own wording while off', async () => {
    await openSheet();
    expect(completeButton().textContent).toBe('Add a photo');
    await analyze();
    await waitFor(() => expect(completeButton().textContent).toBe('Complete service'));
  });
});

// ── Time on-site, as the full form's Complete service page shows it ─────────
describe('time on-site', () => {
  const CHECK_IN = '2026-10-05T13:00:00.000Z';
  afterEach(() => { vi.useRealTimers(); });
  const clock = () => screen.getByLabelText('Time on-site');

  test('shows the elapsed time since check-in as h:mm:ss, and ticks every second', async () => {
    // Real timers stay for the sheet's own waits; only the clock and the tick are faked.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-05T14:19:39.000Z'));
    await openSheet({ props: { service: { ...SERVICE, onSiteAt: CHECK_IN } } });
    expect(within(clock()).getByText('Time on-site')).toBeTruthy();
    expect(within(clock()).getByText('1:19:39')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(within(clock()).getByText('1:19:40')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(within(clock()).getByText('1:20:00')).toBeTruthy();
  });

  test('under an hour it reads m:ss, as the page does', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-05T13:07:05.000Z'));
    await openSheet({ props: { service: { ...SERVICE, onSiteAt: CHECK_IN } } });
    expect(within(clock()).getByText('7:05')).toBeTruthy();
  });

  test('with no check-in time there is no card at all, as on the full form', async () => {
    await openSheet();
    expect(screen.queryByLabelText('Time on-site')).toBeNull();
    expect(screen.queryByText('Time on-site')).toBeNull();
  });

  test('sits after the customer block and before the lawn assessment', async () => {
    await openSheet({ props: { service: { ...SERVICE, onSiteAt: CHECK_IN, customerId: 'cust-1' } } });
    const order = Array.from(document.querySelectorAll('.tech-visit-body .tech-lawn-contact, .tech-visit-body .tech-visit-on-site, .tech-visit-body h3'))
      .filter((el) => !el.closest('.tech-visit-on-site') || el.classList.contains('tech-visit-on-site'))
      .map((el) => (el.classList.contains('tech-lawn-contact') ? 'contact' : el.classList.contains('tech-visit-on-site') ? 'time on-site' : el.textContent));
    expect(order.slice(0, 4)).toEqual(['contact', 'time on-site', 'Tell me about the visit', 'Lawn assessment']);
  });
});

// ── Time on-site: the page's card look (style only; the clock is branch 2's) ─
describe('time on-site card look', () => {
  test('is a card with the small uppercase label over the big digits, scoped to the lawn sheet', async () => {
    await openSheet({ props: { service: { ...SERVICE, onSiteAt: '2026-10-05T13:00:00.000Z' } } });
    const card = screen.getByLabelText('Time on-site');
    expect(card.classList.contains('tech-visit-on-site')).toBe(true);
    expect(card.closest('section[role="dialog"].tech-lawn-sheet')).not.toBeNull();
    expect(card.querySelector('h3.tech-visit-section-title').textContent).toBe('Time on-site');
    expect(card.querySelector('p.tech-visit-on-site-time')).not.toBeNull();
  });

  test('the stylesheet gives it the page\'s values', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tech-workflow.css'), 'utf8');
    const rule = (selector) => css.split('\n').find((line) => line.startsWith(selector)) || '';
    expect(rule('.tech-lawn-sheet .tech-visit-on-site {')).toMatch(/border: 0\.5px solid #e5e5e5; border-radius: 16px; background: #ffffff; padding: 16px|padding: 16px; border: 0\.5px solid #e5e5e5; border-radius: 16px; background: #ffffff/);
    const digits = rule('.tech-lawn-sheet .tech-visit-on-site-time');
    expect(digits).toContain('font-size: 28px');
    expect(digits).toContain('font-weight: 500');
    expect(digits).toContain('line-height: 1.15');
    expect(digits).toContain('tabular-nums');
    expect(rule('.tech-lawn-sheet .tech-visit-section-title')).toMatch(/letter-spacing: 0\.3px; text-transform: uppercase/);
  });
});
