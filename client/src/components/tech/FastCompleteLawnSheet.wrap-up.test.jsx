// @vitest-environment jsdom
// The regular lawn Fast Complete sheet with the Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP): gate
// off it is as it was (no section, no extra reads, the four customer-text flags); gate on and
// untouched it posts the same four flags; each change rides the /complete body; a part of a
// grouped stop (prepare mode) shows no Wrap-up and keeps the fixed flags. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.setConfig({ testTimeout: 30000 });

const P_TALAK = 'aaaaaaaa-0000-4000-8000-000000000001';
const CATALOG = [{ id: P_TALAK, name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC', service_lines: ['lawn', 'pest'] }];
const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Care', status: 'confirmed',
  scheduledDate: '2026-10-04T13:00:00.000Z', propertyId: 'prop-1', catalogServiceId: null,
  address: { line1: '123 Main St', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true, category: 'lawn_care', serviceKey: 'lawn_care_recurring', isCallback: false, technicianId: null,
};
const SERVICE = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Care', address: '123 Main St', timeLabel: '2:00 PM',
  findingsType: null, routedCustomerId: 'cust-1', routedScheduledDate: '2026-10-04', routedPropertyId: 'prop-1', routedAddress: '123 Main St',
  estimatedPrice: 90, createInvoiceOnComplete: true,
};
const PLANNED = [{ productId: P_TALAK, name: 'Talak 7.9%', applicationMethod: 'spot_treatment', amount: 2, amountUnit: 'fl_oz', approvedForReport: true, wateringRule: null, wateringSummary: 'No rule', mowHoldDays: null }];
const context = (wrapUp) => ({
  enabled: true, eligible: true, reason: null, visitType: 'recurring', findingsType: null, service: VISIT, visitDate: '2026-10-04', turfHeightCapture: false,
  plannedProducts: { source: 'plan', items: PLANNED }, plannedProductsUnavailable: null,
  methods: [{ value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false }],
  assessment: { exists: false, id: null, confirmed: false }, photoStatus: null, previousFrontPhoto: null, readFailures: [],
  ...(wrapUp ? { wrapUp: true } : {}),
});
const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };
const ASSESSED = { id: 'assessment-1', confirmed_by_tech: false, ...SCORES };
const REVIEW = { status: 'complete', findings: [{ finding_id: 'f-1', name: 'Dollarweed', confidence: 'high' }], photoQuality: [] };
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };

let requests;
// `holdRereads`: the first preview read answers, every later one waits until request.release().
function makeRequest({ wrapUp = true, previews = [PREVIEW], seeds = { exteriorMinutes: 30, interiorMinutes: 120 }, nextVisit = null, holdRereads = false } = {}) {
  const queue = [...previews];
  const held = [];
  let previewReads = 0;
  const request = vi.fn(async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    if (path.split('?')[0].endsWith('/lawn-fast/context')) return context(wrapUp);
    if (path.endsWith('/property-areas')) return { enabled: true, propertyId: 'prop-1', customerId: 'cust-1', addressKey: 'k', version: 'a'.repeat(64), areas: { beds: null, lawn: { sqft: 5000, source: 'recorded', reviewedAt: null }, mosquito: null } };
    if (/^\/admin\/customers\/[^/]+$/.test(path)) return { customer: { email: '' } };
    if (path.endsWith('/tech-tips')) return { available: false, groups: [] };
    if (path.includes('/blog-posts')) return { available: false, posts: [] };
    if (path === '/admin/dispatch/products/catalog') return { products: CATALOG };
    if (path.includes('/lawn-assessment/service/')) return { shotListEnabled: true, assessment: null };
    if (path.endsWith('/lawn-assessment/assess')) return { success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' };
    if (path.endsWith('/lawn-assessment/confirm')) return { success: true, confirmed: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    if (path.includes('/reentry-defaults')) return seeds;
    if (path.startsWith('/admin/schedule/next-visit')) return { nextVisit };
    if (path.startsWith('/admin/reviews/send-time-preview')) {
      previewReads += 1;
      if (holdRereads && previewReads > 1) return new Promise((resolve) => { held.push(() => resolve(PREVIEW)); });
      return queue.length > 1 ? queue.shift() : queue[0];
    }
    if (path.endsWith('/complete')) return { success: true, invoiceId: null };
    return {};
  });
  request.release = () => held.forEach((resolve) => resolve());
  return request;
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
  localStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('FileReader', FixtureFileReader);
  vi.stubGlobal('Image', FixtureImage);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openSheet({ request = makeRequest(), props = {} } = {}) {
  render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onCompleted={() => {}} onFullForm={() => {}} {...props} />);
  await screen.findByRole('heading', { name: 'Lawn assessment' });
  return request;
}
const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
// Photos, Analyze lawn, Confirm assessment: the sheet is then ready to complete.
async function confirmAssessment() {
  const input = await screen.findByLabelText('Add turf photos');
  await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
  fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByLabelText('Slot for photo 1');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  await screen.findByLabelText('Density score');
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
  await waitFor(() => expect(completeButton().disabled).toBe(false));
}
async function complete() {
  fireEvent.click(completeButton());
  await waitFor(() => expect(completeCalls().length).toBeGreaterThan(0));
  return completeCalls()[0].body;
}
const FOUR_FLAGS = { sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' };
const WRAP_UP_KEYS = ['timeOnSite', 'reentryExteriorMinutes', 'reentryInteriorMinutes', 'nextVisitAdjustmentNote', 'reviewDelayMinutes', 'reviewScheduledFor'];
const reads = (pattern) => requests.filter((r) => pattern.test(r.path));

describe('gate off (the context carries no wrapUp)', () => {
  test('no Wrap-up, no extra reads, and the four flags exactly', async () => {
    await openSheet({ request: makeRequest({ wrapUp: false }) });
    expect(screen.queryByRole('heading', { name: 'Wrap-up' })).toBeNull();
    await confirmAssessment();
    const body = await complete();
    expect(body).toMatchObject(FOUR_FLAGS);
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
    expect(reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
  });
});

describe('gate on', () => {
  test('shows the section after the treatment zone map; untouched it posts the same four flags', async () => {
    await openSheet();
    const wrap = await screen.findByRole('heading', { name: 'Wrap-up' });
    const map = screen.getByRole('heading', { name: 'Treatment zone map' });
    expect(map.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await confirmAssessment();
    const body = await complete();
    expect(body).toMatchObject(FOUR_FLAGS);
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
  });

  test('each change rides the body', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    await openSheet({ request: makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Lawn Care' } }) });
    fireEvent.change(await screen.findByLabelText('Adjust time on site (minutes)'), { target: { value: '35' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Decrease Interior re-entry by 15 minutes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Include payment link in the text/ }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
    await confirmAssessment();
    const body = await complete();
    expect(body).toMatchObject({
      sendCompletionSms: true, requestReview: true, includePayLink: false, reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0,
      timeOnSite: 35, reentryInteriorMinutes: 105,
    });
    expect(body.reviewScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
    expect(body).not.toHaveProperty('reentryExteriorMinutes');
  });

  test('the Time on-site clock still shows once, from the shared component', async () => {
    await openSheet({ props: { service: { ...SERVICE, onSiteAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() } } });
    expect(screen.getAllByRole('heading', { name: 'Time on-site' })).toHaveLength(1);
  });
});

describe('prepare mode (a part of a grouped stop)', () => {
  test('shows no Wrap-up, reads nothing for it, and hands over the four flags', async () => {
    const onPrepared = vi.fn();
    await openSheet({ props: { operatorId: 'op-1', sharedNote: 'Synthetic stop note', onPrepared } });
    expect(screen.queryByRole('heading', { name: 'Wrap-up' })).toBeNull();
    await confirmAssessment();
    fireEvent.click(completeButton());
    await screen.findByText('Saved for this stop');
    expect(onPrepared.mock.calls[0][1]).toMatchObject(FOUR_FLAGS);
    for (const key of WRAP_UP_KEYS) expect(onPrepared.mock.calls[0][1]).not.toHaveProperty(key);
    expect(reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
    expect(completeCalls()).toHaveLength(0);
  });
});

describe('while the review send time is being re-checked', () => {
  const previewReads = () => reads(/send-time-preview/).length;

  async function startHeldComplete(props = {}) {
    const request = makeRequest({ holdRereads: true });
    await openSheet({ request, props });
    await confirmAssessment();
    await waitFor(() => expect(previewReads()).toBeGreaterThan(0));
    fireEvent.click(completeButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' }).disabled).toBe(true));
    return request;
  }

  test('the form, Complete, Back and Details are inert, a second tap does nothing, and nothing is posted', async () => {
    const onClose = vi.fn();
    const onViewDetails = vi.fn();
    const request = await startHeldComplete({ onClose, onViewDetails });
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Details' }).disabled).toBe(true);
    expect(completeButton().disabled).toBe(true);
    const before = previewReads();
    fireEvent.click(completeButton());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(previewReads()).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(onViewDetails).not.toHaveBeenCalled();
    expect(completeCalls()).toHaveLength(0);
    // The answer lands: the sheet unlocks and posts once.
    await act(async () => { request.release(); });
    await waitFor(() => expect(completeCalls().length).toBe(1));
  });

  test('an answer that lands after the sheet is gone posts nothing', async () => {
    const request = await startHeldComplete();
    cleanup();
    await act(async () => { request.release(); });
    await act(async () => { await Promise.resolve(); });
    expect(completeCalls()).toHaveLength(0);
  });
});
