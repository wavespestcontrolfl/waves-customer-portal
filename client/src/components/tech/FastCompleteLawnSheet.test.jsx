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
  { id: P_TALAK, name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC', service_lines: ['lawn', 'pest'] },
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
let guideAnswer;

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
    if (path.includes('/lawn-fast/treatment-guide')) {
      if (guideAnswer instanceof Error) throw guideAnswer;
      return typeof guideAnswer === 'function' ? guideAnswer() : (guideAnswer ?? {});
    }
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
  guideAnswer = null;
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
  test('a visit whose plan offers the bermuda removal mix (the server answers ineligible, bermuda_removal) opens the full form once', async () => {
    const request = makeRequest({ ctx: context({ eligible: false, reason: 'bermuda_removal', needsFullForm: 'Bermuda removal mix this visit: use the full form' }) });
    const onFullForm = vi.fn();
    render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onFullForm={onFullForm} />);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'Lawn assessment' })).toBeNull();
  });

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

  test('a catalog rate unit spelled with a space ("fl oz/1000sf") still figures, and the rate rides the record as fl_oz', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: [{ ...CATALOG[0], default_rate_per_1000: 2, default_unit: 'fl oz/1000sf' }] } });
    await addProductByName('Talak 7.9%');
    expect(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%').value).toBe('10');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 10, amountUnit: 'fl_oz', rate: 2, rateUnit: 'fl_oz' });
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
    // The rate it was figured from is on the record (annual-limit checks sum it), in its base unit.
    expect(sent).toMatchObject({ applicationMethod: 'broadcast_spray', totalAmount: 10, amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft', rate: 2, rateUnit: 'fl_oz' });
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
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 0.004, amountUnit: 'fl_oz', rate: 0.0008, rateUnit: 'fl_oz' });
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

  test('an amount the tech clears stays empty: the figured one does not come back, and the row is recorded without one', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('10');
    fireEvent.change(within(talak).getByLabelText('Talak 7.9%'), { target: { value: '' } });
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('');
    expect(within(talak).queryByText(/per 1,000 sq ft/)).toBeNull();
    expect(within(talak).getByText('No amount entered. It is recorded without one.')).toBeTruthy();
    await analyze();
    await submit();
    const sent = completeCalls()[0].body.products[0];
    expect(sent.totalAmount).toBeUndefined();
    expect(sent.amountUnit).toBeUndefined();
    expect(sent.rate).toBeUndefined();
  });

  test('changing the unit of a figured amount keeps the figure, read in the new unit; a typed number then wins', async () => {
    await openSheet({ request: makeRequest({ ctx: ONE_TIME() }), props: { catalog: RATED } });
    await addProductByName('Talak 7.9%');
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('10');
    fireEvent.change(within(talak).getByLabelText('Unit for Talak 7.9%'), { target: { value: 'tsp' } });
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('60');
    expect(within(talak).getByText('2 fl oz per 1,000 sq ft × 5,000 sq ft')).toBeTruthy();
    fireEvent.change(within(talak).getByLabelText('Unit for Talak 7.9%'), { target: { value: 'gal' } });
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('0.078');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 0.078, amountUnit: 'gal', rate: 2, rateUnit: 'fl_oz' });
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
    const typed = completeCalls()[0].body.products[0];
    expect(typed).toMatchObject({ applicationMethod: 'spot_treatment', totalAmount: 12, amountUnit: 'fl_oz' });
    expect(typed.rate).toBeUndefined();
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

  test('a planned row the plan gave a rate but no quantity for records the rate it was figured from, not the plan\'s', async () => {
    // The plan's rate (1 fl oz) and no amount; the catalog says 2 fl oz per 1,000 on the plan's 6,000 sq ft.
    const ctx = plannedOne('broadcast_spray', { amount: null, treatedSqft: 6000, areaUnit: 'sqft', ratePer1000: 1, rateUnit: 'fl_oz' });
    await openSheet({ request: makeRequest({ ctx }), props: { catalog: RATED } });
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('12');
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ totalAmount: 12, amountUnit: 'fl_oz', rate: 2, rateUnit: 'fl_oz', areaValue: 6000 });
  });

  test('a planned row with no plan quantity moved to spot treatment figures nothing from the plan\'s area', async () => {
    const ctx = plannedOne('broadcast_spray', { amount: null, treatedSqft: 6000, areaUnit: 'sqft', ratePer1000: 1, rateUnit: 'fl_oz' });
    await openSheet({ request: makeRequest({ ctx }), props: { catalog: RATED } });
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('12');
    pickMethod(talak, 'Spot treatment');
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('');
    expect(within(talak).queryByText(/per 1,000 sq ft/)).toBeNull();
    await analyze();
    await submit();
    const sent = completeCalls()[0].body.products[0];
    expect(sent).toMatchObject({ applicationMethod: 'spot_treatment' });
    expect(sent.totalAmount).toBeUndefined();
    expect(sent.rate).toBeUndefined();
  });

  test('a planned spot row moved to a broadcast goes down on the whole lawn, not the plan\'s spot area', async () => {
    const ctx = plannedOne('spot_treatment', { amount: null, treatedSqft: 1500, areaUnit: 'sqft' });
    await openSheet({ request: makeRequest({ ctx }), props: { catalog: RATED } });
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByText('2 fl oz per 1,000 sq ft × 1,500 sq ft')).toBeTruthy();
    pickMethod(talak, 'Broadcast spray');
    // 2 fl oz per 1,000 on the 5,000 sq ft lawn.
    expect(within(talak).getByLabelText('Talak 7.9%').value).toBe('10');
    expect(within(talak).getByText('2 fl oz per 1,000 sq ft × 5,000 sq ft')).toBeTruthy();
    await analyze();
    await submit();
    expect(completeCalls()[0].body.products[0]).toMatchObject({ applicationMethod: 'broadcast_spray', totalAmount: 10, areaValue: 5000, areaUnit: 'sqft' });
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

  test('a planned row moved off the plan\'s method sends no rate', async () => {
    await run(planned(), () => pickMethod(editorFor('Talak 7.9%'), 'Spot treatment'));
    noRateKeys();
  });

  test('a planned row moved off the plan\'s method and back sends the plan rate again', async () => {
    await run(planned(), () => {
      pickMethod(editorFor('Talak 7.9%'), 'Spot treatment');
      pickMethod(editorFor('Talak 7.9%'), 'Broadcast spray');
    });
    expect(sentRow()).toMatchObject({ applicationMethod: 'broadcast_spray', rate: 1.07, rateUnit: 'fl_oz', totalAmount: 2, amountUnit: 'fl_oz' });
  });

  test.each([
    ['the amount', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Talak 7.9%'), { target: { value: '3' } })],
    ['the amount unit', () => fireEvent.change(within(editorFor('Talak 7.9%')).getByLabelText('Unit for Talak 7.9%'), { target: { value: 'gal' } })],
  ])('a change to %s sends no rate keys', async (_label, change) => {
    await run(planned(), change);
    noRateKeys();
  });

  test.each([['fl oz', 'fl_oz'], ['Fl Oz', 'fl_oz'], ['oz/1000sf', 'oz/1000sf']])('a plan rate in %s is sent in the record\'s spelling, %s', async (rateUnit, sent) => {
    await run(planned({ rateUnit }));
    expect(completeCalls()[0].body.products[0]).toMatchObject({ rate: 1.07, rateUnit: sent });
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
    // The phone is the Waves call bridge, not a tel: link (owner 2026-10-06).
    expect(screen.queryByRole('link', { name: '+19415550100' })).toBeNull();
    const call = screen.getByRole('button', { name: 'Call Pat Jones' });
    expect(call.textContent).toBe('+19415550100');
    // No inline font/color: the contact block's CSS sizes it like the other links.
    expect(call.getAttribute('style') || '').not.toMatch(/font|color/);
    expect((await screen.findByRole('link', { name: 'pat@example.com' })).getAttribute('href')).toBe('mailto:pat@example.com');
  });

  test('tapping the phone asks Waves to ring the caller first, never dials from the handset', async () => {
    await openSheet({ props: { service: { ...SERVICE, customerId: 'cust-1', customerPhone: '+19415550100' } } });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Call Pat Jones' }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/\/admin\/communications\/call$/);
      expect(JSON.parse(init.body)).toMatchObject({ to: '+19415550100', customerIdHint: 'cust-1' });
      expect(confirmSpy.mock.calls[0][0]).toMatch(/Waves will call your phone first/);
    } finally {
      confirmSpy.mockRestore();
      fetchSpy.mockRestore();
    }
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

describe('"Also in this month\'s protocol": the plan\'s opt-in products', () => {
  const ADD_ONS = [
    {
      productId: P_GRANULE, name: 'Green Granules', applicationMethod: 'granular_broadcast', amount: 20, amountUnit: 'lb', treatedSqft: 5000, areaUnit: 'sqft',
      ratePer1000: 4, rateUnit: 'lb', line: 'If thin turf: Green Granules', substituteFor: 'Old Feed', gateNotes: ['Granular product: apply on a spreader visit, not from the hose pass.'],
      approvedForReport: true, wateringRule: null, wateringSummary: 'Water in', mowHoldDays: null,
    },
    // On the sheet already (a planned row): read as such.
    { productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'spot_treatment', amount: null, amountUnit: 'fl_oz', line: null, substituteFor: null, gateNotes: [] },
    // Not in the sheet's catalog (inactive): cannot be built into a row, so not offered.
    { productId: 'aaaaaaaa-0000-4000-8000-000000000099', name: 'Ghost', applicationMethod: 'spot_treatment', amount: null, amountUnit: 'oz', line: null, substituteFor: null, gateNotes: [] },
  ];
  const withAddOns = () => context({ plannedProducts: { source: 'plan', items: [PLANNED[0]], addOns: ADD_ONS, month: 10 } });
  const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });

  test('each offered product reads the plan\'s own words: substitute, protocol line, gate notes, method and rate', async () => {
    await openSheet({ request: makeRequest({ ctx: withAddOns() }) });
    const row = addons();
    expect(within(row).getByText('In place of Old Feed · If thin turf: Green Granules · Granular product: apply on a spreader visit, not from the hose pass. · Granular broadcast · 4 lb per 1,000 sq ft')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Talak 7.9% is on the sheet' }).disabled).toBe(true);
    expect(within(row).queryByText('Ghost')).toBeNull();
  });

  test('a tapped add-on opens with the plan\'s amount and method, marked from the protocol, sends the plan rate, and is never a skipped plan product', async () => {
    await openSheet({ request: makeRequest({ ctx: withAddOns() }) });
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add Green Granules' }));
    const granules = editorFor('Green Granules');
    expect(within(granules).getByText(/from the protocol/)).toBeTruthy();
    expect(pressedMethod(granules)).toBe('Granular broadcast');
    expect(within(granules).getByLabelText('Green Granules').value).toBe('20');
    expect(within(addons()).getByRole('button', { name: 'Green Granules is on the sheet' }).disabled).toBe(true);
    await analyze();
    await submit();
    const body = completeCalls()[0].body;
    expect(body.products.find((p) => p.productId === P_GRANULE)).toMatchObject({ applicationMethod: 'granular_broadcast', totalAmount: 20, amountUnit: 'lb', rate: 4, rateUnit: 'lb', areaValue: 5000 });
    expect(body.lawnProtocolCompletion).toBeUndefined();
  });

  test('no add-ons, no row', async () => {
    await openSheet();
    expect(screen.queryByRole('group', { name: /protocol$/ })).toBeNull();
  });
});

// ── weed spots and the spot area (GATE_LAWN_SPOT_RULES, owner 2026-10-08) ──────────
// The server decides the weed entry (the cap, the surfactant by temperature) and sends
// `spotRules` and `plannedProducts.weedMix`; the sheet only renders and enforces what it
// is given. With neither field it renders exactly as before.
describe('weed spots and the spot area', () => {
  const P_LEAD = 'bbbbbbbb-0000-4000-8000-000000000001';
  const P_CERT = 'bbbbbbbb-0000-4000-8000-000000000002';
  const P_SURF = 'bbbbbbbb-0000-4000-8000-000000000003';
  const P_BLIND = 'bbbbbbbb-0000-4000-8000-000000000004';
  const WEED_CATALOG = [
    { id: P_LEAD, name: 'Lead WG', category: 'herbicide', formulation: 'WG', default_rate_per_1000: 2, default_unit: 'oz' },
    { id: P_CERT, name: 'Cert Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
    // The surfactant is a percent of the tank: the catalog may carry a rate, but it figures nothing.
    { id: P_SURF, name: 'Tank Surfactant', category: 'adjuvant', formulation: 'SL', default_rate_per_1000: 1, default_unit: 'fl_oz' },
    { id: P_BLIND, name: 'Blind Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 1, default_unit: 'fl_oz' },
    ...CATALOG,
  ];
  const addOn = (productId, name) => ({ productId, name, applicationMethod: 'spot_treatment', amount: null, amountUnit: 'oz', line: null, substituteFor: null, gateNotes: [] });
  const ADD_ONS = [addOn(P_LEAD, 'Lead WG'), addOn(P_CERT, 'Cert Herbicide'), addOn(P_SURF, 'Tank Surfactant'), addOn(P_BLIND, 'Blind Herbicide')];
  const MIX = (overrides = {}) => ({
    mode: 'lead',
    productIds: [P_LEAD, P_CERT, P_SURF],
    groupProductIds: [P_LEAD, P_CERT, P_SURF, P_BLIND],
    replacementProductId: P_BLIND,
    note: null,
    surfactant: { productId: P_SURF, included: true, note: null },
    noAreaProductIds: [P_SURF],
    tempF: 82,
    ...overrides,
  });
  const weedContext = (mix = MIX(), extra = {}) => context({
    spotRules: true,
    plannedProducts: { source: 'plan', items: [PLANNED[0]], addOns: ADD_ONS, month: 10, weedMix: mix },
    ...extra,
  });
  const open = (ctx = weedContext()) => openSheet({ request: makeRequest({ ctx }), props: { catalog: WEED_CATALOG } });
  const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });
  const addWeedSpots = () => fireEvent.click(within(addons()).getByRole('button', { name: 'Add weed spots' }));
  const weedArea = () => screen.getByRole('group', { name: 'Weed spots' });
  const sentProduct = (id) => completeCalls()[0].body.products.find((p) => p.productId === id);

  test('one entry stands for the weed products, and one tap opens the lead and its members (not the replacement)', async () => {
    await open();
    const list = addons();
    expect(within(list).getByText('Weed spots')).toBeTruthy();
    expect(within(list).getByText('Lead WG, Cert Herbicide, Tank Surfactant')).toBeTruthy();
    // None of the group is listed on its own.
    for (const name of ['Lead WG', 'Cert Herbicide', 'Tank Surfactant', 'Blind Herbicide']) {
      expect(within(list).queryByRole('button', { name: `Add ${name}` })).toBeNull();
    }
    addWeedSpots();
    for (const name of ['Lead WG', 'Cert Herbicide', 'Tank Surfactant']) expect(within(editorFor(name)).getByText(/from the protocol/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Blind Herbicide' })).toBeNull();
    expect(within(addons()).getByRole('button', { name: 'Weed spots are on the sheet' }).disabled).toBe(true);
  });

  test('the surfactant left out by heat is not added, and the entry says so', async () => {
    await open(weedContext(MIX({
      productIds: [P_LEAD, P_CERT], note: 'Surfactant left out: it is 90°F or hotter.',
      surfactant: { productId: P_SURF, included: false, note: 'Surfactant left out: it is 90°F or hotter.' }, tempF: 93,
    })));
    expect(within(addons()).getByText('Lead WG, Cert Herbicide · Surfactant left out: it is 90°F or hotter.')).toBeTruthy();
    addWeedSpots();
    expect(screen.getByRole('group', { name: 'Lead WG' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Tank Surfactant' })).toBeNull();
    // The reason stays on the entry after the tap: the left-out surfactant has no row to say it.
    expect(within(addons()).getByText('On the sheet · Surfactant left out: it is 90°F or hotter.')).toBeTruthy();
  });

  test('no product of the weed group is listed in the search: offered or held back, it comes through the entry only', async () => {
    await open(weedContext(MIX({
      productIds: [P_LEAD, P_CERT], note: 'Surfactant left out: it is 90°F or hotter.',
      surfactant: { productId: P_SURF, included: false, note: 'Surfactant left out: it is 90°F or hotter.' }, tempF: 93,
    })));
    const search = await screen.findByLabelText('Search products');
    for (const name of ['Lead WG', 'Tank Surfactant', 'Blind Herbicide']) {
      fireEvent.change(search, { target: { value: name } });
      expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).toBeNull();
    }
  });

  test('when the limits could not be read the search lists the weed products again', async () => {
    await open(weedContext(MIX({ mode: 'unavailable', productIds: [], surfactant: null, note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.' })));
    fireEvent.change(await screen.findByLabelText('Search products'), { target: { value: 'Lead WG' } });
    expect(await screen.findByRole('button', { name: /Lead WG/ })).toBeTruthy();
  });

  test('an unknown temperature adds the surfactant with the reminder on its row', async () => {
    const note = 'Leave the surfactant out if it is 90°F or hotter.';
    await open(weedContext(MIX({ note, surfactant: { productId: P_SURF, included: true, note }, tempF: null })));
    expect(within(addons()).getByText(`Lead WG, Cert Herbicide, Tank Surfactant · ${note}`)).toBeTruthy();
    addWeedSpots();
    expect(within(editorFor('Tank Surfactant')).getByText(note)).toBeTruthy();
    expect(within(editorFor('Lead WG')).queryByText(note)).toBeNull();
  });

  test('lead at its yearly limit: the entry adds the replacement alone and says why', async () => {
    await open(weedContext(MIX({
      mode: 'replacement', productIds: [P_BLIND], surfactant: null, tempF: null, note: 'Celsius yearly limit reached; Blindside is used in its place.',
    })));
    expect(within(addons()).getByText('Blind Herbicide · Celsius yearly limit reached; Blindside is used in its place.')).toBeTruthy();
    addWeedSpots();
    expect(screen.getByRole('group', { name: 'Blind Herbicide' })).toBeTruthy();
    for (const name of ['Lead WG', 'Cert Herbicide', 'Tank Surfactant']) expect(screen.queryByRole('group', { name })).toBeNull();
  });

  test('both at their yearly limit: no entry to tap, one line, and the products are not listed on their own', async () => {
    await open(weedContext(MIX({ mode: 'none', productIds: [], surfactant: null, tempF: null, note: 'The yearly weed-spray limit is reached for this lawn.' })));
    expect(within(addons()).getByText('The yearly weed-spray limit is reached for this lawn.')).toBeTruthy();
    expect(within(addons()).queryByRole('button')).toBeNull();
    expect(within(addons()).queryByText('Lead WG')).toBeNull();
  });

  test('quick sizes figure each row\'s amount from its rate; the surfactant figures nothing; one area control serves the whole entry', async () => {
    await open();
    addWeedSpots();
    // One control for the three rows, not one each.
    expect(screen.getAllByLabelText('Area treated (sq ft)')).toHaveLength(1);
    fireEvent.click(within(weedArea()).getByRole('button', { name: '500 sq ft' }));
    expect(within(weedArea()).getByRole('button', { name: '500 sq ft' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(editorFor('Lead WG')).getByLabelText('Lead WG').value).toBe('1');
    expect(within(editorFor('Lead WG')).getByText('2 oz per 1,000 sq ft × 500 sq ft')).toBeTruthy();
    // A small liquid dose reads in spoons, as every figured amount does: 0.25 fl oz is 1.5 tsp.
    expect(within(editorFor('Cert Herbicide')).getByLabelText('Cert Herbicide').value).toBe('1.5');
    expect(within(editorFor('Tank Surfactant')).getByLabelText('Tank Surfactant').value).toBe('');
    // A typed number replaces the quick size for every row at once.
    fireEvent.change(within(weedArea()).getByLabelText('Area treated (sq ft)'), { target: { value: '1000' } });
    expect(within(editorFor('Lead WG')).getByLabelText('Lead WG').value).toBe('2');
    expect(within(editorFor('Cert Herbicide')).getByLabelText('Cert Herbicide').value).toBe('3');
  });

  describe('the amount is figured from the program\'s rate, not the catalog default', () => {
    const withLeadRate = (rate) => weedContext(MIX(), {
      plannedProducts: {
        source: 'plan', items: [PLANNED[0]], month: 10, weedMix: MIX(),
        addOns: ADD_ONS.map((a) => (a.productId === P_LEAD ? { ...a, ...rate } : a)),
      },
    });
    test('the protocol row\'s rate wins over a different catalog rate, and is the rate on the record', async () => {
      // The catalog says 2 oz per 1,000; the program approved 0.5.
      await open(withLeadRate({ ratePer1000: 0.5, rateUnit: 'oz' }));
      expect(within(addons()).getByText(/Lead WG/)).toBeTruthy();
      addWeedSpots();
      fireEvent.click(within(weedArea()).getByRole('button', { name: '500 sq ft' }));
      expect(within(editorFor('Lead WG')).getByLabelText('Lead WG').value).toBe('0.25');
      expect(within(editorFor('Lead WG')).getByText('0.5 oz per 1,000 sq ft × 500 sq ft')).toBeTruthy();
      await analyze();
      await submit();
      expect(sentProduct(P_LEAD)).toMatchObject({ totalAmount: 0.25, amountUnit: 'oz', rate: 0.5, rateUnit: 'oz' });
      // A member whose row has no rate still falls back to the catalog's.
      expect(sentProduct(P_CERT)).toMatchObject({ totalAmount: 0.25, rate: 0.5, rateUnit: 'fl_oz' });
    });
    test('a small spot keeps a small dry dose: three decimals, never rounded to nothing', async () => {
      // 0.028 oz per 1,000 sq ft on 100 sq ft is 0.0028 oz: two decimals would record 0.
      await open(withLeadRate({ ratePer1000: 0.028, rateUnit: 'oz' }));
      addWeedSpots();
      fireEvent.click(within(weedArea()).getByRole('button', { name: '100 sq ft' }));
      expect(within(editorFor('Lead WG')).getByLabelText('Lead WG').value).toBe('0.003');
      await analyze();
      await submit();
      expect(sentProduct(P_LEAD)).toMatchObject({ totalAmount: 0.003, amountUnit: 'oz', rate: 0.028, rateUnit: 'oz' });
    });
    test('a weed row added on its own is figured the same way', async () => {
      await open(weedContext(MIX({ mode: 'none', productIds: [], groupProductIds: [] }), {
        plannedProducts: { source: 'plan', items: [PLANNED[0]], month: 10, weedMix: MIX({ mode: 'none', productIds: [], groupProductIds: [], surfactant: null }), addOns: [{ ...addOn(P_LEAD, 'Lead WG'), ratePer1000: 0.5, rateUnit: 'oz' }] },
      }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Lead WG' }));
      const lead = editorFor('Lead WG');
      fireEvent.click(within(lead).getByRole('button', { name: '1,000 sq ft' }));
      expect(within(lead).getByLabelText('Lead WG').value).toBe('0.5');
    });
    test('a unit the row\'s amount cannot express figures nothing (no fallback to the catalog)', async () => {
      await open(withLeadRate({ ratePer1000: 3, rateUnit: 'gal' }));
      addWeedSpots();
      fireEvent.click(within(weedArea()).getByRole('button', { name: '500 sq ft' }));
      expect(within(editorFor('Lead WG')).getByLabelText('Lead WG').value).toBe('');
      expect(within(editorFor('Lead WG')).queryByText(/per 1,000 sq ft ×/)).toBeNull();
      // The area is still on the row, so Complete is not held for it.
      await analyze();
      await submit();
      expect(sentProduct(P_LEAD)).toMatchObject({ areaValue: 500, areaUnit: 'sqft' });
      expect(sentProduct(P_LEAD).totalAmount).toBeUndefined();
    });
    test('a row with no program rate falls back to the catalog\'s', async () => {
      await open();
      addWeedSpots();
      fireEvent.click(within(weedArea()).getByRole('button', { name: '500 sq ft' }));
      expect(within(editorFor('Lead WG')).getByText('2 oz per 1,000 sq ft × 500 sq ft')).toBeTruthy();
    });
  });

  test('the quick sizes are 100, 250, 500 and 1,000 sq ft', async () => {
    await open();
    addWeedSpots();
    expect(within(weedArea()).getAllByRole('button').map((b) => b.textContent)).toEqual(['100 sq ft', '250 sq ft', '500 sq ft', '1,000 sq ft']);
  });

  test('Complete waits for the area: the plain message names the product; the surfactant is exempt', async () => {
    await open();
    addWeedSpots();
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Enter the area treated for Lead WG.'));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(weedArea()).getByRole('button', { name: '250 sq ft' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    // The area rides every row of the entry, in square feet; the figured amount and its rate ride the record.
    expect(sentProduct(P_LEAD)).toMatchObject({ applicationMethod: 'spot_treatment', areaValue: 250, areaUnit: 'sqft', totalAmount: 0.5, amountUnit: 'oz', rate: 2, rateUnit: 'oz' });
    expect(sentProduct(P_CERT)).toMatchObject({ areaValue: 250, areaUnit: 'sqft' });
    expect(sentProduct(P_SURF)).toMatchObject({ areaValue: 250, areaUnit: 'sqft' });
    expect(sentProduct(P_SURF).totalAmount).toBeUndefined();
  });

  test('a planned spot row never carries the plan\'s estimated quantity: no box value, and Complete waits for the area', async () => {
    // The plan sized this spot from its own estimate of the area (9 fl oz on 1,500 sq ft).
    const planned = { ...PLANNED[1], amount: 9, amountUnit: 'fl_oz', treatedSqft: 1500, areaUnit: 'sqft' };
    await open(weedContext(MIX({ mode: 'none', productIds: [], note: null, surfactant: null }), { plannedProducts: { source: 'plan', items: [planned], addOns: [], month: 10 } }));
    expect(within(editorFor('Iron Plus')).getByLabelText('Iron Plus').value).toBe('');
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Enter the area treated for Iron Plus.'));
  });

  test('a typed amount stands in for the area on a spot row', async () => {
    await open(weedContext(MIX({ mode: 'none', productIds: [], note: null, surfactant: null }), { plannedProducts: { source: 'plan', items: [{ ...PLANNED[1], amount: null }], addOns: [], month: 10 } }));
    await analyze();
    await waitFor(() => expect(footerNote()).toBe('Enter the area treated for Iron Plus.'));
    // Its own control, since it is not a weed-mix row.
    fireEvent.change(within(editorFor('Iron Plus')).getByLabelText('Iron Plus'), { target: { value: '3' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sentProduct(P_IRON)).toMatchObject({ applicationMethod: 'spot_treatment', totalAmount: 3 });
    expect(sentProduct(P_IRON).areaValue).toBeUndefined();
  });

  test('a spot row that is not in the weed entry has its own area control, which figures only that row', async () => {
    await open(weedContext(MIX({ mode: 'none', productIds: [], note: null, surfactant: null }), { plannedProducts: { source: 'plan', items: [{ ...PLANNED[1], amount: null }], addOns: [], month: 10 } }));
    const iron = editorFor('Iron Plus');
    fireEvent.click(within(iron).getByRole('button', { name: '100 sq ft' }));
    expect(within(iron).getByText('Spot area, 100 sq ft')).toBeTruthy();
    await analyze();
    await submit();
    expect(sentProduct(P_IRON)).toMatchObject({ areaValue: 100, areaUnit: 'sqft' });
  });

  test('a whole-lawn row has no area box and is unchanged', async () => {
    await open(weedContext(MIX({ mode: 'none', productIds: [], note: null, surfactant: null })));
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).queryByLabelText('Area treated (sq ft)')).toBeNull();
    await analyze();
    await submit();
    expect(sentProduct(P_TALAK)).toMatchObject({ applicationMethod: 'broadcast_spray', areaValue: 6000, areaUnit: 'sqft' });
  });

  test('with no new context fields the sheet is exactly as before: a spot row asks for no area and does not hold Complete', async () => {
    await openSheet();
    expect(screen.queryByLabelText('Area treated (sq ft)')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Weed spots' })).toBeNull();
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sentProduct(P_IRON).areaValue).toBeUndefined();
    expect(sentProduct(P_IRON).areaUnit).toBeUndefined();
  });

  test('a weed mix without the spotRules flag is ignored: the add-ons list as before', async () => {
    await open(weedContext(MIX(), { spotRules: false }));
    expect(within(addons()).queryByText('Weed spots')).toBeNull();
    expect(within(addons()).getByRole('button', { name: 'Add Lead WG' })).toBeTruthy();
  });
});


// ── Suggested from this lawn (GATE_LAWN_TREATMENT_GUIDE, owner 2026-10-08) ──────────────
// The server decides every card (rules, products, caps); the sheet asks once the assessment is
// confirmed, renders the cards between the plan's rows and the protocol add-ons, performs their
// taps and reports what the tech did on /complete. With no `treatmentGuide` flag it is exactly as before.
describe('suggested from this lawn', () => {
  const P_LEAD = 'cccccccc-0000-4000-8000-000000000001';
  const P_CERT = 'cccccccc-0000-4000-8000-000000000002';
  const P_ART = 'cccccccc-0000-4000-8000-000000000003';
  const P_VEL = 'cccccccc-0000-4000-8000-000000000004';
  const P_ARENA = 'cccccccc-0000-4000-8000-000000000005';
  const P_BIF = 'cccccccc-0000-4000-8000-000000000006';
  const P_ACE = 'cccccccc-0000-4000-8000-000000000007';
  const P_DISP = 'cccccccc-0000-4000-8000-000000000008';
  const GUIDE_CATALOG = [
    { id: P_LEAD, name: 'Lead WG', category: 'herbicide', formulation: 'WG', default_rate_per_1000: 2, default_unit: 'oz' },
    { id: P_CERT, name: 'Cert Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
    { id: P_ART, name: 'Art Fungicide', category: 'fungicide', formulation: 'SC', default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
    { id: P_VEL, name: 'Vel Fungicide', category: 'fungicide', formulation: 'SC', default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
    { id: P_ACE, name: 'Ace Insecticide', category: 'insecticide', formulation: 'SC', default_rate_per_1000: 0.07, default_unit: 'fl_oz' },
    { id: P_DISP, name: 'Disp Wetting Agent', category: 'adjuvant', formulation: 'SL', default_rate_per_1000: 1, default_unit: 'fl_oz' },
    { id: P_ARENA, name: 'Arena 50 WDG', category: 'insecticide', formulation: 'WDG', service_lines: ['lawn', 'pest'], default_rate_per_1000: 0.29, default_unit: 'oz' },
    { id: P_BIF, name: 'Atticus Talak 7.9 F', category: 'insecticide', formulation: 'SC', service_lines: ['lawn', 'pest'], default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
    ...CATALOG,
  ];
  const addOn = (productId, name, line = null) => ({ productId, name, applicationMethod: 'spot_treatment', amount: null, amountUnit: 'oz', line, substituteFor: null, gateNotes: [] });
  const ADD_ONS = [
    addOn(P_LEAD, 'Lead WG'), addOn(P_CERT, 'Cert Herbicide'), addOn(P_ART, 'Art Fungicide', 'Art Fungicide — mapped large patch'),
    addOn(P_VEL, 'Vel Fungicide', 'Vel Fungicide — large patch, next application'), addOn(P_ACE, 'Ace Insecticide', 'Ace Insecticide — caterpillars'), addOn(P_DISP, 'Disp Wetting Agent'),
  ];
  const WEED_MIX = { mode: 'lead', productIds: [P_LEAD, P_CERT], groupProductIds: [P_LEAD, P_CERT], replacementProductId: null, note: null, surfactant: null, noAreaProductIds: [], tempF: 82 };
  // Arena is not in the month's add-ons: the server builds its item from the program's staged row.
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, treatedSqft: null, areaUnit: null, ratePer1000: null, rateUnit: null, line: null, substituteFor: null, gateNotes: [] };
  const BIF_ITEM = { ...ARENA_ITEM, productId: P_BIF, name: 'Atticus Talak 7.9 F' };
  const card = (kind, extra = {}) => ({
    kind, title: kind, finding: `Finding for ${kind}.`, check: null, detail: null, note: null, productIds: [], items: [], actionLabel: 'Add it', dismissLabel: null, ...extra,
  });
  const CARDS = {
    weeds: () => card('weeds', { title: 'Weed spots', finding: 'Photos show weeds on about 18% of the lawn.', detail: 'Lead WG, Cert Herbicide', productIds: [P_LEAD, P_CERT], items: [ADD_ONS[0], ADD_ONS[1]], actionLabel: 'Add weed spots' }),
    fungus: () => card('fungus', {
      title: 'Fungus', finding: 'Photos show minor fungus activity.', check: 'Check first: look at the blades and the edge of the patch.',
      detail: 'Art Fungicide — mapped large patch', productIds: [P_ART], items: [ADD_ONS[2]], actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found',
    }),
    chinch: (item = ARENA_ITEM, note = null) => card('chinch', {
      title: 'Insects: check for chinch bugs', finding: 'Photos show moderate insect damage.', check: 'Check first: part the grass at the sunny edge of the damaged patch. Do a float test only if you are unsure.',
      detail: `Chinch bugs at the edge of the damage: ${item.name}, spot treatment.`, note, productIds: [item.productId], items: [item], actionLabel: 'Found at the edge. Add it', dismissLabel: 'Nothing found',
    }),
    takeAll: () => card('fungus', {
      title: 'Fungus', finding: 'Photos show moderate fungus activity.', check: 'Check first: look at the blades and the edge of the patch.',
      note: 'Take-all is treated on known trouble areas only. None is on file for this lawn.', heldProductIds: [P_ART], actionLabel: null,
    }),
    caterpillars: () => card('caterpillars', {
      title: 'Insects: check for caterpillars', finding: 'Photos show moderate insect damage.', check: 'Check first: soap flush to bring them to the surface.',
      detail: 'Ace Insecticide — caterpillars', productIds: [P_ACE], items: [ADD_ONS[4]], actionLabel: 'Found them. Add it', dismissLabel: 'Nothing found',
    }),
    dry_spots: () => card('dry_spots', { title: 'Dry spots', finding: 'Photos show minor drought stress.', productIds: [P_DISP], items: [ADD_ONS[5]], actionLabel: 'Add Disp Wetting Agent' }),
  };
  const RUNGS = [P_ARENA, P_BIF];
  const guideContext = (extra = {}, chinch = { item: ARENA_ITEM, note: null, rungIds: RUNGS }) => context({
    spotRules: true,
    treatmentGuide: true,
    plannedProducts: { source: 'plan', items: [PLANNED[0]], addOns: ADD_ONS, month: 7, weedMix: WEED_MIX, guidedProductIds: [P_ART, P_ACE, P_DISP], ...(chinch ? { chinch } : {}) },
    ...extra,
  });
  // The guide answers the Weed spots decision it read fresh, with the cards.
  const answer = (cards, weedMix = WEED_MIX, extra = {}) => { guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards, weedMix, ...extra }; };
  const open = (ctx = guideContext()) => openSheet({ request: makeRequest({ ctx }), props: { catalog: GUIDE_CATALOG } });
  const guideCalls = () => requests.filter((r) => r.path.includes('/lawn-fast/treatment-guide'));
  const suggested = () => screen.findByRole('group', { name: 'Suggested from this lawn' });
  const addons = () => screen.getByRole('group', { name: 'Also in July’s protocol' });
  const cardGroup = (title) => screen.getByRole('group', { name: `${title} suggestion` });
  const sentProduct = (id) => completeCalls()[0].body.products.find((p) => p.productId === id);
  const sentGuide = () => completeCalls()[0].body.lawnFast.treatmentGuide;

  test('no treatmentGuide flag: nothing is asked, nothing shows, and the submit carries no record', async () => {
    answer([CARDS.fungus()]);
    await open(guideContext({ treatmentGuide: false }, null));
    await analyzeAndComplete();
    expect(guideCalls()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
    expect(completeCalls()[0].body.lawnFast).toEqual({ visitType: 'recurring' });
  });

  test('nothing is asked until the assessment is confirmed; then the cards sit between the plan rows and the add-ons', async () => {
    answer([CARDS.fungus(), CARDS.caterpillars()]);
    await open();
    expect(guideCalls()).toHaveLength(0);
    await analyzeOnly();
    expect(guideCalls()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
    await confirm();
    const group = await suggested();
    expect(guideCalls()).toHaveLength(1);
    expect(guideCalls()[0].path).toBe('/admin/dispatch/svc-lawn/lawn-fast/treatment-guide?assessmentId=assessment-1');
    expect(within(group).getByText('Photos show minor fungus activity.')).toBeTruthy();
    expect(within(group).getByText('Check first: look at the blades and the edge of the patch.')).toBeTruthy();
    expect(within(group).getByText('Art Fungicide — mapped large patch')).toBeTruthy();
    expect(within(group).getByText('Check first: soap flush to bring them to the surface.')).toBeTruthy();
    // Document order: the plan's rows, then the guide, then the protocol add-ons.
    const plannedRow = screen.getByRole('group', { name: 'Talak 7.9%' });
    expect(plannedRow.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(addons()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a confirmed lawn with no findings says so in one line', async () => {
    answer([]);
    await open();
    await analyze();
    const group = await suggested();
    expect(within(group).getByText('Nothing extra suggested from the photos.')).toBeTruthy();
    expect(within(group).queryByRole('button')).toBeNull();
  });

  test('a guide that cannot be read leaves the sheet as it was', async () => {
    guideAnswer = refusal(500, 'boom', 'Internal error');
    await open();
    await analyze();
    await waitFor(() => expect(guideCalls()).toHaveLength(1));
    expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnFast).toEqual({ visitType: 'recurring' });
  });

  test('the weed card taps the Weed spots entry; the add-ons list does not show it a second time', async () => {
    answer([CARDS.weeds()]);
    await open();
    // Before confirm the add-ons list carries the entry, as before.
    expect(within(addons()).getByText('Weed spots')).toBeTruthy();
    await analyze();
    const group = await suggested();
    expect(within(addons()).queryByText('Weed spots')).toBeNull();
    expect(within(addons()).queryByRole('button', { name: 'Add weed spots' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
    for (const name of ['Lead WG', 'Cert Herbicide']) expect(within(editorFor(name)).getByText(/from the protocol/)).toBeTruthy();
    expect(within(group).getByText('On the sheet')).toBeTruthy();
    // The shared area control comes with the rows, as from the entry.
    expect(screen.getByRole('group', { name: 'Weed spots' })).toBeTruthy();
  });

  test('the fungus card: "I checked. Add it" opens the first fungicide as a spot row; the other fungicide stays in the list', async () => {
    answer([CARDS.fungus()]);
    await open();
    await analyze();
    const group = await suggested();
    fireEvent.click(within(group).getByRole('button', { name: 'I checked. Add it' }));
    expect(within(editorFor('Art Fungicide')).getByText(/from the protocol/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Vel Fungicide' })).toBeNull();
    expect(within(addons()).getByRole('button', { name: 'Add Vel Fungicide' })).toBeTruthy();
    expect(within(cardGroup('Fungus')).getByRole('button', { name: 'Fungus: on the sheet' }).disabled).toBe(true);
    expect(within(cardGroup('Fungus')).queryByRole('button', { name: 'Nothing found' })).toBeNull();
  });

  test('a take-all fungus card is the check only: no product, no add button, recorded as shown and not taken', async () => {
    answer([CARDS.takeAll()]);
    await open();
    await analyze();
    const group = await suggested();
    const fungus = cardGroup('Fungus');
    expect(within(fungus).getByText('Check first: look at the blades and the edge of the patch.')).toBeTruthy();
    expect(within(fungus).getByText('Take-all is treated on known trouble areas only. None is on file for this lawn.')).toBeTruthy();
    expect(within(group).queryByRole('button')).toBeNull();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sentGuide().cards).toEqual([{ kind: 'fungus', shown: true, checked: null, taken: false, productIds: [] }]);
  });

  test('the chinch card adds Arena even though the month\'s plan does not hold it', async () => {
    answer([CARDS.chinch()]);
    await open();
    await analyze();
    const group = await suggested();
    expect(within(group).getByText('Chinch bugs at the edge of the damage: Arena 50 WDG, spot treatment.')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Found at the edge. Add it' }));
    const arena = editorFor('Arena 50 WDG');
    expect(within(arena).getByText(/from the protocol/)).toBeTruthy();
    expect(pressedMethod(arena)).toBe('Spot treatment');
  });

  test('the chinch fallback names why the bifenthrin product is offered, and adds that product', async () => {
    const note = 'Arena yearly limit reached; Atticus is used in its place.';
    answer([CARDS.chinch(BIF_ITEM, note)]);
    await open(guideContext({}, { item: BIF_ITEM, note }));
    await analyze();
    const group = await suggested();
    expect(within(group).getByText(note)).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Found at the edge. Add it' }));
    expect(screen.getByRole('group', { name: 'Atticus Talak 7.9 F' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Arena 50 WDG' })).toBeNull();
  });

  test('"Nothing found" dismisses the card; the standing chinch entry stays available', async () => {
    answer([CARDS.caterpillars(), CARDS.chinch()]);
    await open();
    await analyze();
    const group = await suggested();
    // While the chinch card shows, the standing entry is not listed a second time.
    expect(within(addons()).queryByText('Chinch bugs found at the edge of damage')).toBeNull();
    fireEvent.click(within(cardGroup('Insects: check for chinch bugs')).getByRole('button', { name: 'Nothing found' }));
    expect(screen.queryByRole('group', { name: 'Insects: check for chinch bugs suggestion' })).toBeNull();
    expect(within(group).getByText('Check first: soap flush to bring them to the surface.')).toBeTruthy();
    expect(within(addons()).getByText('Chinch bugs found at the edge of damage')).toBeTruthy();
    // Dismissing every card hides the group.
    fireEvent.click(within(cardGroup('Insects: check for caterpillars')).getByRole('button', { name: 'Nothing found' }));
    expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
  });

  test('"Chinch bugs found" is in the optional list with no cards at all, in every month, and adds Arena', async () => {
    answer([]);
    await open();
    // Until the assessment is confirmed the guide has not answered: the tap waits.
    expect(within(addons()).getByText('Chinch bugs found at the edge of damage')).toBeTruthy();
    expect(within(addons()).getAllByText('Confirm the assessment first.').length).toBeGreaterThan(0);
    expect(within(addons()).queryByRole('button', { name: 'Add chinch bug treatment' })).toBeNull();
    await analyze();
    await suggested();
    expect(within(addons()).getByText('Arena 50 WDG, spot treatment')).toBeTruthy();
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' }));
    expect(within(editorFor('Arena 50 WDG')).getByText(/from the protocol/)).toBeTruthy();
    expect(within(addons()).getByRole('button', { name: 'Chinch bug treatment is on the sheet' }).disabled).toBe(true);
  });

  describe('the fresh guide is the one chinch decision on screen', () => {
    // The sheet opened offering Arena; after Confirm the guide re-read the limits.
    const BIF_NOTE = 'Arena yearly limit reached; Atticus is used in its place.';
    const BOTH_NOTE = 'The yearly limit is reached for the chinch bug products on this lawn.';
    const UNREAD_NOTE = 'The chinch bug product limits could not be checked. Use Other product for what you sprayed.';
    const standing = () => within(addons());

    test('a cap reached after the sheet opened: the standing entry now adds the bifenthrin product, not Arena', async () => {
      answer([], WEED_MIX, { chinch: { item: BIF_ITEM, note: BIF_NOTE } });
      await open();
      expect(standing().queryByText('Arena 50 WDG, spot treatment')).toBeNull();
      await analyze();
      await suggested();
      expect(standing().getByText(`Atticus Talak 7.9 F, spot treatment · ${BIF_NOTE}`)).toBeTruthy();
      expect(standing().queryByText('Arena 50 WDG, spot treatment')).toBeNull();
      fireEvent.click(standing().getByRole('button', { name: 'Add chinch bug treatment' }));
      expect(screen.getByRole('group', { name: 'Atticus Talak 7.9 F' })).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Arena 50 WDG' })).toBeNull();
    });

    test('both capped on the fresh read: a line only, and the stale context cannot re-offer Arena', async () => {
      answer([], WEED_MIX, { chinch: { item: null, note: BOTH_NOTE } });
      await open();
      await analyze();
      await suggested();
      expect(standing().getByText(BOTH_NOTE)).toBeTruthy();
      expect(standing().queryByRole('button', { name: /chinch bug treatment/i })).toBeNull();
      expect(standing().queryByText(/Arena 50 WDG/)).toBeNull();
    });

    test('a fresh limit read that failed offers nothing, and says so', async () => {
      answer([], WEED_MIX, { chinch: { item: null, note: UNREAD_NOTE } });
      await open();
      await analyze();
      await suggested();
      expect(standing().getByText(UNREAD_NOTE)).toBeTruthy();
      expect(standing().queryByRole('button', { name: /chinch bug treatment/i })).toBeNull();
    });

    test('card dismissed, then the standing entry offers the fresh product (the card and the entry agree)', async () => {
      answer([CARDS.chinch(BIF_ITEM, BIF_NOTE)], WEED_MIX, { chinch: { item: BIF_ITEM, note: BIF_NOTE } });
      await open();
      await analyze();
      await suggested();
      expect(standing().queryByText('Chinch bugs found at the edge of damage')).toBeNull();
      fireEvent.click(within(cardGroup('Insects: check for chinch bugs')).getByRole('button', { name: 'Nothing found' }));
      expect(standing().getByText(`Atticus Talak 7.9 F, spot treatment · ${BIF_NOTE}`)).toBeTruthy();
      expect(standing().queryByText(/Arena 50 WDG/)).toBeNull();
    });

    test('a fresh answer with no chinch product at all (null) removes the standing entry', async () => {
      answer([], WEED_MIX, { chinch: null });
      await open();
      expect(standing().getByText('Chinch bugs found at the edge of damage')).toBeTruthy();
      await analyze();
      await suggested();
      expect(standing().queryByText('Chinch bugs found at the edge of damage')).toBeNull();
    });

    test('an answer that carries no chinch decision leaves the context\'s in force', async () => {
      guideAnswer = { enabled: true, v: 1, cards: [] };
      await open();
      await analyze();
      await suggested();
      expect(standing().getByText('Arena 50 WDG, spot treatment')).toBeTruthy();
    });
  });

  test('a visit whose plan is not eligible (no add-ons, no chinch offer) shows no standing entry, before or after Confirm', async () => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], weedMix: null, chinch: null };
    await open(guideContext({}, null));
    expect(screen.queryByText('Chinch bugs found at the edge of damage')).toBeNull();
    await analyze();
    await suggested();
    expect(screen.queryByText('Chinch bugs found at the edge of damage')).toBeNull();
    expect(screen.queryByRole('button', { name: /chinch bug treatment/i })).toBeNull();
  });

  test('the standing entry with both chinch products at their limit is a line only', async () => {
    const note = 'The yearly limit is reached for the chinch bug products on this lawn.';
    answer([]);
    await open(guideContext({}, { item: null, note }));
    await analyze();
    await suggested();
    expect(within(addons()).getByText(note)).toBeTruthy();
    expect(within(addons()).queryByRole('button', { name: /chinch bug treatment/i })).toBeNull();
  });

  test('without the flag a chinch offer in the payload is ignored', async () => {
    await open(guideContext({ treatmentGuide: false }));
    expect(within(addons()).queryByText('Chinch bugs found at the edge of damage')).toBeNull();
  });

  test('the dry-spot card adds the wetting agent with one tap; no check, no dismiss', async () => {
    answer([CARDS.dry_spots()]);
    await open();
    await analyze();
    const dry = cardGroup('Dry spots');
    expect(within(dry).queryByRole('button', { name: 'Nothing found' })).toBeNull();
    fireEvent.click(within(dry).getByRole('button', { name: 'Add Disp Wetting Agent' }));
    expect(within(editorFor('Disp Wetting Agent')).getByText(/from the protocol/)).toBeTruthy();
  });

  test('the completion carries which cards showed and what the tech did', async () => {
    answer([CARDS.weeds(), CARDS.fungus(), CARDS.chinch(), CARDS.caterpillars()]);
    await open();
    await analyze();
    const group = await suggested();
    // Weeds taken, fungus checked and taken, chinch dismissed, caterpillars left alone.
    fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
    fireEvent.click(within(group).getByRole('button', { name: 'I checked. Add it' }));
    fireEvent.click(within(cardGroup('Insects: check for chinch bugs')).getByRole('button', { name: 'Nothing found' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '250 sq ft' }));
    // A spot row takes the area from the tech, as every spot row does under the spot rules.
    fireEvent.click(within(editorFor('Art Fungicide')).getByRole('button', { name: '100 sq ft' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(completeCalls()[0].body.lawnFast).toEqual({
      visitType: 'recurring',
      treatmentGuide: {
        v: 1,
        cards: [
          { kind: 'weeds', shown: true, checked: null, taken: true, productIds: [P_LEAD, P_CERT] },
          { kind: 'fungus', shown: true, checked: 'found', taken: true, productIds: [P_ART] },
          { kind: 'chinch', shown: true, checked: 'none', taken: false, productIds: [P_ARENA] },
          { kind: 'caterpillars', shown: true, checked: null, taken: false, productIds: [P_ACE] },
        ],
      },
    });
    expect(sentProduct(P_ART)).toMatchObject({ applicationMethod: 'spot_treatment' });
  });

  test('a card whose product the tech removed again is recorded as not taken', async () => {
    answer([CARDS.fungus()]);
    await open();
    await analyze();
    const group = await suggested();
    fireEvent.click(within(group).getByRole('button', { name: 'I checked. Add it' }));
    fireEvent.click(within(editorFor('Art Fungicide')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sentGuide().cards).toEqual([{ kind: 'fungus', shown: true, checked: 'found', taken: false, productIds: [P_ART] }]);
  });

  test('a guide with no cards is recorded as shown empty', async () => {
    answer([]);
    await open();
    await analyzeAndComplete();
    expect(sentGuide()).toEqual({ v: 1, cards: [] });
  });

  test('a weed card adds the products it names even when the catalog does not list one of them', async () => {
    answer([CARDS.weeds()]);
    await openSheet({ request: makeRequest({ ctx: guideContext() }), props: { catalog: GUIDE_CATALOG.filter((p) => p.id !== P_CERT) } });
    await analyze();
    const group = await suggested();
    fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
    expect(screen.getByRole('group', { name: 'Lead WG' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Cert Herbicide' })).toBeTruthy();
  });

  describe('the fresh guide is the one weed offer on screen', () => {
    // The sheet opened with the full mix; after Confirm the guide re-read the plan: it is February
    // now (the lead alone), and the surfactant would be the exempt member.
    const FRESH = { ...WEED_MIX, productIds: [P_LEAD], note: 'February: Lead only while the lawn greens up.', surfactant: null, noAreaProductIds: [] };
    const freshCard = () => ({ ...CARDS.weeds(), detail: 'Lead WG', note: FRESH.note, productIds: [P_LEAD], items: [ADD_ONS[0]] });

    test('the tap adds what the fresh card names, not the context\'s older mix', async () => {
      answer([freshCard()], FRESH);
      await open();
      await analyze();
      const group = await suggested();
      expect(within(group).getByText(FRESH.note)).toBeTruthy();
      fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
      expect(screen.getByRole('group', { name: 'Lead WG' })).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Cert Herbicide' })).toBeNull();
      expect(within(cardGroup('Weed spots')).getByRole('button', { name: 'Weed spots: on the sheet' }).disabled).toBe(true);
    });

    test('the search follows the fresh decision: no product of its weed group is listed, offered or held back', async () => {
      answer([freshCard()], FRESH);
      await open();
      await analyze();
      await suggested();
      for (const name of ['Cert Herbicide', 'Lead WG']) {
        fireEvent.change(screen.getByLabelText('Search products'), { target: { value: name } });
        expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).toBeNull();
      }
    });

    test('the area exemption and the surfactant note follow the fresh facts', async () => {
      const note = 'Leave the surfactant out if it is 90°F or hotter.';
      const fresh = { ...WEED_MIX, productIds: [P_LEAD, P_CERT], surfactant: { productId: P_CERT, included: true, note }, noAreaProductIds: [P_CERT] };
      answer([CARDS.weeds()], fresh);
      await open();
      await analyze();
      fireEvent.click(within(await suggested()).getByRole('button', { name: 'Add weed spots' }));
      expect(within(editorFor('Cert Herbicide')).getByText(note)).toBeTruthy();
      // Only the lead asks for the shared area: the exempt member holds nothing.
      fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '250 sq ft' }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
    });

    test('with no weed card the add-ons entry follows the fresh decision too (a cap reached since the sheet opened)', async () => {
      const capped = { ...WEED_MIX, mode: 'none', productIds: [], note: 'Lead yearly limit reached. Blind is used November through March only.' };
      answer([], capped);
      await open();
      // Before the answer the entry waits (no button); the fresh answer then settles it.
      expect(within(addons()).queryByRole('button', { name: 'Add weed spots' })).toBeNull();
      await analyze();
      await suggested();
      expect(within(addons()).getByText(capped.note)).toBeTruthy();
      expect(within(addons()).queryByRole('button', { name: 'Add weed spots' })).toBeNull();
    });

    test('an answer with no weed decision leaves the context\'s in force', async () => {
      guideAnswer = { enabled: true, v: 1, cards: [] };
      await open();
      await analyze();
      await suggested();
      expect(within(addons()).getByRole('button', { name: 'Add weed spots' })).toBeTruthy();
    });
  });

  describe('the guide-governed taps wait for the fresh guide', () => {
    const waiting = () => within(addons()).getAllByText('Confirm the assessment first.');
    const searchFor = (name) => fireEvent.change(screen.getByLabelText('Search products'), { target: { value: name } });

    test('before the answer: the Weed spots entry, the chinch entry and the products a card may own show a line and no button; other add-ons are untouched', async () => {
      answer([]);
      await open();
      expect(waiting().length).toBeGreaterThanOrEqual(5);
      for (const name of ['Add weed spots', 'Add chinch bug treatment', 'Add Art Fungicide', 'Add Ace Insecticide', 'Add Disp Wetting Agent']) {
        expect(within(addons()).queryByRole('button', { name })).toBeNull();
      }
      // An add-on no card can own is listed as ever.
      expect(within(addons()).getByRole('button', { name: 'Add Vel Fungicide' })).toBeTruthy();
      // The search does not offer a way around the wait either.
      searchFor('Art Fungicide');
      expect(screen.queryByRole('button', { name: /^Art Fungicide/ })).toBeNull();
      searchFor('Arena');
      expect(screen.queryByRole('button', { name: /^Arena 50 WDG/ })).toBeNull();
    });

    test('the answer unlocks them (a lawn with no findings: the entries and the list are the context\'s)', async () => {
      answer([]);
      await open();
      await analyze();
      await suggested();
      expect(within(addons()).queryByText('Confirm the assessment first.')).toBeNull();
      for (const name of ['Add weed spots', 'Add chinch bug treatment', 'Add Art Fungicide', 'Add Ace Insecticide', 'Add Disp Wetting Agent']) {
        expect(within(addons()).getByRole('button', { name })).toBeTruthy();
      }
    });

    test('a retake locks them again', async () => {
      answer([]);
      await open();
      await analyze();
      await suggested();
      fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
      await screen.findByTestId('lawn-shot-list');
      expect(waiting().length).toBeGreaterThanOrEqual(5);
      expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
    });

    test.each([
      ['the read fails (network or 5xx)', () => refusal(500, 'boom', 'Internal error')],
      ['the answer is malformed', () => ({ unexpected: true })],
    ])('%s: the context\'s decisions stand and nothing stays locked', async (_label, make) => {
      guideAnswer = make();
      await open();
      await analyze();
      await waitFor(() => expect(guideCalls()).toHaveLength(1));
      await waitFor(() => expect(within(addons()).queryByText('Confirm the assessment first.')).toBeNull());
      expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add weed spots' }));
      expect(screen.getByRole('group', { name: 'Lead WG' })).toBeTruthy();
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' }));
      expect(screen.getByRole('group', { name: 'Arena 50 WDG' })).toBeTruthy();
      // And nothing is sent as a guide record.
      fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '250 sq ft' }));
      fireEvent.click(within(editorFor('Arena 50 WDG')).getByRole('button', { name: '100 sq ft' }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      expect(completeCalls()[0].body.lawnFast).toEqual({ visitType: 'recurring' });
    });

    test('a second answer drops the rows it no longer offers, and says so; rows it still offers stay', async () => {
      let calls = 0;
      const first = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [CARDS.weeds(), CARDS.chinch()], weedMix: WEED_MIX, chinch: { item: ARENA_ITEM, note: null } };
      // The limits changed: Arena is capped (the bifenthrin product is offered) and the lead is capped (nothing to add).
      const second = { ...first, cards: [CARDS.chinch(BIF_ITEM, 'Arena yearly limit reached; Atticus is used in its place.')], weedMix: { ...WEED_MIX, mode: 'none', productIds: [] }, chinch: { item: BIF_ITEM, note: null } };
      guideAnswer = () => { calls += 1; return calls === 1 ? first : second; };
      await open();
      await analyze();
      const group = await suggested();
      fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
      fireEvent.click(within(group).getByRole('button', { name: 'Found at the edge. Add it' }));
      fireEvent.click(within(addons()).queryByRole('button', { name: 'Add Vel Fungicide' }));
      expect(screen.getAllByRole('group', { name: /Lead WG|Cert Herbicide|Arena 50 WDG|Vel Fungicide/ })).toHaveLength(4);
      // Retake and confirm again: the second answer replaces the first.
      fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
      await screen.findByTestId('lawn-shot-list');
      await analyze();
      await screen.findByText('Removed: Lead WG, Cert Herbicide, Arena 50 WDG. The limits changed.');
      expect(screen.queryByRole('group', { name: 'Lead WG' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Cert Herbicide' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Arena 50 WDG' })).toBeNull();
      // A row the tech added from the generic list is not the guide's and stays.
      expect(screen.getByRole('group', { name: 'Vel Fungicide' })).toBeTruthy();
      expect(guideCalls()).toHaveLength(2);
    });

    test('a second answer that still offers a row leaves it, with no line', async () => {
      answer([CARDS.fungus()]);
      await open();
      await analyze();
      fireEvent.click(within(await suggested()).getByRole('button', { name: 'I checked. Add it' }));
      fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
      await screen.findByTestId('lawn-shot-list');
      await analyze();
      await waitFor(() => expect(guideCalls()).toHaveLength(2));
      await suggested();
      expect(screen.getByRole('group', { name: 'Art Fungicide' })).toBeTruthy();
      expect(screen.queryByText(/The limits changed/)).toBeNull();
    });
  });

  describe('a product a visible card owns is not offered anywhere else', () => {
    const searchFor = (name) => fireEvent.change(screen.getByLabelText('Search products'), { target: { value: name } });
    const GENERIC = (name) => within(addons()).queryByRole('button', { name: `Add ${name}` });

    test.each([
      ['fungus', () => CARDS.fungus(), 'Art Fungicide'],
      ['caterpillars', () => CARDS.caterpillars(), 'Ace Insecticide'],
      ['dry_spots', () => CARDS.dry_spots(), 'Disp Wetting Agent'],
    ])('the %s card owns its product: not in the add-ons list, not in the search', async (_kind, makeCard, name) => {
      answer([makeCard()]);
      await open();
      await analyze();
      await suggested();
      expect(GENERIC(name)).toBeNull();
      searchFor(name.split(' ')[0]);
      expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).toBeNull();
      // The other add-ons are still there.
      expect(GENERIC('Vel Fungicide')).toBeTruthy();
    });

    test('the chinch card owns Arena: out of the search while it shows', async () => {
      answer([CARDS.chinch()]);
      await open();
      await analyze();
      await suggested();
      searchFor('Arena');
      expect(screen.queryByRole('button', { name: /^Arena 50 WDG/ })).toBeNull();
    });

    test('"Nothing found" releases the product to the list and the search (the tech looked and decided)', async () => {
      answer([CARDS.fungus(), CARDS.chinch()]);
      await open();
      await analyze();
      await suggested();
      fireEvent.click(within(cardGroup('Fungus')).getByRole('button', { name: 'Nothing found' }));
      expect(GENERIC('Art Fungicide')).toBeTruthy();
      searchFor('Art Fungicide');
      expect(await screen.findByRole('button', { name: /^Art Fungicide/ })).toBeTruthy();
      fireEvent.click(within(cardGroup('Insects: check for chinch bugs')).getByRole('button', { name: 'Nothing found' }));
      // A chinch rung is governed for the visit: after "Nothing found" it comes through the standing
      // entry (which returns), never the search.
      expect(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' })).toBeTruthy();
      searchFor('Arena');
      expect(screen.queryByRole('button', { name: /^Arena 50 WDG/ })).toBeNull();
    });

    test('a take-all card holds its product: no add button anywhere, and it stays out of the list and the search', async () => {
      answer([CARDS.takeAll()]);
      await open();
      await analyze();
      const group = await suggested();
      expect(within(group).queryByRole('button')).toBeNull();
      expect(GENERIC('Art Fungicide')).toBeNull();
      searchFor('Art Fungicide');
      expect(screen.queryByRole('button', { name: /^Art Fungicide/ })).toBeNull();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      expect(sentProduct(P_ART)).toBeUndefined();
      expect(sentGuide().cards).toEqual([{ kind: 'fungus', shown: true, checked: null, taken: false, productIds: [] }]);
    });

    test('a product on the sheet through its card is recorded as checked', async () => {
      answer([CARDS.caterpillars()]);
      await open();
      await analyze();
      fireEvent.click(within(await suggested()).getByRole('button', { name: 'Found them. Add it' }));
      fireEvent.click(within(editorFor('Ace Insecticide')).getByRole('button', { name: '100 sq ft' }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      expect(sentGuide().cards).toEqual([{ kind: 'caterpillars', shown: true, checked: 'found', taken: true, productIds: [P_ACE] }]);
    });
  });

  describe('the plan\'s notes for an off-month chinch product (a watering hold) are shown', () => {
    const HOLD = 'Delay watering for 24 hours.';
    const TALAK = { ...BIF_ITEM, gateNotes: [HOLD] };
    const NOTE = 'Arena yearly limit reached; Atticus is used in its place.';

    test('on the card, on the standing entry, and on the row the tap opens', async () => {
      answer([CARDS.chinch(TALAK, NOTE)], WEED_MIX, { chinch: { item: TALAK, note: NOTE } });
      await open();
      await analyze();
      const group = await suggested();
      expect(within(group).getByText(HOLD)).toBeTruthy();
      fireEvent.click(within(group).getByRole('button', { name: 'Found at the edge. Add it' }));
      expect(within(editorFor('Atticus Talak 7.9 F')).getByText(HOLD)).toBeTruthy();
    });

    test('the standing entry names the hold with the product', async () => {
      answer([], WEED_MIX, { chinch: { item: TALAK, note: NOTE } });
      await open();
      await analyze();
      await suggested();
      expect(within(addons()).getByText(`Atticus Talak 7.9 F, spot treatment · ${HOLD} · ${NOTE}`)).toBeTruthy();
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' }));
      expect(within(editorFor('Atticus Talak 7.9 F')).getByText(HOLD)).toBeTruthy();
    });

    test('a plan add-on row carries its notes the same way', async () => {
      const heldAddOn = { ...ADD_ONS[4], gateNotes: ['Delay watering (irrigation) or mowing for 24 hours after application (label).'] };
      answer([])
      await open(guideContext({ plannedProducts: { source: 'plan', items: [PLANNED[0]], addOns: [ADD_ONS[2], heldAddOn], month: 7, weedMix: null } }, null));
      await analyze();
      await suggested();
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Ace Insecticide' }));
      expect(within(editorFor('Ace Insecticide')).getByText(/Delay watering \(irrigation\)/)).toBeTruthy();
    });
  });

  // ── the matrix: one invariant, every path, every state ─────────────────────────────────
  // A product that belongs to a guide-governed kind (the weed group, the chinch rungs, the month's
  // fungicide / caterpillar / dry-spot picks) may be ON the sheet only if the LATEST decision offers it,
  // and may be ADDED only through the entry or card that decision offers. The latest decision is the
  // fresh guide answer, or, when the read failed, the context's own decisions.
  describe('governance matrix: paths by states', () => {
    const P_BLIND = 'cccccccc-0000-4000-8000-000000000009';
    const TALAK_ADDON = addOn(P_BIF, 'Atticus Talak 7.9 F', 'Atticus Talak 7.9 F — chinch bugs, second product');
    const BLIND_ADDON = addOn(P_BLIND, 'Blind Herbicide');
    const MX_CATALOG = [...GUIDE_CATALOG, { id: P_BLIND, name: 'Blind Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 1, default_unit: 'fl_oz' }];
    const MX_WEED = { ...WEED_MIX, groupProductIds: [P_LEAD, P_CERT, P_BLIND], replacementProductId: P_BLIND };
    const mxContext = (extra = {}) => guideContext({
      plannedProducts: { source: 'plan', items: [PLANNED[0]], addOns: [...ADD_ONS, TALAK_ADDON, BLIND_ADDON], month: 7, weedMix: MX_WEED, guidedProductIds: [P_ART, P_ACE, P_DISP], chinch: { item: ARENA_ITEM, note: null, rungIds: RUNGS } },
      ...extra,
    });
    const mxOpen = (ctx = mxContext()) => openSheet({ request: makeRequest({ ctx }), props: { catalog: MX_CATALOG } });
    const answerOf = (cards, weedMix, chinch, blockedProductIds = []) => ({ enabled: true, v: 1, assessmentId: 'assessment-1', cards, weedMix, chinch, blockedProductIds });
    const NEVER = () => new Promise(() => {});
    const UNREADABLE = 'The limits could not be checked. Use Search products for what you applied; the office will review it.';
    const UNREAD_CHINCH = { item: null, note: UNREADABLE, rungIds: RUNGS, blockedIds: [], unreadableIds: RUNGS };
    const mxPlanned = (over = {}) => ({ source: 'plan', items: [PLANNED[0]], addOns: [...ADD_ONS, TALAK_ADDON, BLIND_ADDON], month: 7, weedMix: MX_WEED, guidedProductIds: [P_ART, P_ACE, P_DISP], chinch: { item: ARENA_ITEM, note: null, rungIds: RUNGS }, ...over });
    // The answer when the limit read failed: nothing offered, nothing forbidden, everything governed unreadable.
    const UNREADABLE_ANSWER = () => ({
      ...answerOf([], { ...MX_WEED, mode: 'unavailable', productIds: [], note: UNREADABLE }, UNREAD_CHINCH, []),
      unreadableProductIds: [P_ART, P_ACE, P_DISP, P_ARENA, P_BIF, P_LEAD, P_CERT, P_BLIND], unreadableNote: UNREADABLE,
    });

    // Probes: what a path says right now.
    const lineOf = (name) => {
      const group = screen.queryByRole('group', { name: /Also in .*protocol/ });
      const label = group && within(group).queryByText(name);
      return label ? label.closest('.tech-protocol-addon') : null;
    };
    const listState = (name) => {
      const line = lineOf(name);
      if (!line) return 'hidden';
      if (line.textContent.includes('Confirm the assessment first.')) return 'locked';
      return within(line).queryByRole('button', { name: /^Add|^Chinch/ }) ? 'addable' : 'line';
    };
    const cardState = (title, button) => {
      const card = screen.queryByRole('group', { name: `${title} suggestion` });
      if (!card) return 'absent';
      return within(card).queryByRole('button', { name: button }) ? 'addable' : 'present';
    };
    const searchState = async (term, re) => {
      fireEvent.change(screen.getByLabelText('Search products'), { target: { value: term } });
      try {
        await waitFor(() => { if (!screen.queryByRole('button', { name: re })) throw new Error('none'); }, { timeout: 250 });
        return 'addable';
      } catch { return 'hidden'; }
    };
    const probe = async () => ({
      art: listState('Art Fungicide'),
      artSearch: await searchState('Art Fungicide', /^Art Fungicide/),
      leadSearch: await searchState('Lead WG', /^Lead WG/),
      arenaSearch: await searchState('Arena', /^Arena 50 WDG/),
      talak: listState('Atticus Talak 7.9 F'),
      vel: listState('Vel Fungicide'),
      weedEntry: listState('Weed spots'),
      chinchEntry: listState('Chinch bugs found at the edge of damage'),
      weedCard: cardState('Weed spots', 'Add weed spots'),
      chinchCard: cardState('Insects: check for chinch bugs', /Add it/),
      fungusCard: cardState('Fungus', 'I checked. Add it'),
      catCard: cardState('Insects: check for caterpillars', /Add it/),
      dryCard: cardState('Dry spots', 'Add Disp Wetting Agent'),
    });
    const NO_CARDS = { weedCard: 'absent', chinchCard: 'absent', fungusCard: 'absent', catCard: 'absent', dryCard: 'absent' };
    const CLEAN_CHINCH = { item: ARENA_ITEM, note: null, rungIds: RUNGS };

    const STATES = [
      ['guide off', async () => { await mxOpen(mxContext({ treatmentGuide: false })); await analyze(); },
        { art: 'addable', artSearch: 'addable', leadSearch: 'hidden', arenaSearch: 'addable', talak: 'addable', vel: 'addable', weedEntry: 'addable', chinchEntry: 'hidden', ...NO_CARDS }],
      ['idle (before Confirm)', async () => { answer([]); await mxOpen(); },
        { art: 'locked', artSearch: 'hidden', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'locked', vel: 'addable', weedEntry: 'locked', chinchEntry: 'locked', ...NO_CARDS }],
      ['pending (asked, not answered)', async () => { guideAnswer = NEVER; await mxOpen(); await analyze(); },
        { art: 'locked', artSearch: 'hidden', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'locked', vel: 'addable', weedEntry: 'locked', chinchEntry: 'locked', ...NO_CARDS }],
      ['answered, everything offered', async () => {
        guideAnswer = answerOf([CARDS.weeds(), CARDS.fungus(), CARDS.chinch(), CARDS.caterpillars(), CARDS.dry_spots()], MX_WEED, CLEAN_CHINCH);
        await mxOpen(); await analyze(); await suggested();
      }, { art: 'hidden', artSearch: 'hidden', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'hidden', vel: 'addable', weedEntry: 'hidden', chinchEntry: 'hidden', weedCard: 'addable', chinchCard: 'addable', fungusCard: 'addable', catCard: 'addable', dryCard: 'addable' }],
      ['answered, everything blocked', async () => {
        const note = 'The yearly weed-spray limit is reached for this lawn.';
        guideAnswer = answerOf([], { ...MX_WEED, mode: 'none', productIds: [], note }, { item: null, note: 'The chinch bug product limits could not be checked.', rungIds: RUNGS, blockedIds: RUNGS }, [P_ART, P_ACE, P_DISP, P_ARENA, P_BIF, P_LEAD, P_CERT, P_BLIND]);
        await mxOpen(); await analyze(); await suggested();
      }, { art: 'hidden', artSearch: 'hidden', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'hidden', vel: 'addable', weedEntry: 'line', chinchEntry: 'line', ...NO_CARDS }],
      ['answered, no finding and nothing blocked', async () => {
        guideAnswer = answerOf([], MX_WEED, CLEAN_CHINCH);
        await mxOpen(); await analyze(); await suggested();
      }, { art: 'addable', artSearch: 'addable', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'hidden', vel: 'addable', weedEntry: 'addable', chinchEntry: 'addable', ...NO_CARDS }],
      ['guide request fails after a clean context (failed on the first read)', async () => { guideAnswer = refusal(500, 'boom', 'Internal error'); await mxOpen(); await analyze(); await waitFor(() => expect(guideCalls()).toHaveLength(1)); },
        { art: 'addable', artSearch: 'addable', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'hidden', vel: 'addable', weedEntry: 'addable', chinchEntry: 'addable', ...NO_CARDS }],
      // Unreadable is not blocked: nothing is offered (no card, no tap), but every product is released to
      // the search, a pick to the list, so a real application can still be recorded.
      ['answered, limits unreadable', async () => {
        guideAnswer = UNREADABLE_ANSWER();
        await mxOpen(); await analyze(); await suggested();
      }, { art: 'addable', artSearch: 'addable', leadSearch: 'addable', arenaSearch: 'addable', talak: 'addable', vel: 'addable', weedEntry: 'line', chinchEntry: 'line', ...NO_CARDS }],
      // Per rung: Arena's limit was READ (blocked, stays hidden), Talak's own read failed (released to the
      // search and the list, with the note); nothing is offered.
      ['answered, one rung blocked and one unreadable', async () => {
        guideAnswer = {
          ...answerOf([], MX_WEED, { item: null, note: UNREADABLE, rungIds: RUNGS, blockedIds: [P_ARENA], unreadableIds: [P_BIF] }, [P_ARENA]),
          unreadableProductIds: [P_BIF], unreadableNote: UNREADABLE,
        };
        await mxOpen(); await analyze(); await suggested();
      }, { art: 'addable', artSearch: 'addable', leadSearch: 'hidden', arenaSearch: 'hidden', talak: 'addable', vel: 'addable', weedEntry: 'addable', chinchEntry: 'line', ...NO_CARDS }],
      ['failed on the first read, context weed mix unavailable', async () => {
        guideAnswer = refusal(500, 'boom', 'Internal error');
        await mxOpen(mxContext({ plannedProducts: mxPlanned({ weedMix: { ...MX_WEED, mode: 'unavailable', productIds: [], note: UNREADABLE }, chinch: UNREAD_CHINCH }) }));
        await analyze(); await waitFor(() => expect(guideCalls()).toHaveLength(1));
      }, { art: 'addable', artSearch: 'addable', leadSearch: 'addable', arenaSearch: 'addable', talak: 'addable', vel: 'addable', weedEntry: 'line', chinchEntry: 'line', ...NO_CARDS }],
      // Control: guide off, limits unreadable: exactly #6129 (the weed products stay searchable, with its own note).
      ['guide off, weed limits unreadable (control)', async () => {
        await mxOpen(mxContext({ treatmentGuide: false, plannedProducts: mxPlanned({ weedMix: { ...MX_WEED, mode: 'unavailable', productIds: [], note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.' }, chinch: undefined }) }));
        await analyze();
      }, { art: 'addable', artSearch: 'addable', leadSearch: 'addable', arenaSearch: 'addable', talak: 'addable', vel: 'addable', weedEntry: 'line', chinchEntry: 'hidden', ...NO_CARDS }],
    ];

    test.each(STATES)('%s', async (_name, setup, expected) => {
      await setup();
      // Let a first answer or failure settle before reading the paths.
      await waitFor(() => expect(document.querySelector('.tech-protocol-addons')).toBeTruthy());
      expect(await probe()).toEqual(expected);
    });

    test('a failed guide request keeps the context\'s rungs governed: Arena is not in the search, Talak is not a generic add-on, and the standing entry is the context\'s', async () => {
      guideAnswer = refusal(500, 'boom', 'Internal error');
      await mxOpen();
      await analyze();
      await waitFor(() => expect(guideCalls()).toHaveLength(1));
      await waitFor(() => expect(listState('Chinch bugs found at the edge of damage')).toBe('addable'));
      expect(await searchState('Arena', /^Arena 50 WDG/)).toBe('hidden');
      expect(await searchState('Atticus', /^Atticus Talak 7\.9 F/)).toBe('hidden');
      expect(listState('Atticus Talak 7.9 F')).toBe('hidden');
      expect(lineOf('Chinch bugs found at the edge of damage').textContent).toContain('Arena 50 WDG, spot treatment');
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' }));
      expect(present('Arena 50 WDG')).toBe(true);
    });

    test('weed members are judged one by one: the member read as capped stays out of the search, its sibling is released', async () => {
      const weedMix = { ...MX_WEED, mode: 'unavailable', productIds: [], note: UNREADABLE, blockedIds: [P_LEAD] };
      guideAnswer = { ...answerOf([], weedMix, CLEAN_CHINCH, [P_LEAD]), unreadableProductIds: [P_CERT, P_BLIND], unreadableNote: UNREADABLE };
      await mxOpen(); await analyze(); await suggested();
      expect(await searchState('Lead WG', /^Lead WG/)).toBe('hidden');
      expect(await searchState('Cert Herbicide', /^Cert Herbicide/)).toBe('addable');
    });

    test('pending also holds Complete until the guide has answered', async () => {
      guideAnswer = NEVER;
      await mxOpen();
      await analyze();
      await waitFor(() => expect(footerNote()).toBe('Wait for the lawn guide to finish.'));
      expect(completeButton().disabled).toBe(true);
    });

    // Rows already on the sheet when a new decision arrives.
    const weedsFor = (id, name) => ({ ...CARDS.weeds(), detail: name, productIds: [id], items: [addOn(id, name)] });
    const SECOND = 'Atticus is used in its place.';
    const FIRST_ANSWER = () => answerOf(
      [weedsFor(P_BLIND, 'Blind Herbicide'), CARDS.chinch(BIF_ITEM, SECOND), CARDS.fungus()],
      { ...MX_WEED, mode: 'replacement', productIds: [P_BLIND] },
      { item: BIF_ITEM, note: SECOND, rungIds: RUNGS },
      [P_LEAD, P_CERT, P_ARENA],
    );
    const present = (name) => !!screen.queryByRole('group', { name });
    const retake = async () => { fireEvent.click(screen.getByRole('button', { name: 'Retake' })); await screen.findByTestId('lawn-shot-list'); };
    // The tech takes what the first answer offers, plus a row from the generic list.
    const takeFirstAnswer = async () => {
      guideAnswer = FIRST_ANSWER();
      await mxOpen(); await analyze();
      const group = await suggested();
      fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
      fireEvent.click(within(group).getByRole('button', { name: 'Found at the edge. Add it' }));
      fireEvent.click(within(group).getByRole('button', { name: 'I checked. Add it' }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Vel Fungicide' }));
      for (const name of ['Blind Herbicide', 'Atticus Talak 7.9 F', 'Art Fungicide', 'Vel Fungicide']) expect(present(name)).toBe(true);
    };

    test.each([
      ['a retake (no decision yet): every row stays, the taps lock again', async () => { await retake(); }, ['Blind Herbicide', 'Atticus Talak 7.9 F', 'Art Fungicide', 'Vel Fungicide'], [], null],
      ['answered, then the same answer again: every row is still offered', async () => { await retake(); await analyze(); await waitFor(() => expect(guideCalls()).toHaveLength(2)); await suggested(); }, ['Blind Herbicide', 'Atticus Talak 7.9 F', 'Art Fungicide', 'Vel Fungicide'], [], null],
      ['answered, then a refresh that failed: the context decides, so the rows it does not offer go', async () => {
        await retake(); guideAnswer = refusal(500, 'boom', 'Internal error'); await analyze();
        await screen.findByText(/The limits could not be checked\./);
      }, ['Art Fungicide', 'Vel Fungicide'], ['Blind Herbicide', 'Atticus Talak 7.9 F'], 'Removed: Blind Herbicide, Atticus Talak 7.9 F. The limits could not be checked.'],
      ['answered, then a changed answer: blocked and unoffered rows go, a generic row stays', async () => {
        await retake();
        guideAnswer = answerOf([], { ...MX_WEED, mode: 'none', productIds: [] }, CLEAN_CHINCH, [P_ART, P_ACE, P_DISP]);
        await analyze(); await screen.findByText(/The limits changed\./);
      }, ['Vel Fungicide'], ['Blind Herbicide', 'Atticus Talak 7.9 F', 'Art Fungicide'], 'Removed: Blind Herbicide, Atticus Talak 7.9 F, Art Fungicide. The limits changed.'],
    ])('rows after: %s', async (_name, move, kept, dropped, line) => {
      await takeFirstAnswer();
      await move();
      for (const name of kept) expect(present(name)).toBe(true);
      for (const name of dropped) expect(present(name)).toBe(false);
      if (line) expect(screen.getByText(line)).toBeTruthy(); else expect(screen.queryByText(/^Removed:/)).toBeNull();
    });

    test('answered offered, then unreadable: the rows stay (we cannot say the products are forbidden) and Complete is not held by the guide', async () => {
      await takeFirstAnswer();
      await retake();
      guideAnswer = UNREADABLE_ANSWER();
      await analyze();
      await suggested();
      for (const name of ['Blind Herbicide', 'Atticus Talak 7.9 F', 'Art Fungicide', 'Vel Fungicide']) expect(present(name)).toBe(true);
      expect(screen.queryByText(/^Removed:/)).toBeNull();
      expect(footerNote()).not.toMatch(/not offered for this lawn|Wait for the lawn guide/);
    });

    test('answered unreadable, then blocked: the rows go with "The limits changed."; a generic row stays', async () => {
      guideAnswer = UNREADABLE_ANSWER();
      await mxOpen(); await analyze(); await suggested();
      // The tech records what he applied: a pick from the list, a weed product from the search.
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Art Fungicide' }));
      fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'Lead WG' } });
      fireEvent.click(await screen.findByRole('button', { name: /^Lead WG/ }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Vel Fungicide' }));
      for (const name of ['Art Fungicide', 'Lead WG', 'Vel Fungicide']) expect(present(name)).toBe(true);
      await retake();
      // Now the read succeeds and forbids them.
      guideAnswer = answerOf([], { ...MX_WEED, mode: 'none', productIds: [] }, CLEAN_CHINCH, [P_ART, P_LEAD, P_CERT, P_BLIND]);
      await analyze();
      await screen.findByText('Removed: Art Fungicide, Lead WG. The limits changed.');
      expect(present('Art Fungicide')).toBe(false);
      expect(present('Lead WG')).toBe(false);
      expect(present('Vel Fungicide')).toBe(true);
    });

    test('an unreadable product is never silent: the weed entry, the chinch entry and an unreadable pick all carry the one wording', async () => {
      guideAnswer = UNREADABLE_ANSWER();
      await mxOpen(); await analyze(); await suggested();
      for (const name of ['Weed spots', 'Chinch bugs found at the edge of damage', 'Art Fungicide', 'Atticus Talak 7.9 F']) {
        expect(lineOf(name).textContent).toContain(UNREADABLE);
      }
      // A pick the read did not flag shows no such note.
      expect(lineOf('Vel Fungicide').textContent).not.toContain(UNREADABLE);
      // And the products can really be recorded: the rung from the search, the weed group from the search.
      fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'Arena' } });
      fireEvent.click(await screen.findByRole('button', { name: /^Arena 50 WDG/ }));
      expect(present('Arena 50 WDG')).toBe(true);
    });

    test('a retake locks the entries again while the rows wait for the new decision', async () => {
      await takeFirstAnswer();
      await retake();
      expect(listState('Weed spots')).toBe('locked');
      expect(listState('Chinch bugs found at the edge of damage')).toBe('locked');
      expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull();
    });

    test('failed on the first read, then a changed answer: rows taken from the context are dropped', async () => {
      guideAnswer = refusal(500, 'boom', 'Internal error');
      await mxOpen(); await analyze();
      await waitFor(() => expect(guideCalls()).toHaveLength(1));
      await waitFor(() => expect(listState('Weed spots')).toBe('addable'));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add weed spots' }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment' }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Art Fungicide' }));
      fireEvent.click(within(addons()).getByRole('button', { name: 'Add Vel Fungicide' }));
      for (const name of ['Lead WG', 'Cert Herbicide', 'Arena 50 WDG', 'Art Fungicide', 'Vel Fungicide']) expect(present(name)).toBe(true);
      await retake();
      guideAnswer = answerOf([], { ...MX_WEED, mode: 'none', productIds: [] }, { item: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.', rungIds: RUNGS }, [P_ART, P_ARENA, P_BIF, P_LEAD, P_CERT]);
      await analyze();
      await screen.findByText(/The limits changed\./);
      for (const name of ['Lead WG', 'Cert Herbicide', 'Arena 50 WDG', 'Art Fungicide']) expect(present(name)).toBe(false);
      expect(present('Vel Fungicide')).toBe(true);
    });

    test('the belt: a governed row the latest decision does not offer blocks Complete with the plain line', async () => {
      // A planned default that is also a blocked pick: impossible by construction, so the state is forced.
      const planned = [PLANNED[0], { productId: P_ART, name: 'Art Fungicide', applicationMethod: 'broadcast_spray', amount: 1, amountUnit: 'fl_oz', treatedSqft: 5000, areaUnit: 'sqft' }];
      guideAnswer = answerOf([], MX_WEED, CLEAN_CHINCH, [P_ART]);
      await mxOpen(mxContext({ plannedProducts: { source: 'plan', items: planned, addOns: ADD_ONS, month: 7, weedMix: MX_WEED, guidedProductIds: [P_ART, P_ACE, P_DISP], chinch: CLEAN_CHINCH } }));
      await analyze();
      await suggested();
      await waitFor(() => expect(footerNote()).toBe('Remove Art Fungicide: it is not offered for this lawn right now.'));
      expect(completeButton().disabled).toBe(true);
      // Removing the row clears the hold.
      fireEvent.click(within(editorFor('Art Fungicide')).getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
    });

    test('the same row is fine when the decision offers it (no finding, nothing blocked)', async () => {
      const planned = [PLANNED[0], { productId: P_ART, name: 'Art Fungicide', applicationMethod: 'broadcast_spray', amount: 1, amountUnit: 'fl_oz', treatedSqft: 5000, areaUnit: 'sqft' }];
      guideAnswer = answerOf([], MX_WEED, CLEAN_CHINCH, []);
      await mxOpen(mxContext({ plannedProducts: { source: 'plan', items: planned, addOns: ADD_ONS, month: 7, weedMix: MX_WEED, guidedProductIds: [P_ART, P_ACE, P_DISP], chinch: CLEAN_CHINCH } }));
      await analyze();
      await suggested();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
    });
  });

  test('a half-added weed mix is not "on the sheet": the tap finishes it, and the record says taken only when all are on', async () => {
    answer([CARDS.weeds()]);
    await open();
    await analyze();
    const group = await suggested();
    fireEvent.click(within(group).getByRole('button', { name: 'Add weed spots' }));
    fireEvent.click(within(editorFor('Cert Herbicide')).getByRole('button', { name: 'Remove' }));
    // Only the first product is left: the card is open again.
    const again = within(cardGroup('Weed spots')).getByRole('button', { name: 'Add weed spots' });
    expect(again.disabled).toBe(false);
    fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '250 sq ft' }));
    fireEvent.click(again);
    // The missing member is back; the lead is not duplicated.
    expect(screen.getAllByRole('group', { name: 'Lead WG' })).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Cert Herbicide' })).toBeTruthy();
    expect(within(cardGroup('Weed spots')).getByRole('button', { name: 'Weed spots: on the sheet' }).disabled).toBe(true);
    fireEvent.click(within(editorFor('Cert Herbicide')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sentGuide().cards).toEqual([{ kind: 'weeds', shown: true, checked: null, taken: false, productIds: [P_LEAD, P_CERT] }]);
  });

  test('malformed cards in the answer are ignored', async () => {
    guideAnswer = { enabled: true, v: 1, cards: [null, { kind: 'mystery', title: 'x', productIds: [], items: [] }, { kind: 'fungus' }, CARDS.dry_spots()] };
    await open();
    await analyze();
    const group = await suggested();
    expect(within(group).getAllByRole('button')).toHaveLength(1);
  });
});
