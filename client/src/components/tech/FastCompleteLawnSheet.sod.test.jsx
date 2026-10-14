// @vitest-environment jsdom
// New sod on the lawn Fast Complete sheet (GATE_LAWN_NEW_SOD_NOTE, owner 2026-10-09). The server decides every
// hold and every word (`newSod` in the context); the sheet renders the banner, keeps a held line off the sheet
// (greyed, with its reason; the technician can still add it by hand, with a warning), notes a part-of-lawn
// skip, shows the server's swap bag, and performs the rooted tick. With no `newSod` it renders exactly as
// before. Synthetic data only; no real provider is ever called (every request is a stub).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => <div role="dialog" aria-label="Tracer" /> }));

vi.setConfig({ testTimeout: 30000 });

const P_BAG24 = 'dddddddd-0000-4000-8000-000000000001';
const P_DIM = 'dddddddd-0000-4000-8000-000000000002';
const P_NUTRA = 'dddddddd-0000-4000-8000-000000000003';
const P_CELSIUS = 'dddddddd-0000-4000-8000-000000000004';
const P_DYLOX = 'dddddddd-0000-4000-8000-000000000005';
const CATALOG = [
  { id: P_BAG24, name: 'Test 24-0-11 Bag', category: 'fertilizer', formulation: 'granular' },
  { id: P_DIM, name: 'Test Dimension Bag', category: 'herbicide', formulation: 'granular' },
  { id: P_NUTRA, name: 'Test Nutra Mix', category: 'fertilizer', formulation: 'liquid' },
  { id: P_CELSIUS, name: 'Test Celsius', category: 'herbicide', formulation: 'dry' },
  { id: P_DYLOX, name: 'Test Dylox', category: 'insecticide', formulation: 'granular' },
];

const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Care', status: 'confirmed',
  scheduledDate: '2026-10-05T13:00:00.000Z', propertyId: 'prop-1', catalogServiceId: null,
  address: { line1: '123 Main St', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true, category: 'lawn_care', serviceKey: 'lawn_care_recurring', isCallback: false, technicianId: null,
};
const SERVICE = {
  id: 'svc-lawn', customerName: 'Pat Jones', serviceType: 'Lawn Care', address: '123 Main St', timeLabel: '2:00 PM', findingsType: null,
  routedCustomerId: 'cust-1', routedScheduledDate: '2026-10-05', routedPropertyId: 'prop-1', routedAddress: '123 Main St',
};

const item = (productId, name, extra = {}) => ({
  productId, name, applicationMethod: 'granular_broadcast', amount: 12.5, amountUnit: 'lb', treatedSqft: 5000, areaUnit: 'sqft',
  ratePer1000: null, rateUnit: null, approvedForReport: true, wateringRule: null, wateringSummary: 'No rule', mowHoldDays: null, ...extra,
});
const addOn = (productId, name) => ({ ...item(productId, name, { applicationMethod: 'spot_treatment', amount: null, treatedSqft: null, areaUnit: null }), line: null, substituteFor: null, gateNotes: [] });

const HELD_FERT = 'Held: new sod. Fertilizer starts Oct 31, 2026.';
const HELD_WEED = 'Held: new sod. Weed killer starts Oct 31, 2026, once the sod has been mowed twice and does not lift.';
const WHOLE_DAY5 = {
  v: 1, day: 5, sodLaidOn: '2026-10-01', covers: 'whole', area: null,
  headline: 'New sod, day 5. Laid Oct 1, 2026.', where: 'Whole lawn.',
  heldLine: 'Held: fertilizer, weed killer, pre-emergent, Tetrino, Dylox, Gravex.',
  largePatch: 'Watch for large patch.', swap: null, noWholeLawn: null, rooted: null,
  lines: {
    [P_BAG24]: { held: true, kinds: ['fertilizer'], reason: HELD_FERT },
    [P_CELSIUS]: { held: true, kinds: ['weedKiller'], reason: HELD_WEED },
    [P_DYLOX]: { held: true, kinds: ['dylox'], reason: 'Held: new sod. Dylox starts Oct 31, 2026.' },
  },
};

const context = (newSod, planned = {}) => ({
  enabled: true, eligible: true, reason: null, visitType: 'recurring', findingsType: null, service: VISIT, visitDate: '2026-10-05', turfHeightCapture: false,
  plannedProducts: {
    source: 'plan',
    month: 10,
    items: [item(P_BAG24, 'Test 24-0-11 Bag'), item(P_NUTRA, 'Test Nutra Mix', { applicationMethod: 'broadcast_spray', amountUnit: 'fl_oz', amount: 30 })],
    addOns: [addOn(P_CELSIUS, 'Test Celsius'), addOn(P_DYLOX, 'Test Dylox')],
    ...planned,
  },
  plannedProductsUnavailable: null,
  methods: [
    { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
    { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
    { value: 'granular_broadcast', label: 'Granular broadcast', common: true, requiresSqft: true },
  ],
  assessment: { exists: false, id: null, confirmed: false }, photoStatus: null, previousFrontPhoto: null, readFailures: [],
  ...(newSod ? { newSod } : {}),
});

const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };
const ASSESSED = { id: 'assessment-1', confirmed_by_tech: false, ...SCORES };
const REVIEW = { status: 'complete', findings: [{ finding_id: 'f-1', name: 'Dollarweed', confidence: 'high' }], photoQuality: [] };
const VERSION = 'a'.repeat(64);
const areasAnswer = { enabled: true, propertyId: 'prop-1', customerId: 'cust-1', addressKey: 'k', version: VERSION, areas: { beds: null, lawn: { sqft: 5000, source: 'recorded', reviewedAt: null }, mosquito: null } };

let requests;
let contexts;
let rootedAnswer;
let completeError;
let failContextAfter;
let contextReads;
let guideAnswer;

// A stub of the admin API the sheet talks to; each context read serves the next queued context (the last repeats).
function makeRequest() {
  return vi.fn(async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    if (path.includes('/lawn-fast/context')) {
      contextReads += 1;
      if (contextReads > failContextAfter) throw new Error('offline');
      return contexts.length > 1 ? contexts.shift() : contexts[0];
    }
    if (path.split('?')[0].endsWith('/lawn-fast/sod-rooted')) {
      if (rootedAnswer instanceof Error) throw rootedAnswer;
      return rootedAnswer;
    }
    if (path.includes('/lawn-fast/treatment-guide')) return guideAnswer ?? {};
    if (path.endsWith('/property-areas')) return areasAnswer;
    if (/^\/admin\/customers\/[^/]+$/.test(path)) return { customer: { email: '' } };
    if (path.endsWith('/tech-tips')) return { available: false, groups: [] };
    if (path.includes('/blog-posts')) return { available: false, posts: [] };
    if (path === '/admin/dispatch/products/catalog') return { products: CATALOG };
    if (path.includes('/lawn-assessment/service/')) return { shotListEnabled: true, assessment: null };
    if (path.endsWith('/lawn-assessment/assess')) return { success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' };
    if (path.endsWith('/lawn-assessment/confirm')) return { success: true, confirmed: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    if (path.endsWith('/complete')) {
      if (completeError) throw completeError;
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
  rootedAnswer = { enabled: true, sodRootedOn: '2026-10-05', changed: true };
  completeError = null;
  failContextAfter = Infinity;
  contextReads = 0;
  guideAnswer = null;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('FileReader', FixtureFileReader);
  vi.stubGlobal('Image', FixtureImage);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openSheet(first, ...rest) {
  contexts = [first, ...rest];
  render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest()} catalog={CATALOG} onClose={() => {}} onCompleted={() => {}} onFullForm={() => {}} />);
  await screen.findByRole('heading', { name: 'Lawn assessment' });
}

const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
const contextRequests = () => requests.filter((r) => r.path.includes('/lawn-fast/context'));
const banner = () => screen.queryByRole('region', { name: 'New sod' });
const heldGroup = () => screen.queryByRole('group', { name: 'Held for new sod' });

async function confirmAssessment() {
  const input = await screen.findByLabelText('Add turf photos');
  await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
  fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByLabelText('Slot for photo 1');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  await screen.findByLabelText('Density score');
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
}

async function analyzeAndComplete() {
  await confirmAssessment();
  await waitFor(() => expect(completeButton().disabled).toBe(false));
  fireEvent.click(completeButton());
  await waitFor(() => expect(completeCalls().length).toBeGreaterThan(0));
}

describe('with no newSod (gate off, older server, no hold today)', () => {
  test('no banner, no held group, every planned line is a row', async () => {
    await openSheet(context(null));
    expect(banner()).toBeNull();
    expect(heldGroup()).toBeNull();
    expect(screen.getByRole('group', { name: 'Test 24-0-11 Bag' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Test Nutra Mix' })).toBeTruthy();
    const addons = screen.getByRole('group', { name: 'Also in October’s protocol' });
    expect(within(addons).getByRole('button', { name: 'Add Test Celsius' }).textContent).toBe('Add');
  });
});

describe('whole lawn, day 5', () => {
  test('the banner says the day, the date, the area and what is held, and the large patch note', async () => {
    await openSheet(context(WHOLE_DAY5));
    const region = banner();
    expect(region.textContent).toContain('New sod, day 5. Laid Oct 1, 2026. Whole lawn.');
    expect(region.textContent).toContain('Held: fertilizer, weed killer, pre-emergent, Tetrino, Dylox, Gravex.');
    expect(region.textContent).toContain('Watch for large patch.');
    // Day 5: no rooted tick yet.
    expect(within(region).queryByRole('checkbox')).toBeNull();
  });

  test('a held planned line is not a row: it is greyed under "Held for new sod" with its reason; others stay on', async () => {
    await openSheet(context(WHOLE_DAY5));
    expect(screen.queryByRole('group', { name: 'Test 24-0-11 Bag' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Test Nutra Mix' })).toBeTruthy();
    const held = heldGroup();
    expect(within(held).getByText('Test 24-0-11 Bag')).toBeTruthy();
    expect(within(held).getByText(HELD_FERT)).toBeTruthy();
    // Held add-ons say so on their own line.
    const addons = screen.getByRole('group', { name: 'Also in October’s protocol' });
    expect(within(addons).getByText(`${HELD_WEED} · Spot treatment`)).toBeTruthy();
    expect(within(addons).getByRole('button', { name: 'Add Test Celsius anyway' }).textContent).toBe('Add anyway');
  });

  test('the technician can still add a held line by hand: it becomes a row with a warning, never a block', async () => {
    await openSheet(context(WHOLE_DAY5));
    fireEvent.click(within(heldGroup()).getByRole('button', { name: 'Add Test 24-0-11 Bag anyway' }));
    const row = screen.getByRole('group', { name: 'Test 24-0-11 Bag' });
    expect(row.textContent).toContain(`${HELD_FERT} You added it by hand.`);
    expect(within(heldGroup()).getByText('On the sheet')).toBeTruthy();
  });

  test('what is recorded is what is selected: the held line is not in the products sent, and is a skipped plan default as before', async () => {
    await openSheet(context({ ...WHOLE_DAY5, plannedHeld: [{ kind: 'fertilizer', until: '2026-10-31', rootedCheck: false, productIds: [P_BAG24] }] }));
    await analyzeAndComplete();
    const sent = completeCalls()[0].body;
    expect(sent.products.map((p) => p.productId)).toEqual([P_NUTRA]);
    expect(sent.lawnProtocolCompletion.skippedProducts.map((p) => p.productId)).toEqual([P_BAG24]);
    // The sod record the sheet showed goes back with the completion (the report's New sod card binds to it).
    expect(sent.lawnFast.sod).toEqual({ laidOn: WHOLE_DAY5.sodLaidOn, covers: 'whole', held: ['fertilizer'] });
  });
});

describe('part of the lawn', () => {
  const PART = {
    ...WHOLE_DAY5, covers: 'part', area: 'Back left corner', where: 'Part of the lawn: Back left corner.',
    heldLine: 'Skip the new sod area for: weed killer, pre-emergent, Tetrino, Gravex.',
    lines: { [P_CELSIUS]: { held: false, kinds: [], note: 'Skip the new sod: Back left corner' }, [P_NUTRA]: { held: false, kinds: [], note: 'Skip the new sod: Back left corner' } },
  };

  test('lines stay on; the skip note rides the weed add-on and a pre-selected line', async () => {
    await openSheet(context(PART));
    expect(banner().textContent).toContain('Part of the lawn: Back left corner.');
    expect(heldGroup()).toBeNull();
    expect(screen.getByRole('group', { name: 'Test 24-0-11 Bag' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Test Nutra Mix' }).textContent).toContain('Skip the new sod: Back left corner');
    const addons = screen.getByRole('group', { name: 'Also in October’s protocol' });
    expect(within(addons).getByText(/Skip the new sod: Back left corner/)).toBeTruthy();
    // A skip note is not a hold: the plain Add button.
    expect(within(addons).getByRole('button', { name: 'Add Test Celsius' }).textContent).toBe('Add');
  });
});

describe('the rooted tick', () => {
  const DAY31 = {
    ...WHOLE_DAY5, day: 31, sodLaidOn: '2026-09-05', headline: 'New sod, day 31. Laid Sep 5, 2026.', heldLine: 'Held: weed killer, pre-emergent, Gravex.',
    rooted: { sodLaidOn: '2026-09-05', label: 'Sod mowed twice and does not lift' },
    lines: { [P_CELSIUS]: { held: true, kinds: ['weedKiller'], reason: 'Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.' } },
  };
  const AFTER = { ...DAY31, rooted: null, heldLine: 'Held: pre-emergent.', lines: {} };

  test('day 31: the banner offers the tick; ticking sends the sod date, reads the holds again and un-holds the weed lines', async () => {
    await openSheet(context(DAY31), context(AFTER));
    const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });
    expect(within(addons()).getByText(/Weed killer waits until the sod has been mowed twice/)).toBeTruthy();
    fireEvent.click(within(banner()).getByRole('checkbox', { name: 'Sod mowed twice and does not lift' }));
    await waitFor(() => expect(within(banner()).queryByRole('checkbox')).toBeNull());
    const post = requests.find((r) => r.path.split('?')[0].endsWith('/lawn-fast/sod-rooted'));
    expect(post.options.method).toBe('POST');
    expect(post.body).toEqual({ sodLaidOn: '2026-09-05' });
    // The server's re-read decides: the weed add-on is a plain Add again.
    expect(within(addons()).queryByText(/Weed killer waits/)).toBeNull();
    expect(within(addons()).getByRole('button', { name: 'Add Test Celsius' }).textContent).toBe('Add');
    expect(banner().textContent).toContain('Held: pre-emergent.');
  });

  test('a refused tick says why in plain words and leaves the box to tick again', async () => {
    rootedAnswer = Object.assign(new Error('The sod record changed. Close this sheet and open the visit again.'), { status: 409, code: 'sod_record_changed' });
    await openSheet(context(DAY31));
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await screen.findByText('The sod record changed. Close this sheet and open the visit again.');
    expect(within(banner()).getByRole('checkbox').checked).toBe(false);
  });

  test('the sod-aware signal rides the opening read, the tick and the re-read (and nothing else is asked for)', async () => {
    await openSheet(context(DAY31), context(AFTER));
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await waitFor(() => expect(within(banner()).queryByRole('checkbox')).toBeNull());
    const reads = contextRequests();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads.filter((r) => !r.path.includes('productIds='))) expect(read.path).toMatch(/\/lawn-fast\/context\?sodAware=1$/);
    expect(requests.find((r) => r.path.includes('/lawn-fast/sod-rooted')).path).toMatch(/\/lawn-fast\/sod-rooted\?sodAware=1$/);
  });

  test.each([
    ['sod_rooted_future_visit', 409, 'This visit is on a later day. Confirm the sod on the day of the visit.'],
    ['sod_record_changed', 409, 'The sod record changed. Close this sheet and open the visit again.'],
    ['sod_not_this_home', 409, 'This visit is not at the home with the sod record.'],
    ['sod_rooted_too_early', 409, 'The sod is still inside its first 30 days. Confirm it after day 30.'],
  ])('%s: the server\'s own sentence is shown, and the box stays to tick again', async (code, status, message) => {
    rootedAnswer = Object.assign(new Error(message), { status, code });
    await openSheet(context(DAY31));
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await screen.findByText(message);
    expect(within(banner()).getByRole('checkbox').checked).toBe(false);
  });

  test('404 from the tick (the gate is off, or the server does not know this sheet): the tick is hidden, no error, no retry loop', async () => {
    rootedAnswer = Object.assign(new Error('Not found'), { status: 404 });
    await openSheet(context(DAY31));
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await waitFor(() => expect(within(banner()).queryByRole('checkbox')).toBeNull());
    expect(within(banner()).queryByText('Not found')).toBeNull();
    expect(requests.filter((r) => r.path.includes('/lawn-fast/sod-rooted'))).toHaveLength(1);
    // The rest of the banner stays.
    expect(banner().textContent).toContain('New sod, day 31.');
  });

  describe('a planned line the hold kept off the sheet comes back when the tick releases it', () => {
    const HELD_BAG = { held: true, kinds: ['weedKiller'], reason: 'Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.' };
    const BAG_DAY31 = { ...DAY31, lines: { [P_BAG24]: HELD_BAG, [P_CELSIUS]: HELD_BAG } };
    const bagRow = () => screen.queryAllByRole('group', { name: 'Test 24-0-11 Bag' }).filter((el) => !el.classList.contains('tech-sod-held'));
    const tickIt = async () => {
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(within(banner()).queryByRole('checkbox')).toBeNull());
    };

    test('a planned default released by the tick becomes a selected row with its planned amount, and the held group is gone', async () => {
      await openSheet(context(BAG_DAY31), context(AFTER));
      expect(bagRow()).toHaveLength(0);
      expect(within(heldGroup()).getByText('Test 24-0-11 Bag')).toBeTruthy();
      await tickIt();
      expect(heldGroup()).toBeNull();
      expect(bagRow()).toHaveLength(1);
      expect(within(bagRow()[0]).getByRole('spinbutton').value).toBe('12.5');
      await analyzeAndComplete();
      expect(completeCalls()[0].body.products.map((p) => p.productId)).toEqual([P_NUTRA, P_BAG24]);
    });

    test('an add-on released by the tick is a plain Add again', async () => {
      await openSheet(context(BAG_DAY31), context(AFTER));
      const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });
      expect(within(addons()).getByRole('button', { name: 'Add Test Celsius anyway' })).toBeTruthy();
      await tickIt();
      expect(within(addons()).getByRole('button', { name: 'Add Test Celsius' }).textContent).toBe('Add');
    });

    test('a line the technician added with "Add anyway" before the tick stays exactly one row', async () => {
      await openSheet(context(BAG_DAY31), context(AFTER));
      fireEvent.click(within(heldGroup()).getByRole('button', { name: 'Add Test 24-0-11 Bag anyway' }));
      expect(bagRow()).toHaveLength(1);
      await tickIt();
      expect(bagRow()).toHaveLength(1);
      expect(heldGroup()).toBeNull();
    });

    test('a line the technician added and then removed stays removed (and is not offered again)', async () => {
      await openSheet(context(BAG_DAY31), context(AFTER));
      fireEvent.click(within(heldGroup()).getByRole('button', { name: 'Add Test 24-0-11 Bag anyway' }));
      fireEvent.click(within(bagRow()[0]).getByRole('button', { name: /remove/i }));
      expect(bagRow()).toHaveLength(0);
      await tickIt();
      expect(bagRow()).toHaveLength(0);
    });

    test('a re-read that could not check the sod record releases nothing: the line stays in the held group', async () => {
      const UNAVAILABLE = { v: 1, unavailable: true, message: 'Could not check this lawn for new sod. Ask the office before you spread fertilizer or spray weed killer.' };
      await openSheet(context(BAG_DAY31), context(UNAVAILABLE));
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await screen.findByText('Saved. The sheet could not reload the holds. Tap the box again.');
      expect(bagRow()).toHaveLength(0);
      expect(within(heldGroup()).getByText('Test 24-0-11 Bag')).toBeTruthy();
    });
  });

  // Codex on #6240: the footer must not complete on the rows of the old holds while the tick is saved and the holds are read again.
  test('Complete waits while the tick is saved and the holds are read again, then works on the fresh rows', async () => {
    const HELD_BAG = { held: true, kinds: ['weedKiller'], reason: 'Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.' };
    await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(AFTER));
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    let release;
    rootedAnswer = new Promise((resolve) => { release = () => resolve({ enabled: true, sodRootedOn: '2026-10-05', changed: true }); });
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await waitFor(() => expect(completeButton().disabled).toBe(true));
    expect(screen.getByText('Checking the new sod holds. Wait a moment.')).toBeTruthy();
    fireEvent.click(completeButton());
    expect(completeCalls()).toHaveLength(0);
    release();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls().length).toBe(1));
    expect(completeCalls()[0].body.products.map((p) => p.productId)).toEqual([P_NUTRA, P_BAG24]);
  });

  test('a tick that saved but whose re-read failed says so, and ticking again is safe', async () => {
    failContextAfter = 1;
    await openSheet(context(DAY31));
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await screen.findByText('Saved. The sheet could not reload the holds. Tap the box again.');
    expect(within(banner()).getByRole('checkbox').checked).toBe(false);
  });
  // Codex round 3 on #6240: the re-read's plan and holds decide the rows, not the opening ones.
  describe('the plan or the holds changed while the sheet was open', () => {
    const HELD_BAG = { held: true, kinds: ['weedKiller'], reason: 'Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.' };
    const rowNames = () => completeCalls()[0].body.products.map((p) => p.productId);
    const tickIt = async () => {
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(within(banner()).queryByRole('checkbox')).toBeNull());
    };

    test('a held line the refreshed plan dropped does not come back, and is not a skipped default', async () => {
      await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(AFTER, { items: [item(P_NUTRA, 'Test Nutra Mix', { applicationMethod: 'broadcast_spray', amountUnit: 'fl_oz', amount: 30 })] }));
      await tickIt();
      await analyzeAndComplete();
      expect(rowNames()).toEqual([P_NUTRA]);
      expect(completeCalls()[0].body.lawnProtocolCompletion).toBeUndefined();
    });

    test('an untouched row the refreshed holds now keep off leaves the sheet; a released line takes the refreshed quantity', async () => {
      const NOW_HELD = { ...AFTER, lines: { [P_NUTRA]: { held: true, kinds: ['fertilizer'], reason: HELD_FERT } } };
      await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(NOW_HELD, { items: [item(P_BAG24, 'Test 24-0-11 Bag', { amount: 9 }), item(P_NUTRA, 'Test Nutra Mix', { applicationMethod: 'broadcast_spray', amountUnit: 'fl_oz', amount: 30 })] }));
      await tickIt();
      expect(within(heldGroup()).getByText('Test Nutra Mix')).toBeTruthy();
      const bag = screen.getAllByRole('group', { name: 'Test 24-0-11 Bag' }).filter((el) => !el.classList.contains('tech-sod-held'));
      expect(within(bag[0]).getByRole('spinbutton').value).toBe('9');
      await analyzeAndComplete();
      expect(rowNames()).toEqual([P_BAG24]);
    });

    // Codex round 4 on #6240.
    test('the add-ons follow the re-read too: one the refreshed plan dropped is gone, a new one is offered', async () => {
      await openSheet(context(DAY31), context(AFTER, { addOns: [addOn(P_DYLOX, 'Test Dylox'), addOn(P_DIM, 'Test Dimension Bag')] }));
      const addons = () => screen.getByRole('group', { name: 'Also in October’s protocol' });
      expect(within(addons()).queryByText('Test Celsius')).toBeTruthy();
      await tickIt();
      expect(within(addons()).queryByText('Test Celsius')).toBeNull();
      expect(within(addons()).getByRole('button', { name: 'Add Test Dimension Bag' })).toBeTruthy();
    });

    test('a re-read that could not read the plan changes nothing and keeps Complete off', async () => {
      await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), { ...context(AFTER, { items: [] }), plannedProductsUnavailable: 'planned_products', readFailures: ['planned_products'] });
      await confirmAssessment();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(screen.getAllByText('Saved. The sheet could not reload the holds. Tap the box again.').length).toBeGreaterThan(0));
      expect(screen.getAllByRole('group', { name: 'Test Nutra Mix' }).length).toBeGreaterThan(0);
      expect(within(heldGroup()).getByText('Test 24-0-11 Bag')).toBeTruthy();
      expect(completeButton().disabled).toBe(true);
    });

    test('the retry after a failed re-read gets 404: the sheet says to close and open the visit, and the box stays', async () => {
      await openSheet(context(DAY31), context(AFTER));
      failContextAfter = contextReads;
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await screen.findByText('Saved. The sheet could not reload the holds. Tap the box again.');
      rootedAnswer = Object.assign(new Error('Not found'), { status: 404 });
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(screen.getAllByText('Saved. The sheet could not reload the holds. Close this visit and open it again.').length).toBeGreaterThan(0));
      expect(within(banner()).getByRole('checkbox')).toBeTruthy();
    });

    // Codex round 5 on #6240.
    test('a tick with no answer from the server (the save may have landed) keeps Complete off until a tick and a re-read succeed', async () => {
      await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(AFTER));
      await confirmAssessment();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      rootedAnswer = new TypeError('Failed to fetch');
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(screen.getAllByText('The sheet could not confirm the save. Tap the box again.').length).toBeGreaterThan(0));
      expect(completeButton().disabled).toBe(true);
      rootedAnswer = { enabled: true, sodRootedOn: '2026-10-05', changed: false };
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(completeButton().disabled).toBe(false));
    });

    test('the server says the sod record changed: Complete stays off (the rows are the old record\'s)', async () => {
      await openSheet(context(DAY31), context(AFTER));
      await confirmAssessment();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      rootedAnswer = Object.assign(new Error('The sod record changed. Reopen the visit.'), { status: 409, code: 'sod_record_changed' });
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await waitFor(() => expect(screen.getAllByText('The sod record changed. Reopen the visit.').length).toBeGreaterThan(0));
      expect(completeButton().disabled).toBe(true);
    });

    test('a refusal that says nothing about the record (too early) does not block Complete', async () => {
      await openSheet(context(DAY31), context(AFTER));
      await confirmAssessment();
      await waitFor(() => expect(completeButton().disabled).toBe(false));
      rootedAnswer = Object.assign(new Error('The weed killer hold has not ended yet.'), { status: 409, code: 'sod_rooted_too_early' });
      fireEvent.click(within(banner()).getByRole('checkbox'));
      await screen.findByText('The weed killer hold has not ended yet.');
      expect(completeButton().disabled).toBe(false);
    });

    test('a guide re-read that fails after the plan re-read drops the old cards (the sheet follows the fresh context)', async () => {
      guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [{ kind: 'weeds', title: 'Weed spots', finding: 'Photos show weeds.', check: null, detail: null, note: null, productIds: [P_CELSIUS], items: [addOn(P_CELSIUS, 'Test Celsius')], actionLabel: 'Add weed spots', dismissLabel: null }] };
      await openSheet({ ...context(DAY31), treatmentGuide: true }, { ...context(AFTER), treatmentGuide: true });
      await confirmAssessment();
      await screen.findByRole('group', { name: 'Weed spots suggestion' });
      guideAnswer = { broken: true };
      await tickIt();
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Weed spots suggestion' })).toBeNull());
    });

    test('the treatment guide is read again with the re-read', async () => {
      guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [] };
      await openSheet({ ...context(DAY31), treatmentGuide: true }, { ...context(AFTER), treatmentGuide: true });
      await confirmAssessment();
      const guideReads = () => requests.filter((r) => r.path.includes('/lawn-fast/treatment-guide')).length;
      await waitFor(() => expect(guideReads()).toBeGreaterThan(0));
      const before = guideReads();
      await tickIt();
      await waitFor(() => expect(guideReads()).toBe(before + 1));
    });

    test('a row the technician changed himself stays as he left it', async () => {
      await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(AFTER, { items: [item(P_BAG24, 'Test 24-0-11 Bag')] }));
      const nutra = () => screen.getAllByRole('group', { name: 'Test Nutra Mix' })[0];
      fireEvent.change(within(nutra()).getByRole('spinbutton'), { target: { value: '22' } });
      await tickIt();
      expect(within(nutra()).getByRole('spinbutton').value).toBe('22');
    });
  });

  // Codex round 2 on #6240: a saved tick whose re-read failed leaves the old holds' rows on the sheet.
  test('after a saved tick whose re-read failed, Complete stays off until a tick reads the holds again', async () => {
    const HELD_BAG = { held: true, kinds: ['weedKiller'], reason: 'Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.' };
    await openSheet(context({ ...DAY31, lines: { [P_BAG24]: HELD_BAG } }), context(AFTER));
    await confirmAssessment();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    failContextAfter = contextReads;
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await waitFor(() => expect(screen.getAllByText('Saved. The sheet could not reload the holds. Tap the box again.').length).toBeGreaterThan(0));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(completeButton());
    expect(completeCalls()).toHaveLength(0);
    failContextAfter = Infinity;
    fireEvent.click(within(banner()).getByRole('checkbox'));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls().length).toBe(1));
    expect(completeCalls()[0].body.products.map((p) => p.productId)).toEqual([P_NUTRA, P_BAG24]);
  });
});

describe('the October bag swap and the all-held message', () => {
  const SWAP = {
    ...WHOLE_DAY5, day: 61, sodLaidOn: '2026-08-05', headline: 'New sod, day 61. Laid Aug 5, 2026.', heldLine: 'Held: pre-emergent.', largePatch: null,
    swap: { resolved: true, forProductId: P_DIM, productId: P_BAG24, name: 'Test 24-0-11 Bag', lbPer1000: 2.5, reason: 'New sod: no pre-emergent yet.' },
    lines: { [P_DIM]: { held: true, kinds: ['preEmergent'], reason: 'Held: new sod. Pre-emergent starts Oct 1, 2027. Use Test 24-0-11 Bag instead.' } },
  };
  const swapItems = [
    item(P_DIM, 'Test Dimension Bag', { amount: 20.2, ratePer1000: 4.04, rateUnit: 'lb' }),
    item(P_BAG24, 'Test 24-0-11 Bag', { amount: 12.5, amountUnit: 'lb', ratePer1000: 2.5, rateUnit: 'lb', sodSwap: { forProductId: P_DIM, reason: 'New sod: no pre-emergent yet.' } }),
  ];

  test('the swap bag is the row, with its reason and the server\'s amount; the Dimension bag is held', async () => {
    await openSheet(context(SWAP, { items: swapItems, addOns: [] }));
    const row = screen.getByRole('group', { name: 'Test 24-0-11 Bag' });
    expect(row.textContent).toContain('New sod: no pre-emergent yet.');
    expect(screen.queryByRole('group', { name: 'Test Dimension Bag' })).toBeNull();
    expect(within(heldGroup()).getByText('Held: new sod. Pre-emergent starts Oct 1, 2027. Use Test 24-0-11 Bag instead.')).toBeTruthy();
    await analyzeAndComplete();
    const sent = completeCalls()[0].body.products;
    expect(sent.map((p) => p.productId)).toEqual([P_BAG24]);
    expect(sent[0]).toMatchObject({ totalAmount: 12.5, amountUnit: 'lb', rate: 2.5, rateUnit: 'lb', areaValue: 5000 });
  });

  test('April on the 9-visit plan: the swap row carries the server\'s 2.1 lb per 1,000 and its amount', async () => {
    const APRIL = { ...SWAP, swap: { ...SWAP.swap, lbPer1000: 2.1 } };
    const aprilItems = [swapItems[0], item(P_BAG24, 'Test 24-0-11 Bag', { amount: 10.5, amountUnit: 'lb', ratePer1000: 2.1, rateUnit: 'lb', sodSwap: { forProductId: P_DIM, reason: 'New sod: no pre-emergent yet.' } })];
    await openSheet(context(APRIL, { items: aprilItems, addOns: [] }));
    await analyzeAndComplete();
    const sent = completeCalls()[0].body.products;
    expect(sent[0]).toMatchObject({ productId: P_BAG24, totalAmount: 10.5, rate: 2.1, rateUnit: 'lb' });
  });

  test('every primary line held: the sheet says there is no whole-lawn product today', async () => {
    const ALL_HELD = { ...WHOLE_DAY5, noWholeLawn: 'No whole-lawn product today. Spot work only.' };
    await openSheet(context(ALL_HELD, { items: [item(P_BAG24, 'Test 24-0-11 Bag')] }));
    expect(screen.getByText('No whole-lawn product today. Spot work only.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Test 24-0-11 Bag' })).toBeNull();
  });

  describe('completing with no product (the server flags it: every planned product is held)', () => {
    const NOTE = 'No product applied: new sod is rooting (laid Oct 1, 2026). Held: fertilizer until Oct 31, 2026.';
    const NO_PRODUCT_TEXT = 'No whole-lawn product today. Spot work only. If there is no spot work, complete the visit with no product.';
    const FLAGGED = { ...WHOLE_DAY5, noWholeLawn: NO_PRODUCT_TEXT, noProductAllowed: true, noProductNote: NOTE };
    const onlyBag = { items: [item(P_BAG24, 'Test 24-0-11 Bag')], addOns: [] };

    test('the sheet tells the technician he may complete with no product', async () => {
      await openSheet(context(FLAGGED, onlyBag));
      expect(screen.getByText(NO_PRODUCT_TEXT)).toBeTruthy();
    });

    test('Complete is enabled with zero rows, and the record carries the server\'s sentence after the technician\'s own note', async () => {
      await openSheet(context(FLAGGED, onlyBag));
      fireEvent.change(screen.getByPlaceholderText('What you treated, where, and what you saw'), { target: { value: 'Gate was locked.' } });
      await analyzeAndComplete();
      const body = completeCalls()[0].body;
      expect(body.products).toEqual([]);
      expect(body.technicianNotes).toBe(`Gate was locked. ${NOTE}`);
      // The held plan default is still recorded as skipped, not as applied.
      expect(body.lawnProtocolCompletion.skippedProducts.map((p) => p.productId)).toEqual([P_BAG24]);
    });

    test('the photo and the confirmed assessment are still required', async () => {
      await openSheet(context(FLAGGED, onlyBag));
      // Before the photo the bar asks for the photo, not for a product.
      expect(completeButton().textContent).toContain('Add a photo');
      expect(completeButton().textContent).not.toContain('Products applied required');
    });

    test('without the flag the same empty sheet is still blocked: Products applied required', async () => {
      await openSheet(context({ ...WHOLE_DAY5, noWholeLawn: 'No whole-lawn product today. Spot work only.' }, onlyBag));
      await confirmAssessment();
      expect(completeButton().disabled).toBe(true);
      expect(completeButton().textContent).toContain('Products applied required');
      expect(completeCalls()).toHaveLength(0);
    });

    test('the server refuses the claim as stale (the record changed): its plain sentence is shown, the visit is not marked done', async () => {
      completeError = Object.assign(new Error('The new sod record changed. Reopen the visit.'), { status: 409, code: 'lawn_sod_no_product_stale' });
      const onCompleted = vi.fn();
      contexts = [context(FLAGGED, onlyBag)];
      render(<FastCompleteLawnSheet service={SERVICE} request={makeRequest()} catalog={CATALOG} onClose={() => {}} onCompleted={onCompleted} onFullForm={() => {}} />);
      await screen.findByRole('heading', { name: 'Lawn assessment' });
      await analyzeAndComplete();
      await screen.findByText('The new sod record changed. Reopen the visit.');
      expect(onCompleted).not.toHaveBeenCalled();
      expect(completeCalls()[0].body.technicianNotes).toBe(NOTE);
    });

    test('a technician who adds a product by hand completes as usual: his products, his note, no server sentence', async () => {
      await openSheet(context(FLAGGED, onlyBag));
      fireEvent.click(within(heldGroup()).getByRole('button', { name: 'Add Test 24-0-11 Bag anyway' }));
      await analyzeAndComplete();
      const body = completeCalls()[0].body;
      expect(body.products.map((p) => p.productId)).toEqual([P_BAG24]);
      expect(body.technicianNotes).toBe('');
    });
  });

  test('a swap bag the catalog could not resolve: the held bag says to use it by hand', async () => {
    const BY_HAND = { ...SWAP, swap: { resolved: false, forProductId: P_DIM, reason: 'Use LESCO 24-0-11 by hand.' }, noWholeLawn: 'No whole-lawn product today. Spot work only.', lines: { [P_DIM]: { held: true, kinds: ['preEmergent'], reason: 'Held: new sod. Pre-emergent starts Oct 1, 2027. Use LESCO 24-0-11 by hand.' } } };
    await openSheet(context(BY_HAND, { items: [swapItems[0]], addOns: [] }));
    expect(within(heldGroup()).getByText(/Use LESCO 24-0-11 by hand\./)).toBeTruthy();
    expect(screen.getByText('No whole-lawn product today. Spot work only.')).toBeTruthy();
  });
});

describe('a sod record that could not be read', () => {
  test('the banner says so instead of showing no holds', async () => {
    await openSheet(context({ v: 1, unavailable: true, message: 'Could not check this lawn for new sod. Ask the office before you spread fertilizer or spray weed killer.' }));
    expect(screen.getByText(/Could not check this lawn for new sod/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Test 24-0-11 Bag' })).toBeTruthy();
  });
});

// Codex on #6240: a guide card that names a held product says so before its action.
describe('a treatment-guide card for a product the new sod holds', () => {
  const CARD = {
    kind: 'weeds', title: 'Weed spots', finding: 'Photos show weeds on about 18% of the lawn.', check: null, detail: 'Test Celsius', note: null,
    productIds: [P_CELSIUS], items: [addOn(P_CELSIUS, 'Test Celsius')], actionLabel: 'Add weed spots', dismissLabel: null,
  };
  const card = () => screen.getByRole('group', { name: 'Weed spots suggestion' });
  const open = async (newSod) => {
    guideAnswer = { enabled: true, v: 1, assessmentId: 'assessment-1', cards: [CARD] };
    await openSheet({ ...context(newSod), treatmentGuide: true });
    await confirmAssessment();
    await waitFor(() => expect(card()).toBeTruthy());
  };

  test('the card shows the hold reason before its action; the action still works (warn, not block)', async () => {
    await open(WHOLE_DAY5);
    expect(within(card()).getByText(HELD_WEED)).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Add weed spots' }).disabled).toBe(false);
  });

  test('no hold on the product: the card is as before', async () => {
    await open({ ...WHOLE_DAY5, lines: { [P_BAG24]: WHOLE_DAY5.lines[P_BAG24] } });
    expect(within(card()).queryByText(/Held: new sod/)).toBeNull();
  });
});

