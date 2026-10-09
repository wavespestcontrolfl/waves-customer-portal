// @vitest-environment jsdom
// The place of a spot treatment and the lawn's known trouble areas on the lawn Fast Complete sheet
// (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09). The server sends the closed list of places, the known
// areas, what each yearly limit closes where, and a decision per place for the Weed spots and chinch
// entries; the sheet only renders and enforces what it is given. With no `troubleAreas` it renders
// exactly as before. Synthetic data only; no real provider is ever called (every request is a stub).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';

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
    if (path.includes('/lawn-fast/context')) {
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

const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
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


const P_LEAD = 'bbbbbbbb-0000-4000-8000-000000000001';
const P_CERT = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_SURF = 'bbbbbbbb-0000-4000-8000-000000000003';
const P_BLIND = 'bbbbbbbb-0000-4000-8000-000000000004';
const P_FUNG = 'cccccccc-0000-4000-8000-000000000001';
const P_ARENA = 'cccccccc-0000-4000-8000-000000000002';
const P_BIF = 'cccccccc-0000-4000-8000-000000000003';
const PLACE_LIST = [{ id: 'front', label: 'Front' }, { id: 'back', label: 'Back' }, { id: 'left_side', label: 'Left side' }, { id: 'right_side', label: 'Right side' }];
const CAT = [
  { id: P_LEAD, name: 'Lead WG', category: 'herbicide', formulation: 'WG', default_rate_per_1000: 2, default_unit: 'oz' },
  { id: P_CERT, name: 'Cert Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 0.5, default_unit: 'fl_oz' },
  { id: P_SURF, name: 'Tank Surfactant', category: 'adjuvant', formulation: 'SL', default_rate_per_1000: 1, default_unit: 'fl_oz' },
  { id: P_BLIND, name: 'Blind Herbicide', category: 'herbicide', formulation: 'SC', default_rate_per_1000: 1, default_unit: 'fl_oz' },
  { id: P_FUNG, name: 'Spot Fungicide', category: 'fungicide', formulation: 'SC', default_rate_per_1000: 1, default_unit: 'fl_oz' },
  { id: P_ARENA, name: 'Arena 50 WDG', category: 'insecticide', formulation: 'WDG', default_rate_per_1000: 0.147, default_unit: 'oz' },
  { id: P_BIF, name: 'Atticus Talak 7.9 F', category: 'insecticide', formulation: 'SC', default_rate_per_1000: 0.2, default_unit: 'fl_oz' },
  ...CATALOG,
];
const addOn = (productId, name, extra = {}) => ({ productId, name, applicationMethod: 'spot_treatment', amount: null, amountUnit: 'oz', line: null, substituteFor: null, gateNotes: [], ...extra });
const ADD_ONS = [addOn(P_LEAD, 'Lead WG'), addOn(P_CERT, 'Cert Herbicide'), addOn(P_SURF, 'Tank Surfactant'), addOn(P_BLIND, 'Blind Herbicide'), addOn(P_FUNG, 'Spot Fungicide', { ratePer1000: 1, rateUnit: 'fl_oz' })];
const LEAD_SET = { mode: 'lead', productIds: [P_LEAD, P_CERT, P_SURF], note: null, surfactant: { productId: P_SURF, included: true, note: null }, tempF: 82 };
const BLIND_SET = { mode: 'replacement', productIds: [P_BLIND], note: 'Lead yearly limit reached; Blind is used in its place.', surfactant: null, tempF: null };
const NONE_SET = { mode: 'none', productIds: [], note: 'The yearly weed-spray limit is reached for this lawn.', surfactant: null, tempF: null };
const MIX = (byPlace, top = LEAD_SET) => ({
  ...top, groupProductIds: [P_LEAD, P_CERT, P_SURF, P_BLIND], replacementProductId: P_BLIND, noAreaProductIds: [P_SURF], byPlace,
});
const ALL = (set) => Object.fromEntries(PLACE_LIST.map((place) => [place.id, set]));
const areasBlock = (extra = {}) => ({ v: 1, places: PLACE_LIST, known: [], knownUnavailable: false, blocked: {}, ...extra });
const KNOWN_FUNGUS_BACK = { id: 'area-1', place: 'back', placeLabel: 'Back', type: 'fungus', typeLabel: 'Fungus', lastTreatedOn: '2026-09-12' };

const placeContext = ({ troubleAreas = areasBlock(), weedMix = null, planned = [], chinch, treatmentGuide = false, addOns = ADD_ONS } = {}) => context({
  spotRules: true,
  ...(troubleAreas ? { troubleAreas } : {}),
  ...(treatmentGuide ? { treatmentGuide: true } : {}),
  plannedProducts: { source: 'plan', items: planned, addOns, month: 10, ...(weedMix ? { weedMix } : {}), ...(chinch ? { chinch } : {}) },
});
const open = (ctx) => openSheet({ request: makeRequest({ ctx }), props: { catalog: CAT } });
const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });
const sent = (id) => completeCalls()[0].body.products.find((p) => p.productId === id);
const placeGroup = (name) => screen.getByRole('group', { name });
const chipOf = (group, label) => within(group).getByRole('button', { name: label });
const pressed = (group) => within(group).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const addFungicide = () => fireEvent.click(within(addons()).getByRole('button', { name: 'Add Spot Fungicide' }));
const typeArea = (group, size) => fireEvent.click(within(group).getByRole('button', { name: `${size} sq ft` }));

describe('a place on every spot row', () => {
  test('no troubleAreas in the context (gate off, older server): no place anywhere, and the body carries none', async () => {
    await open(placeContext({ troubleAreas: null }));
    addFungicide();
    typeArea(screen.getByRole('group', { name: 'Spot Fungicide' }), '100');
    expect(screen.queryByText('Where on the lawn')).toBeNull();
    await analyzeAndComplete();
    expect(sent(P_FUNG)).not.toHaveProperty('areaPlace');
    expect(sent(P_FUNG)).not.toHaveProperty('troubleType');
  });

  test('a spot row asks WHERE in one tap, and Complete waits for it the way it waits for the area', async () => {
    await open(placeContext());
    addFungicide();
    const row = placeGroup('Spot Fungicide');
    typeArea(row, '100');
    // The place group sits under the area, one chip per place of the server's closed list.
    const where = within(row).getByRole('group', { name: 'Place for Spot Fungicide' });
    expect(within(where).getAllByRole('button').map((b) => b.textContent)).toEqual(['Front', 'Back', 'Left side', 'Right side']);
    await analyze();
    await waitFor(() => expect(footerNote() || completeButton().textContent).toMatch(/Pick where on the lawn Spot Fungicide went\./));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(chipOf(where, 'Left side'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_FUNG)).toMatchObject({ applicationMethod: 'spot_treatment', areaPlace: 'left_side', areaValue: 100, areaUnit: 'sqft', troubleType: 'fungus', troubleSource: 'tech_tap' });
  });

  test('a whole-lawn row asks for no place and sends none', async () => {
    await open(placeContext({ planned: [PLANNED[0]] }));
    expect(screen.queryByText('Where on the lawn')).toBeNull();
    await analyzeAndComplete();
    expect(sent(P_TALAK)).not.toHaveProperty('areaPlace');
  });

  test('the place can be changed with one tap', async () => {
    await open(placeContext());
    addFungicide();
    const row = placeGroup('Spot Fungicide');
    typeArea(row, '100');
    const where = within(row).getByRole('group', { name: 'Place for Spot Fungicide' });
    fireEvent.click(chipOf(where, 'Front'));
    expect(pressed(where)).toEqual(['Front']);
    fireEvent.click(chipOf(where, 'Right side'));
    expect(pressed(where)).toEqual(['Right side']);
    await analyzeAndComplete();
    expect(sent(P_FUNG).areaPlace).toBe('right_side');
  });
});

describe('a known trouble area', () => {
  test('the lawn\'s single known area of the row\'s type is the default place: no extra tap, and the tech can change it', async () => {
    await open(placeContext({ troubleAreas: areasBlock({ known: [KNOWN_FUNGUS_BACK] }) }));
    addFungicide();
    const row = placeGroup('Spot Fungicide');
    typeArea(row, '100');
    const where = within(row).getByRole('group', { name: 'Place for Spot Fungicide' });
    expect(pressed(where)).toEqual(['Back · known']);
    expect(within(where).getByText('Set from the known trouble area. Tap another place to change it.')).toBeTruthy();
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_FUNG)).toMatchObject({ areaPlace: 'back', troubleType: 'fungus' });
  });

  test('two known areas of the type, or one of another type, choose nothing for the tech', async () => {
    await open(placeContext({ troubleAreas: areasBlock({ known: [KNOWN_FUNGUS_BACK, { ...KNOWN_FUNGUS_BACK, id: 'area-2', place: 'front', placeLabel: 'Front' }, { ...KNOWN_FUNGUS_BACK, id: 'area-3', place: 'left_side', type: 'weeds', typeLabel: 'Weeds' }] }) }));
    addFungicide();
    const where = within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' });
    expect(pressed(where)).toEqual([]);
  });

  test('the line shows place, type and the last treatment; Clear asks once, then the area is gone', async () => {
    const request = makeRequest({ ctx: placeContext({ troubleAreas: areasBlock({ known: [KNOWN_FUNGUS_BACK] }) }) });
    await openSheet({ request, props: { catalog: CAT } });
    const line = screen.getByRole('group', { name: 'Known trouble areas' });
    expect(within(line).getByText('Back · Fungus')).toBeTruthy();
    expect(within(line).getByText('Last treated Sep 12')).toBeTruthy();
    fireEvent.click(within(line).getByRole('button', { name: 'Clear Back, fungus' }));
    expect(within(line).getByText('Clear Back, fungus?')).toBeTruthy();
    // Keep puts it back without a request.
    fireEvent.click(within(line).getByRole('button', { name: 'Keep' }));
    expect(requests.some((r) => r.path.includes('/trouble-areas/'))).toBe(false);
    fireEvent.click(within(line).getByRole('button', { name: 'Clear Back, fungus' }));
    fireEvent.click(within(line).getByRole('button', { name: 'Confirm clear Back, fungus' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Known trouble areas' })).toBeNull());
    expect(requests.filter((r) => r.path.includes('/trouble-areas/'))).toEqual([expect.objectContaining({ path: '/admin/dispatch/svc-lawn/lawn-fast/trouble-areas/area-1/clear', options: expect.objectContaining({ method: 'POST' }) })]);
  });

  test('a clear the server refuses leaves the area and says so', async () => {
    const request = vi.fn(async (path, options = {}) => {
      if (path.includes('/trouble-areas/')) throw refusal(404, 'trouble_area_not_found', 'That trouble area is not on this lawn.');
      return makeRequest({ ctx: placeContext({ troubleAreas: areasBlock({ known: [KNOWN_FUNGUS_BACK] }) }) })(path, options);
    });
    await openSheet({ request, props: { catalog: CAT } });
    const line = screen.getByRole('group', { name: 'Known trouble areas' });
    fireEvent.click(within(line).getByRole('button', { name: 'Clear Back, fungus' }));
    fireEvent.click(within(line).getByRole('button', { name: 'Confirm clear Back, fungus' }));
    await within(line).findByText('Could not clear it. Try again.');
    expect(within(line).getByText('Back · Fungus')).toBeTruthy();
  });

  test('no known area and no read failure: no line; a failed read says so', async () => {
    await open(placeContext());
    expect(screen.queryByRole('group', { name: 'Known trouble areas' })).toBeNull();
    cleanup();
    await open(placeContext({ troubleAreas: areasBlock({ knownUnavailable: true }) }));
    expect(within(screen.getByRole('group', { name: 'Known trouble areas' })).getByText('The known trouble areas could not be loaded.')).toBeTruthy();
  });
});

describe('the yearly limits close a place', () => {
  const CLOSED = (extra = {}) => areasBlock({ blocked: { [P_FUNG]: { front: 'Spot Fungicide: 2/2 applications this year — LIMIT REACHED.' } }, ...extra });

  test('a closed place is off for the row, with the limit\'s own words; the other places stay', async () => {
    await open(placeContext({ troubleAreas: CLOSED() }));
    addFungicide();
    const where = within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' });
    expect(chipOf(where, 'Front').disabled).toBe(true);
    expect(chipOf(where, 'Back').disabled).toBe(false);
  });

  test('a known area at a closed place is not the default (the open place stays the tech\'s choice)', async () => {
    await open(placeContext({ troubleAreas: CLOSED({ known: [{ ...KNOWN_FUNGUS_BACK, place: 'front', placeLabel: 'Front' }] }) }));
    addFungicide();
    const where = within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' });
    expect(pressed(where)).toEqual([]);
  });

  test('a row with every place closed says it cannot go anywhere and holds Complete until it is removed', async () => {
    const every = Object.fromEntries(PLACE_LIST.map((place) => [place.id, 'Spot Fungicide: 2/2 applications this year — LIMIT REACHED.']));
    await open(placeContext({ troubleAreas: areasBlock({ blocked: { [P_FUNG]: every } }) }));
    addFungicide();
    const row = placeGroup('Spot Fungicide');
    typeArea(row, '100');
    expect(within(row).getByText(/Spot Fungicide cannot go anywhere on this lawn right now\. Spot Fungicide: 2\/2/)).toBeTruthy();
    await analyze();
    await waitFor(() => expect(footerNote() || completeButton().textContent).toMatch(/Remove Spot Fungicide: /));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Spot Fungicide' })).toBeNull();
  });

  test('the server\'s own refusal of a place reads as the server worded it and the sheet stays editable', async () => {
    await open(placeContext());
    addFungicide();
    const row = placeGroup('Spot Fungicide');
    typeArea(row, '100');
    fireEvent.click(chipOf(within(row).getByRole('group', { name: 'Place for Spot Fungicide' }), 'Front'));
    completeErrors.push(refusal(400, 'lawn_place_limit', 'Spot Fungicide: 2/2 applications this year — LIMIT REACHED. Choose another place, or take it off the sheet.'));
    await analyze();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    await screen.findByText(/Choose another place, or take it off the sheet\./);
    // A correctable refusal: pick another place and complete again.
    fireEvent.click(chipOf(within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' }), 'Back'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.products.find((p) => p.productId === P_FUNG).areaPlace).toBe('back');
  });
});

describe('Weed spots: the entry is one tap per place', () => {
  const CHOICES = (byPlace, top) => placeContext({ weedMix: MIX(byPlace, top) });
  const addWeedAt = (label) => fireEvent.click(within(addons()).getByRole('button', { name: `Add weed spots: ${label}` }));

  test('every place open: one button per place, and the tap adds the mix AND names the place (no extra tap)', async () => {
    await open(CHOICES(ALL(LEAD_SET)));
    const group = within(addons()).getByRole('group', { name: 'Add weed spots place' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Front', 'Back', 'Left side', 'Right side']);
    addWeedAt('Back');
    for (const name of ['Lead WG', 'Cert Herbicide', 'Tank Surfactant']) expect(within(editorFor(name)).getByText(/from the protocol/)).toBeTruthy();
    // The one shared control for the rows says where.
    expect(pressed(screen.getByRole('group', { name: 'Weed spots place' }))).toEqual(['Back']);
    expect(within(addons()).getByRole('button', { name: 'Weed spots are on the sheet' }).disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '500 sq ft' }));
    await analyzeAndComplete();
    for (const id of [P_LEAD, P_CERT, P_SURF]) expect(sent(id)).toMatchObject({ areaPlace: 'back', troubleType: 'weeds', troubleSource: 'tech_tap' });
  });

  test('a place at the lead\'s limit takes the replacement; the others take the lead; the line says which place', async () => {
    await open(CHOICES({ ...ALL(LEAD_SET), front: BLIND_SET }));
    expect(within(addons()).getByText(/Front: Lead yearly limit reached; Blind is used in its place\./)).toBeTruthy();
    addWeedAt('Front');
    expect(screen.getByRole('group', { name: 'Blind Herbicide' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Lead WG' })).toBeNull();
    expect(pressed(screen.getByRole('group', { name: 'Weed spots place' }))).toEqual(['Front']);
  });

  test('the place chips of the rows follow the server: a place that does not take the rows on the sheet is off', async () => {
    await open(CHOICES({ ...ALL(LEAD_SET), front: BLIND_SET }));
    addWeedAt('Back');
    const where = screen.getByRole('group', { name: 'Weed spots place' });
    expect(chipOf(where, 'Back').disabled).toBe(false);
    expect(chipOf(where, 'Front').disabled).toBe(true);
    expect(within(where).queryByText(/./, { selector: '[role="status"]' })).toBeNull();
    fireEvent.click(chipOf(where, 'Right side'));
    expect(pressed(where)).toEqual(['Right side']);
  });

  test('a place at the limit for both is not offered; with every place closed the entry is a line only', async () => {
    await open(CHOICES({ ...ALL(LEAD_SET), left_side: NONE_SET }));
    const group = within(addons()).getByRole('group', { name: 'Add weed spots place' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Front', 'Back', 'Right side']);
    expect(within(addons()).getByText(/Left side: The yearly weed-spray limit is reached for this lawn\./)).toBeTruthy();
    cleanup();
    await open(CHOICES(ALL(NONE_SET), NONE_SET));
    expect(within(addons()).getByText('The yearly weed-spray limit is reached for this lawn.')).toBeTruthy();
    expect(within(addons()).queryByRole('button', { name: /weed spots/i })).toBeNull();
  });

  test('a known weed area leads the buttons and is marked', async () => {
    await open(placeContext({ weedMix: MIX(ALL(LEAD_SET)), troubleAreas: areasBlock({ known: [{ ...KNOWN_FUNGUS_BACK, type: 'weeds', typeLabel: 'Weeds', place: 'right_side', placeLabel: 'Right side' }] }) }));
    const group = within(addons()).getByRole('group', { name: 'Add weed spots place' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Right side · known', 'Front', 'Back', 'Left side']);
  });

  test('no byPlace on the mix (the guide answer without places): the one tap as before, and the rows ask for their place on the shared control', async () => {
    await open(placeContext({ weedMix: { ...LEAD_SET, groupProductIds: [P_LEAD, P_CERT, P_SURF, P_BLIND], replacementProductId: P_BLIND, noAreaProductIds: [P_SURF] } }));
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add weed spots' }));
    const where = screen.getByRole('group', { name: 'Weed spots place' });
    expect(pressed(where)).toEqual([]);
    fireEvent.click(chipOf(where, 'Front'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Weed spots' })).getByRole('button', { name: '500 sq ft' }));
    await analyzeAndComplete();
    expect(sent(P_LEAD).areaPlace).toBe('front');
  });

  test('the surfactant rides the weed place: no place of its own to pick', async () => {
    await open(CHOICES(ALL(LEAD_SET)));
    addWeedAt('Back');
    expect(within(editorFor('Tank Surfactant')).queryByText('Where on the lawn')).toBeNull();
    expect(screen.getAllByText('Where on the lawn')).toHaveLength(1);
  });
});

describe('Chinch bugs found: the entry is one tap per place', () => {
  const CAP_NOTE = 'Arena yearly limit reached; Atticus is used in its place.';
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const BIF_ITEM = { productId: P_BIF, name: 'Atticus Talak 7.9 F', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: null, rateUnit: null, gateNotes: [] };
  const CHINCH = {
    item: BIF_ITEM, note: CAP_NOTE, rungIds: [P_ARENA, P_BIF], unreadableIds: [],
    byPlace: {
      front: { item: BIF_ITEM, note: CAP_NOTE, unreadableIds: [] },
      back: { item: ARENA_ITEM, note: null, unreadableIds: [] },
      left_side: { item: ARENA_ITEM, note: null, unreadableIds: [] },
      right_side: { item: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.', unreadableIds: [] },
    },
  };
  const openChinch = async (chinch = CHINCH, troubleAreas = areasBlock()) => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [] };
    await open(placeContext({ treatmentGuide: true, chinch, troubleAreas }));
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
  };

  test('the buttons are the places that have a product; the tap adds the product that place takes and names the place', async () => {
    await openChinch();
    const group = within(addons()).getByRole('group', { name: 'Add chinch bug treatment place' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Front', 'Back', 'Left side']);
    expect(within(addons()).getByText(/Right side: The yearly limit is reached for the chinch bug products on this lawn\./)).toBeTruthy();
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment: Front' }));
    const row = screen.getByRole('group', { name: 'Atticus Talak 7.9 F' });
    expect(pressed(within(row).getByRole('group', { name: 'Place for Atticus Talak 7.9 F' }))).toEqual(['Front']);
    expect(within(addons()).getByRole('button', { name: 'Chinch bug treatment is on the sheet' }).disabled).toBe(true);
    typeArea(row, '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_BIF)).toMatchObject({ areaPlace: 'front', troubleType: 'chinch', troubleSource: 'tech_tap' });
  });

  test('on the sheet at one place, the row cannot be moved to a place that takes the other product', async () => {
    await openChinch();
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment: Back' }));
    const where = within(screen.getByRole('group', { name: 'Arena 50 WDG' })).getByRole('group', { name: 'Place for Arena 50 WDG' });
    expect(chipOf(where, 'Front').disabled).toBe(true);
    expect(chipOf(where, 'Right side').disabled).toBe(true);
    expect(chipOf(where, 'Left side').disabled).toBe(false);
    fireEvent.click(chipOf(where, 'Left side'));
    expect(pressed(where)).toEqual(['Left side']);
  });
});

// ── reachability: place A is capped, place B is open ────────────────────────────────────────────────────────
// For every guided or standing way a spot treatment gets onto the sheet, with the front closed for the product (or the
// front needing a different product) and the back open, the tech reaches the back treatment in the counted taps, the front
// cannot be chosen for a closed product, and the completion carries the back. (/complete accepting the back and refusing the
// front is proven against Postgres in lawn-trouble-areas.db.test.js, one row per product kind.)
describe('reachability: the front is capped, the back is open', () => {
  const P_CATER = 'dddddddd-0000-4000-8000-000000000001';
  const P_DISP = 'dddddddd-0000-4000-8000-000000000002';
  const CAT2 = [
    ...CAT,
    { id: P_CATER, name: 'Cater Insecticide', category: 'insecticide', formulation: 'SC', default_rate_per_1000: 0.07, default_unit: 'fl_oz' },
    { id: P_DISP, name: 'Disp Wetting Agent', category: 'adjuvant', formulation: 'SL', default_rate_per_1000: 1, default_unit: 'fl_oz' },
  ];
  const ALL_ADDONS = [...ADD_ONS, addOn(P_CATER, 'Cater Insecticide', { line: 'Cater Insecticide — caterpillars' }), addOn(P_DISP, 'Disp Wetting Agent')];
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const BIF_ITEM = { productId: P_BIF, name: 'Atticus Talak 7.9 F', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: null, rateUnit: null, gateNotes: [] };
  const CHINCH = {
    item: BIF_ITEM, note: 'Arena yearly limit reached; Atticus is used in its place.', rungIds: [P_ARENA, P_BIF], unreadableIds: [],
    byPlace: { front: { item: BIF_ITEM, note: null, unreadableIds: [] }, back: { item: ARENA_ITEM, note: null, unreadableIds: [] } },
  };
  const card = (kind, extra = {}) => ({ kind, title: kind, finding: `Finding for ${kind}.`, check: null, detail: null, note: null, productIds: [], items: [], actionLabel: 'Add it', dismissLabel: null, ...extra });
  const setOf = (items) => ({ productIds: items.map((i) => i.productId), names: items.map((i) => i.name), items, note: null });
  const LEAD_ITEMS = [ADD_ONS[0], ADD_ONS[1], ADD_ONS[2]];
  const WEEDS_CARD = () => card('weeds', {
    title: 'Weed spots', productIds: LEAD_ITEMS.map((i) => i.productId), items: LEAD_ITEMS, actionLabel: 'Add weed spots',
    byPlace: { front: setOf([ADD_ONS[3]]), back: setOf(LEAD_ITEMS) },
  });
  const CHINCH_CARD = () => card('chinch', {
    title: 'Insects: check for chinch bugs', productIds: [P_BIF], items: [BIF_ITEM], actionLabel: 'Found at the edge. Add it', dismissLabel: 'Nothing found',
    byPlace: { front: setOf([BIF_ITEM]), back: setOf([ARENA_ITEM]) },
  });
  const SINGLE = (kind, item, label) => card(kind, { title: kind, productIds: [item.productId], items: [item], actionLabel: label, dismissLabel: 'Nothing found' });
  const closedFront = (...ids) => areasBlock({ blocked: Object.fromEntries(ids.map((id) => [id, { front: 'Closed up front — LIMIT REACHED.' }])) });
  const guided = (cards, extra = {}) => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards, ...(extra.weedMix ? { weedMix: extra.weedMix } : {}), ...(extra.chinch ? { chinch: extra.chinch } : {}) };
    return placeContext({ treatmentGuide: true, addOns: ALL_ADDONS, ...extra, troubleAreas: extra.troubleAreas || areasBlock() });
  };
  let taps;
  const tap = (el) => { taps += 1; fireEvent.click(el); };
  const group = (name) => screen.getByRole('group', { name });
  const inSuggested = () => within(group('Suggested from this lawn'));

  // [label, context, reach(), rows reached, expected taps, chip check (a closed place is off), the row that carries the place chips]
  const CASES = [
    ['Weed spots entry', () => placeContext({ addOns: ALL_ADDONS, weedMix: MIX({ front: BLIND_SET, back: LEAD_SET, left_side: LEAD_SET, right_side: LEAD_SET }) }),
      () => tap(within(addons()).getByRole('button', { name: 'Add weed spots: Back' })), ['Lead WG', 'Cert Herbicide', 'Tank Surfactant'], 1, null],
    ['weeds card', () => guided([WEEDS_CARD()], { weedMix: MIX({ front: BLIND_SET, back: LEAD_SET }), troubleAreas: areasBlock() }),
      () => tap(inSuggested().getByRole('button', { name: 'Add weed spots: Back' })), ['Lead WG', 'Cert Herbicide', 'Tank Surfactant'], 1, null],
    ['chinch entry', () => guided([], { chinch: CHINCH }),
      () => tap(within(addons()).getByRole('button', { name: 'Add chinch bug treatment: Back' })), ['Arena 50 WDG'], 1, null],
    ['chinch card', () => guided([CHINCH_CARD()], { chinch: CHINCH }),
      () => tap(inSuggested().getByRole('button', { name: 'Found at the edge. Add it: Back' })), ['Arena 50 WDG'], 1, null],
    ['fungus card', () => guided([SINGLE('fungus', ADD_ONS[4], 'I checked. Add it')], { troubleAreas: closedFront(P_FUNG) }),
      () => { tap(inSuggested().getByRole('button', { name: 'I checked. Add it' })); tap(chipOf(placeGroup('Spot Fungicide'), 'Back')); }, ['Spot Fungicide'], 2, 'Spot Fungicide'],
    ['caterpillar card', () => guided([SINGLE('caterpillars', ALL_ADDONS[5], 'Found them. Add it')], { troubleAreas: closedFront(P_CATER) }),
      () => { tap(inSuggested().getByRole('button', { name: 'Found them. Add it' })); tap(chipOf(placeGroup('Cater Insecticide'), 'Back')); }, ['Cater Insecticide'], 2, 'Cater Insecticide'],
    ['dry-spot card', () => guided([SINGLE('dry_spots', ALL_ADDONS[6], 'Add Disp Wetting Agent')], { troubleAreas: closedFront(P_DISP) }),
      () => { tap(inSuggested().getByRole('button', { name: 'Add Disp Wetting Agent' })); tap(chipOf(placeGroup('Disp Wetting Agent'), 'Back')); }, ['Disp Wetting Agent'], 2, 'Disp Wetting Agent'],
    ['search-added spot row', () => placeContext({ addOns: [], troubleAreas: closedFront(P_FUNG) }),
      // A search-added fungicide starts on its category's default method; the tech sets Spot treatment, then the place.
      async () => {
        fireEvent.change(await screen.findByLabelText('Search products'), { target: { value: 'Spot Fungicide' } });
        tap(await screen.findByRole('button', { name: /Spot Fungicide/ }));
        const method = within(placeGroup('Spot Fungicide')).getByRole('combobox', { name: /^Method for / });
        taps += 1;
        fireEvent.change(method, { target: { value: [...method.options].find((o) => o.textContent === 'Spot treatment').value } });
        tap(chipOf(placeGroup('Spot Fungicide'), 'Back'));
      }, ['Spot Fungicide'], 3, 'Spot Fungicide'],
  ];

  test.each(CASES)('%s', async (_label, build, reach, rowNames, expectedTaps, chipRow) => {
    taps = 0;
    await openSheet({ request: makeRequest({ ctx: build() }), props: { catalog: CAT2 } });
    await analyze();
    if (_label.includes('card')) await screen.findByRole('group', { name: 'Suggested from this lawn' });
    await reach();
    // The back treatment is on the sheet, in the counted taps, on the back.
    expect(taps).toBe(expectedTaps);
    for (const name of rowNames) expect(screen.getByRole('group', { name })).toBeTruthy();
    const chinch = _label.includes('chinch');
    const where = chinch ? within(group('Arena 50 WDG')).getByRole('group', { name: 'Place for Arena 50 WDG' }) : group(chipRow ? `Place for ${chipRow}` : 'Weed spots place');
    expect(pressed(where)).toEqual(['Back']);
    // A product the front is closed for cannot be put on the front.
    if (chipRow) expect(chipOf(where, 'Front').disabled).toBe(true);
    // The completion carries the back, and nothing at the front.
    typeAreaFor(rowNames);
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    const body = completeCalls()[0].body.products;
    expect(body.map((p) => p.areaPlace)).toEqual(rowNames.map(() => 'back'));
  });

  // The completion's guide record carries the set of the place the tech took (a flat list of the ids added) and the place.
  describe('the guide record names the place taken and the products actually added', () => {
    const recordOf = (kind) => completeCalls()[0].body.lawnFast.treatmentGuide.cards.find((c) => c.kind === kind);
    const take = async (build, tapName, rowNames) => {
      taps = 0;
      await openSheet({ request: makeRequest({ ctx: build() }), props: { catalog: CAT2 } });
      await analyze();
      await screen.findByRole('group', { name: 'Suggested from this lawn' });
      if (tapName) fireEvent.click(inSuggested().getByRole('button', { name: tapName }));
      typeAreaFor(rowNames);
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
    };

    test('weeds card, the front (the replacement) and the back (the lead mix) each record their own set and place', async () => {
      const ctx = () => guided([WEEDS_CARD()], { weedMix: MIX({ front: BLIND_SET, back: LEAD_SET }), troubleAreas: areasBlock() });
      await take(ctx, 'Add weed spots: Front', ['Blind Herbicide']);
      expect(recordOf('weeds')).toEqual({ kind: 'weeds', shown: true, checked: null, taken: true, productIds: [P_BLIND], place: 'front' });
      cleanup(); requests = [];
      await take(ctx, 'Add weed spots: Back', ['Lead WG', 'Cert Herbicide', 'Tank Surfactant']);
      expect(recordOf('weeds')).toEqual({ kind: 'weeds', shown: true, checked: null, taken: true, productIds: [P_LEAD, P_CERT, P_SURF], place: 'back' });
    });

    test('chinch card: the product of the chosen place and the place', async () => {
      await take(() => guided([CHINCH_CARD()], { chinch: CHINCH }), 'Found at the edge. Add it: Back', ['Arena 50 WDG']);
      expect(recordOf('chinch')).toMatchObject({ taken: true, productIds: [P_ARENA], place: 'back' });
    });

    test('a card not taken records what it offered, with no place', async () => {
      taps = 0;
      await openSheet({ request: makeRequest({ ctx: guided([WEEDS_CARD()], { weedMix: MIX({ front: BLIND_SET, back: LEAD_SET }), planned: [PLANNED[0]] }) }), props: { catalog: CAT2 } });
      await analyze();
      await screen.findByRole('group', { name: 'Suggested from this lawn' });
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      expect(recordOf('weeds')).toEqual({ kind: 'weeds', shown: true, checked: null, taken: false, productIds: [P_LEAD, P_CERT, P_SURF] });
    });
  });

  function typeAreaFor(rowNames) {
    const weed = rowNames.includes('Lead WG') || rowNames.includes('Blind Herbicide');
    typeArea(weed ? group('Weed spots') : placeGroup(rowNames[0]), weed ? '500' : '100');
  }
});

// ── reconciliation keeps a row whose limit could not be read at SOME place ──────────────────────────────────────
// The guide's fresh answer follows one place at the top level. A product unreadable at any place stays released to the search
// and is never dropped by reconciliation; without that, the same row is dropped as "not offered".
describe('reconciliation: a product unreadable at one place stays on the sheet', () => {
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const BIF_ITEM = { productId: P_BIF, name: 'Atticus Talak 7.9 F', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: null, rateUnit: null, gateNotes: [] };
  const FRESH_CHINCH = (unreadableIds) => ({
    item: BIF_ITEM, note: null, rungIds: [P_ARENA, P_BIF], blockedIds: [], unreadableIds,
    byPlace: {
      front: { item: BIF_ITEM, note: null, unreadableIds: [] },
      back: { item: null, note: 'The limits could not be checked. Use Search products for what you applied; the office will review it.', unreadableIds: [P_ARENA] },
    },
  });
  const openWithArenaRow = async (fresh) => {
    // Arena is a planned row; the sheet opened with the context's own chinch decision.
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], chinch: fresh };
    await open(placeContext({
      treatmentGuide: true, chinch: FRESH_CHINCH([]), planned: [{ ...ARENA_ITEM, treatedSqft: null }], addOns: [],
    }));
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
  };

  test('Arena unreadable at the back (top-level unreadableIds): the row stays, nothing is removed', async () => {
    await openWithArenaRow(FRESH_CHINCH([P_ARENA]));
    expect(screen.getByRole('group', { name: 'Arena 50 WDG' })).toBeTruthy();
    expect(screen.queryByText(/^Removed:/)).toBeNull();
    // Reconciliation and the Complete hold read the same "not offered" test: this row is not held either.
    expect(footerNote() + completeButton().textContent).not.toMatch(/Remove Arena 50 WDG/);
    // The place note for a place whose read failed: allowed, recorded, flagged.
    const where = within(screen.getByRole('group', { name: 'Arena 50 WDG' })).getByRole('group', { name: 'Place for Arena 50 WDG' });
    expect(chipOf(where, 'Back').disabled).toBe(false);
  });

  test('the same answer without the unreadable id drops the row (proving the test can fail): Complete is held on the row', async () => {
    await openWithArenaRow(FRESH_CHINCH([]));
    // The first answer reconciles nothing (the taps were locked until it came); the same test holds Complete on the row.
    await waitFor(() => expect(footerNote() + completeButton().textContent).toMatch(/Remove Arena 50 WDG: it is not offered for this lawn right now\./));
  });

  test('the weed mix: a member unreadable at a place the top level does not follow is searchable and kept', async () => {
    const mix = MIX({ front: BLIND_SET, back: { mode: 'unavailable', productIds: [], note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.', surfactant: null, tempF: null, blockedIds: [] } }, BLIND_SET);
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], weedMix: { ...mix, unreadableIds: [P_LEAD, P_CERT, P_SURF, P_BLIND] } };
    await open(placeContext({ treatmentGuide: true, weedMix: MIX({ front: BLIND_SET, back: LEAD_SET }, LEAD_SET), planned: [addOn(P_LEAD, 'Lead WG', { amount: 1, amountUnit: 'oz' })], addOns: ADD_ONS }));
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
    expect(screen.getByRole('group', { name: 'Lead WG' })).toBeTruthy();
    expect(screen.queryByText(/^Removed:/)).toBeNull();
    fireEvent.change(await screen.findByLabelText('Search products'), { target: { value: 'Cert Herbicide' } });
    expect(await screen.findByRole('button', { name: /Cert Herbicide/ })).toBeTruthy();
  });
});

// ── a ladder or group product that stays on the sheet as a planned row ───────────────────────────────────────────
describe('a planned Arena or Celsius row is judged by the per-place decision', () => {
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const BIF_ITEM = { productId: P_BIF, name: 'Atticus Talak 7.9 F', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: null, rateUnit: null, gateNotes: [] };
  const CHINCH = {
    item: BIF_ITEM, note: 'Arena yearly limit reached; Atticus is used in its place.', rungIds: [P_ARENA, P_BIF], blockedIds: [], unreadableIds: [],
    byPlace: {
      front: { item: BIF_ITEM, note: 'Arena yearly limit reached; Atticus is used in its place.', unreadableIds: [], blockedIds: [P_ARENA] },
      back: { item: ARENA_ITEM, note: null, unreadableIds: [], blockedIds: [] },
    },
  };

  test('Arena planned (no entry tag): the front is off, the back is open; Talak planned: both open', async () => {
    await open(placeContext({ treatmentGuide: true, chinch: CHINCH, planned: [ARENA_ITEM, BIF_ITEM], addOns: [] }));
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], chinch: CHINCH };
    const arena = within(placeGroup('Arena 50 WDG')).getByRole('group', { name: 'Place for Arena 50 WDG' });
    expect(chipOf(arena, 'Front').disabled).toBe(true);
    expect(chipOf(arena, 'Back').disabled).toBe(false);
    const talak = within(placeGroup('Atticus Talak 7.9 F')).getByRole('group', { name: 'Place for Atticus Talak 7.9 F' });
    expect(chipOf(talak, 'Front').disabled).toBe(false);
    expect(chipOf(talak, 'Back').disabled).toBe(false);
  });

  test('Lead WG planned on its own: the place that takes the replacement is off, the lead\'s place is open', async () => {
    const mix = MIX({ front: BLIND_SET, back: LEAD_SET });
    await open(placeContext({ weedMix: mix, planned: [addOn(P_LEAD, 'Lead WG')], addOns: ADD_ONS }));
    const lead = within(placeGroup('Lead WG')).getByRole('group', { name: 'Place for Lead WG' });
    expect(chipOf(lead, 'Front').disabled).toBe(true);
    expect(chipOf(lead, 'Back').disabled).toBe(false);
  });
});


// ── the place maps are read again: with the guide's answer, and after /complete refuses a place ──────────────────
describe('the guide answer carries the fresh per-place blocks; a refused place refreshes them', () => {
  const FUNG_ITEM = ADD_ONS[4];
  const fungusCard = () => ({ kind: 'fungus', title: 'Fungus', finding: 'Finding for fungus.', check: null, detail: null, note: null, productIds: [P_FUNG], items: [FUNG_ITEM], actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found' });
  const closedFront = { [P_FUNG]: { front: 'Spot Fungicide: 2/2 applications this year — LIMIT REACHED.' } };
  const ctxWith = (blocked) => placeContext({ treatmentGuide: true, addOns: ADD_ONS, troubleAreas: areasBlock({ blocked }) });
  const guideWith = (placeBlocked) => ({ enabled: true, v: 1, assessmentId: 'assessment-1', cards: [fungusCard()], ...(placeBlocked ? { placeBlocked } : {}) });
  const chipsOf = () => within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' });
  const openAndTake = async (ctx) => {
    await open(ctx);
    await analyze();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
  };

  test('a limit that changed since the sheet opened: a place the guide read open is open, though the opening map had it closed', async () => {
    guideAnswer = guideWith({ [P_FUNG]: {} });
    await openAndTake(ctxWith(closedFront));
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(false);
  });

  test('a place newly capped: the guide\'s map closes it though the opening map had it open', async () => {
    guideAnswer = guideWith(closedFront);
    await openAndTake(ctxWith({}));
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    expect(chipOf(chipsOf(), 'Back').disabled).toBe(false);
  });

  test('an answer without the map, and a guide read that fails, leave the opening map standing', async () => {
    guideAnswer = guideWith(null);
    await openAndTake(ctxWith(closedFront));
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    cleanup();
    guideAnswer = refusal(500, 'boom', 'Internal error');
    await open(ctxWith(closedFront));
    await analyze();
    await waitFor(() => expect(within(addons()).getByRole('button', { name: 'Add Spot Fungicide' })).toBeTruthy());
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add Spot Fungicide' }));
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
  });

  test('/complete refuses a place (400 lawn_place_limit): the context and the guide are read again, the chip closes, and the tech picks another place without reloading', async () => {
    let contextReads = 0;
    let guideReads = 0;
    const base = makeRequest({ ctx: ctxWith({}) });
    const request = vi.fn(async (path, options) => {
      if (path.includes('/lawn-fast/context')) { contextReads += 1; return contextReads === 1 ? ctxWith({}) : ctxWith(closedFront); }
      return base(path, options);
    });
    guideAnswer = () => { guideReads += 1; return guideWith(guideReads === 1 ? {} : closedFront); };
    await openSheet({ request, props: { catalog: CAT } });
    await analyze();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
    typeArea(placeGroup('Spot Fungicide'), '100');
    fireEvent.click(chipOf(chipsOf(), 'Front'));
    expect(contextReads).toBe(1);
    expect(guideReads).toBe(1);
    completeErrors.push(refusal(400, 'lawn_place_limit', 'Spot Fungicide: 2/2 applications this year — LIMIT REACHED. Choose another place, or take it off the sheet.'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    await screen.findByText(/Choose another place, or take it off the sheet\./);
    await waitFor(() => expect(contextReads).toBe(2));
    await waitFor(() => expect(guideReads).toBe(2));
    await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
    // The row still sits on Front (closed now): Complete says so; another place completes.
    await waitFor(() => expect(footerNote() + completeButton().textContent).toMatch(/Spot Fungicide cannot go on Front/));
    fireEvent.click(chipOf(chipsOf(), 'Back'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(2));
    expect(completeCalls()[1].body.products.find((p) => p.productId === P_FUNG).areaPlace).toBe('back');
  });

  // A failed re-read keeps the answer only while it belongs to the SAME confirmed assessment.
  describe('a failed guide re-read', () => {
    // Opens the sheet with a fungus card, takes it, and sends a completion the server refuses (400 lawn_place_limit), which re-reads the
    // context (now OPEN everywhere) and the guide. The first guide answer closes the front; `rereads` says what the second read does.
    const refuseOnce = async (rereads) => {
      let contextReads = 0;
      let guideReads = 0;
      const base = makeRequest({ ctx: ctxWith({}) });
      const request = vi.fn(async (path, options) => {
        if (path.includes('/lawn-fast/context')) { contextReads += 1; return ctxWith({}); }
        return base(path, options);
      });
      guideAnswer = () => { guideReads += 1; if (guideReads === 1) return guideWith(closedFront); return rereads(); };
      await openSheet({ request, props: { catalog: CAT } });
      await analyze();
      fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
      typeArea(placeGroup('Spot Fungicide'), '100');
      fireEvent.click(chipOf(chipsOf(), 'Back'));
      completeErrors.push(refusal(400, 'lawn_place_limit', 'Spot Fungicide: closed.'));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      await waitFor(() => expect(contextReads).toBe(2));
      await waitFor(() => expect(guideReads).toBe(2));
      return { guideReads: () => guideReads };
    };

    test('the same assessment: the answer the sheet has stands (its per-place blocks), though the fresh context says open', async () => {
      await refuseOnce(() => { throw refusal(500, 'boom', 'Internal error'); });
      // The context was re-read and says open; the guide's answer (the front closed) is the one that stays.
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
      expect(screen.getByRole('group', { name: 'Suggested from this lawn' })).toBeTruthy();
    });

    test('a new confirmed assessment after the refusal: a failed read drops the old answer; the sheet follows the context, and is not left waiting', async () => {
      await refuseOnce(() => guideWith(closedFront));
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
      // Retake, and confirm a different assessment; its guide read fails.
      fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
      await screen.findByTestId('lawn-shot-list');
      const NEXT = { ...ASSESSED, id: 'assessment-2' };
      assessAnswer = { ...assessAnswer, assessment: NEXT };
      confirmAnswer = { ...confirmAnswer, assessment: { ...NEXT, confirmed_by_tech: true } };
      guideAnswer = refusal(500, 'boom', 'Internal error');
      await analyze();
      // The old assessment's cards and per-place blocks are gone: no cards, the context's opening map (open), and no wait.
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Suggested from this lawn' })).toBeNull());
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(false));
      expect(footerNote() + completeButton().textContent).not.toMatch(/Wait for the lawn guide/);
    });
  });

  test('the refusal names the product and the place: the chip closes at once and stays closed, though the maps it reads again say open; the reads name the spot products on the sheet', async () => {
    const urls = [];
    const base = makeRequest({ ctx: ctxWith({}) });
    const request = vi.fn(async (path, options) => {
      urls.push(path);
      if (path.includes('/lawn-fast/context')) return ctxWith({});
      return base(path, options);
    });
    guideAnswer = guideWith({ [P_FUNG]: {} });
    await openSheet({ request, props: { catalog: CAT } });
    await analyze();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
    typeArea(placeGroup('Spot Fungicide'), '100');
    fireEvent.click(chipOf(chipsOf(), 'Front'));
    // Nothing is named before a refusal: the first reads are exactly what they always were.
    expect(urls.filter((u) => /productIds=/.test(u))).toEqual([]);
    completeErrors.push(Object.assign(refusal(400, 'lawn_place_limit', 'Spot Fungicide: LIMIT REACHED. Choose another place, or take it off the sheet.', { productId: P_FUNG.toUpperCase(), place: 'front' })));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
    // Both re-reads named the spot product on the sheet.
    await waitFor(() => expect(urls.filter((u) => u.includes(`productIds=${P_FUNG}`))).toHaveLength(2));
    expect(urls.some((u) => u.includes('/lawn-fast/context?productIds='))).toBe(true);
    expect(urls.some((u) => u.includes('/treatment-guide?assessmentId=assessment-1&productIds='))).toBe(true);
    // The maps said open (the guide's placeBlocked is empty): the refusal still holds.
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    expect(chipOf(chipsOf(), 'Back').disabled).toBe(false);
  });

  // A refusal of the yearly AMOUNT depends on the dose entered; a count or interval refusal does not.
  describe('what ends a refusal', () => {
    const refuseAt = async (limitType) => {
      const base = makeRequest({ ctx: ctxWith({}) });
      guideAnswer = guideWith({ [P_FUNG]: {} });
      await openSheet({ request: base, props: { catalog: CAT } });
      await analyze();
      fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
      typeArea(placeGroup('Spot Fungicide'), '100');
      fireEvent.click(chipOf(chipsOf(), 'Front'));
      completeErrors.push(refusal(400, 'lawn_place_limit', 'Spot Fungicide: refused.', { productId: P_FUNG, place: 'front', limitType }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
    };
    const amountBox = () => within(placeGroup('Spot Fungicide')).getByLabelText('Spot Fungicide');

    test('an amount refusal ends when the area changes (the figured amount changes with it)', async () => {
      await refuseAt('annual_max_rate');
      typeArea(placeGroup('Spot Fungicide'), '250');
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(false));
    });

    test('an amount refusal ends when the tech types a different amount', async () => {
      await refuseAt('annual_max_rate');
      fireEvent.change(amountBox(), { target: { value: '0.5' } });
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(false));
    });

    test('an amount refusal stays while the dose is unchanged, though the maps it reads again say open', async () => {
      await refuseAt('annual_max_rate');
      // A re-read already happened after the refusal and said open (guideWith({[P_FUNG]: {}})): the refusal still holds.
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
      // Picking another place and back does not change the dose either.
      fireEvent.click(chipOf(chipsOf(), 'Back'));
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    });

    test.each(['annual_max_apps', 'min_interval_days'])('a %s refusal does not end when the area or the amount changes', async (limitType) => {
      await refuseAt(limitType);
      typeArea(placeGroup('Spot Fungicide'), '250');
      fireEvent.change(amountBox(), { target: { value: '0.5' } });
      typeArea(placeGroup('Spot Fungicide'), '500');
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    });
  });

  // A block that arrives in a MAP (the opening context, the re-read context, the guide's answer) carries its limit type too: the
  // yearly amount was judged at the program dose, so it ends when the row's dose changes; a count or an interval block does not.
  describe('what ends a block read from a map', () => {
    const MESSAGE = 'Spot Fungicide: LIMIT REACHED at the front.';
    const mapped = (limitType) => ({ blocked: { [P_FUNG]: { front: MESSAGE } }, blockedTypes: { [P_FUNG]: { front: limitType } } });
    const guideMapped = (limitType) => ({ ...guideWith({ [P_FUNG]: { front: MESSAGE } }), placeBlockedTypes: { [P_FUNG]: { front: limitType } } });
    const amountBox = () => within(placeGroup('Spot Fungicide')).getByLabelText('Spot Fungicide');
    const takeFungus = async () => {
      await openSheet({ request: makeRequest({ ctx: placeContext({ treatmentGuide: true, addOns: ADD_ONS, troubleAreas: areasBlock(mapped(limitTypeUnderTest)) }) }), props: { catalog: CAT } });
      await analyze();
      fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
      typeArea(placeGroup('Spot Fungicide'), '100');
    };
    let limitTypeUnderTest;

    test.each([
      ['the area', () => typeArea(placeGroup('Spot Fungicide'), '250')],
      ['the amount', () => fireEvent.change(amountBox(), { target: { value: '0.5' } })],
    ])('an amount block in the opening and guide maps ends when %s of its row changes', async (_name, change) => {
      limitTypeUnderTest = 'annual_max_rate';
      guideAnswer = guideMapped('annual_max_rate');
      await takeFungus();
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
      change();
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(false));
      expect(chipOf(chipsOf(), 'Back').disabled).toBe(false);
    });

    test.each(['annual_max_apps', 'min_interval_days'])('a %s block in the maps stays closed when the dose changes', async (limitType) => {
      limitTypeUnderTest = limitType;
      guideAnswer = guideMapped(limitType);
      await takeFungus();
      typeArea(placeGroup('Spot Fungicide'), '250');
      fireEvent.change(amountBox(), { target: { value: '0.5' } });
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    });

    test('a map without limit types (an older answer) never ends on a dose change', async () => {
      limitTypeUnderTest = undefined;
      guideAnswer = guideWith({ [P_FUNG]: { front: MESSAGE } });
      await takeFungus();
      typeArea(placeGroup('Spot Fungicide'), '250');
      expect(chipOf(chipsOf(), 'Front').disabled).toBe(true);
    });

    // The re-read after a refusal judges the program dose and can put the very product and place into the maps it returns.
    test.each([
      ['annual_max_rate', false],
      ['annual_max_apps', true],
    ])('a %s refusal whose re-read maps carry the block too: after a dose change the chip is closed = %s', async (limitType, stillClosed) => {
      const reread = areasBlock(mapped(limitType));
      const base = makeRequest({ ctx: ctxWith({}) });
      const request = vi.fn(async (path, options) => (path.includes('/lawn-fast/context') && /productIds=/.test(path) ? placeContext({ treatmentGuide: true, addOns: ADD_ONS, troubleAreas: reread }) : base(path, options)));
      guideAnswer = guideWith({ [P_FUNG]: {} });
      await openSheet({ request, props: { catalog: CAT } });
      await analyze();
      fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
      typeArea(placeGroup('Spot Fungicide'), '100');
      fireEvent.click(chipOf(chipsOf(), 'Front'));
      guideAnswer = guideMapped(limitType);
      completeErrors.push(refusal(400, 'lawn_place_limit', MESSAGE, { productId: P_FUNG, place: 'front', limitType }));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      await submit();
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
      await waitFor(() => expect(request.mock.calls.some(([path]) => /context\?productIds=/.test(path))).toBe(true));
      typeArea(placeGroup('Spot Fungicide'), '250');
      await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(stillClosed));
      // A second refusal at the new dose closes the chip again, for an amount block too (the server stays authoritative).
      if (!stillClosed) {
        completeErrors.push(refusal(400, 'lawn_place_limit', MESSAGE, { productId: P_FUNG, place: 'front', limitType }));
        await waitFor(() => expect(completeButton().disabled).toBe(false));
        await submit();
        await waitFor(() => expect(chipOf(chipsOf(), 'Front').disabled).toBe(true));
      }
    });
  });

  test('other refusals do not re-read the place maps; a failed refresh changes nothing', async () => {
    let contextReads = 0;
    const base = makeRequest({ ctx: ctxWith({}) });
    const request = vi.fn(async (path, options) => {
      if (path.includes('/lawn-fast/context')) { contextReads += 1; if (contextReads > 1) throw new Error('offline'); return ctxWith({}); }
      return base(path, options);
    });
    guideAnswer = guideWith({});
    await openSheet({ request, props: { catalog: CAT } });
    await analyze();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
    typeArea(placeGroup('Spot Fungicide'), '100');
    fireEvent.click(chipOf(chipsOf(), 'Front'));
    completeErrors.push(refusal(400, 'lawn_place_required', 'Pick where on the lawn Spot Fungicide went.'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    await screen.findByText(/Pick where on the lawn/);
    expect(contextReads).toBe(1);
    completeErrors.push(refusal(400, 'lawn_place_limit', 'closed'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(contextReads).toBe(2));
    // The refresh failed: the chips stand as they were and the sheet is still usable.
    expect(chipOf(chipsOf(), 'Front').disabled).toBe(false);
  });
});

// ── a planned or Search-added chinch rung is typed by the program ──────────────────────────────────────────────────
describe('the type sent for a chinch-ladder row', () => {
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const BIF_ITEM = { productId: P_BIF, name: 'Atticus Talak 7.9 F', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: null, rateUnit: null, gateNotes: [] };
  const CHINCH = {
    item: ARENA_ITEM, note: null, rungIds: [P_ARENA, P_BIF], blockedIds: [], unreadableIds: [], chinchOnlyIds: [P_ARENA],
    byPlace: { front: { item: BIF_ITEM, note: null, unreadableIds: [], blockedIds: [P_ARENA] }, back: { item: ARENA_ITEM, note: null, unreadableIds: [], blockedIds: [] } },
  };

  test('Arena planned: chinch; Talak planned at the back (not the decision there): an insect; Talak where the decision names it: chinch', async () => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], chinch: CHINCH };
    await open(placeContext({ treatmentGuide: true, chinch: CHINCH, planned: [ARENA_ITEM, BIF_ITEM], addOns: [] }));
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
    fireEvent.click(chipOf(within(placeGroup('Arena 50 WDG')).getByRole('group', { name: 'Place for Arena 50 WDG' }), 'Back'));
    fireEvent.click(chipOf(within(placeGroup('Atticus Talak 7.9 F')).getByRole('group', { name: 'Place for Atticus Talak 7.9 F' }), 'Back'));
    typeArea(placeGroup('Arena 50 WDG'), '100');
    typeArea(placeGroup('Atticus Talak 7.9 F'), '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_ARENA)).toMatchObject({ areaPlace: 'back', troubleType: 'chinch' });
    expect(sent(P_BIF)).toMatchObject({ areaPlace: 'back', troubleType: 'other_insect' });
  });
});


// ── with the report ties (lawnReportTies) and the report facts (lawnReportFacts) live ───────────────────────────────
describe('places beside the report ties and the spot-area marker', () => {
  const ARENA_ITEM = { productId: P_ARENA, name: 'Arena 50 WDG', applicationMethod: 'spot_treatment', amount: null, amountUnit: null, ratePer1000: 0.147, rateUnit: 'oz', gateNotes: [] };
  const CHINCH = {
    item: ARENA_ITEM, note: null, rungIds: [P_ARENA], blockedIds: [], unreadableIds: [], chinchOnlyIds: [P_ARENA],
    byPlace: { front: { item: ARENA_ITEM, note: null, unreadableIds: [], blockedIds: [] }, back: { item: ARENA_ITEM, note: null, unreadableIds: [], blockedIds: [] } },
  };
  const tied = () => ({ ...placeContext({ treatmentGuide: true, chinch: CHINCH, addOns: [] }), lawnReportTies: true, lawnReportFacts: true });

  test('the chinch entry per place records the find with the place; the body carries the place and the spot-area marker together', async () => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], chinch: CHINCH };
    await open(tied());
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
    fireEvent.click(within(addons()).getByRole('button', { name: 'Add chinch bug treatment: Back' }));
    typeArea(placeGroup('Arena 50 WDG'), '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    const body = completeCalls()[0].body;
    expect(body.products.find((p) => p.productId === P_ARENA)).toMatchObject({ areaPlace: 'back', areaValue: 100, areaUnit: 'sqft', troubleType: 'chinch' });
    expect(body.lawnFast.spotAreas).toEqual({ v: 1, productIds: [P_ARENA] });
    expect(body.lawnFast.treatmentGuide.cards).toEqual([{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [P_ARENA], place: 'back' }]);
  });

  test('a chinch product already on the sheet reads "Found": one tap marks it, the record names its place, no row is added', async () => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [], chinch: CHINCH };
    await open({ ...tied(), plannedProducts: { ...tied().plannedProducts, items: [ARENA_ITEM] } });
    await analyze();
    await screen.findByRole('group', { name: 'Suggested from this lawn' });
    fireEvent.click(chipOf(within(placeGroup('Arena 50 WDG')).getByRole('group', { name: 'Place for Arena 50 WDG' }), 'Front'));
    fireEvent.click(within(addons()).getByRole('button', { name: 'Chinch bugs found: mark the treatment on the sheet' }));
    expect(within(addons()).getByRole('button', { name: 'Chinch bug treatment is on the sheet' }).disabled).toBe(true);
    typeArea(placeGroup('Arena 50 WDG'), '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    const body = completeCalls()[0].body;
    expect(body.products).toHaveLength(1);
    expect(body.lawnFast.treatmentGuide.cards).toEqual([{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [P_ARENA], place: 'front' }]);
  });
});

// ── a take-all card is held to the mapped places; Search maps a new one ─────────────────────────────────────────────
describe('take-all: the card offers only the mapped places, Search maps a new one', () => {
  const TAKE_ALL = ADD_ONS[4];
  const MAPPED_BACK = { id: 'area-t', place: 'back', placeLabel: 'Back', type: 'take_all', typeLabel: 'Take-all', lastTreatedOn: '2026-06-01' };
  const takeAllCard = () => ({ kind: 'fungus', title: 'Fungus', finding: 'Finding for fungus.', check: null, detail: null, note: 'Take-all area on file: Back.', productIds: [P_FUNG], items: [TAKE_ALL], allowedPlaces: ['back'], actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found' });
  const ctx = () => placeContext({ treatmentGuide: true, addOns: ADD_ONS, troubleAreas: areasBlock({ known: [MAPPED_BACK] }) });
  const chips = () => within(placeGroup('Spot Fungicide')).getByRole('group', { name: 'Place for Spot Fungicide' });
  const open2 = async (c = ctx()) => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [takeAllCard()], takeAllProductIds: [P_FUNG] };
    await open({ ...c, plannedProducts: { ...c.plannedProducts, takeAllProductIds: [P_FUNG] } });
    await analyze();
  };

  test('the card row starts on the mapped place and cannot be moved to another; the body names the card as its source', async () => {
    await open2();
    fireEvent.click(within(await screen.findByRole('group', { name: 'Suggested from this lawn' })).getByRole('button', { name: 'I checked. Add it' }));
    expect(pressed(chips())).toEqual(['Back · known']);
    expect(chipOf(chips(), 'Front').disabled).toBe(true);
    expect(chipOf(chips(), 'Right side').disabled).toBe(true);
    typeArea(placeGroup('Spot Fungicide'), '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_FUNG)).toMatchObject({ areaPlace: 'back', troubleType: 'take_all', troubleSource: 'guide_card' });
  });

  test('a take-all product added through Search (tech_tap) may take any open place', async () => {
    await open2();
    fireEvent.change(await screen.findByLabelText('Search products'), { target: { value: 'Spot Fungicide' } });
    fireEvent.click(await screen.findByRole('button', { name: /Spot Fungicide/ }));
    const method = within(placeGroup('Spot Fungicide')).getByRole('combobox', { name: /^Method for / });
    fireEvent.change(method, { target: { value: [...method.options].find((o) => o.textContent === 'Spot treatment').value } });
    expect(chipOf(chips(), 'Front').disabled).toBe(false);
    fireEvent.click(chipOf(chips(), 'Front'));
    typeArea(placeGroup('Spot Fungicide'), '100');
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    await submit();
    expect(sent(P_FUNG)).toMatchObject({ areaPlace: 'front', troubleType: 'take_all', troubleSource: 'tech_tap' });
  });
});

