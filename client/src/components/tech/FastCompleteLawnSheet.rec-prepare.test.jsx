// @vitest-environment jsdom
// The lawn Fast Complete sheet names its products before the Complete tap (GATE_LAWN_REC_PREPARE, the context's
// `recPrepare`; report speed plan step 4, owner 2026-11-19), so the server can run the completion's lawn recommendation
// call early.
// Behavior: once the sheet can be completed it posts the assessment and its product ids to
// lawn-fast/prepare-recommendations, and posts again after the product list changes.
// Regression these guard: a request (a paid model call on the server) with the key absent, before the assessment is
// confirmed, or after the Complete tap; and a failed request that stops the sheet.
// Gap in existing proof: no other suite reads this request. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.setConfig({ testTimeout: 30000 });

const P_TALAK = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_IRON = 'AAAAAAAA-0000-4000-8000-000000000002';
const CATALOG = [
  { id: P_TALAK, name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC', service_lines: ['lawn', 'pest'] },
  { id: P_IRON, name: 'Iron Plus', category: 'micronutrient', formulation: 'SC' },
];
const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Care', status: 'confirmed',
  scheduledDate: '2026-10-04T13:00:00.000Z', propertyId: 'prop-1', catalogServiceId: null,
  address: { line1: '123 Main St', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true, category: 'lawn_care', serviceKey: 'lawn_care_recurring', isCallback: false, technicianId: null,
};
const SERVICE = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Care', address: '123 Main St', timeLabel: '2:00 PM',
  findingsType: null, routedCustomerId: 'cust-1', routedScheduledDate: '2026-10-04', routedPropertyId: 'prop-1', routedAddress: '123 Main St',
};
const planned = (productId, name) => ({ productId, name, applicationMethod: 'spot_treatment', amount: 2, amountUnit: 'fl_oz', approvedForReport: true, wateringRule: null, wateringSummary: 'No rule', mowHoldDays: null });
const context = (recPrepare) => ({
  enabled: true, eligible: true, reason: null, visitType: 'recurring', findingsType: null, service: VISIT, visitDate: '2026-10-04', turfHeightCapture: false,
  plannedProducts: { source: 'plan', items: [planned(P_TALAK, 'Talak 7.9%'), planned(P_IRON, 'Iron Plus')] }, plannedProductsUnavailable: null,
  methods: [{ value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false }],
  assessment: { exists: false, id: null, confirmed: false }, photoStatus: null, previousFrontPhoto: null, readFailures: [],
  ...(recPrepare ? { recPrepare: true } : {}),
});
const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };
const ASSESSED = { id: 'assessment-1', confirmed_by_tech: false, ...SCORES };
const REVIEW = { status: 'complete', findings: [{ finding_id: 'f-1', name: 'Dollarweed', confidence: 'high' }], photoQuality: [] };

let requests;
function makeRequest({ recPrepare = true, prepareFails = false } = {}) {
  return vi.fn(async (path, options = {}) => {
    requests.push({ path, options, body: options.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/lawn-fast/context')) return context(recPrepare);
    if (path.endsWith('/lawn-fast/prepare-recommendations')) {
      if (prepareFails) throw Object.assign(new Error('Server error'), { status: 500 });
      return { enabled: true, started: true };
    }
    if (path.endsWith('/property-areas')) return { enabled: true, propertyId: 'prop-1', customerId: 'cust-1', addressKey: 'k', version: 'a'.repeat(64), areas: { beds: null, lawn: { sqft: 5000, source: 'recorded', reviewedAt: null } } };
    if (/^\/admin\/customers\/[^/]+$/.test(path)) return { customer: { email: '' } };
    if (path.endsWith('/tech-tips')) return { available: false, groups: [] };
    if (path.includes('/blog-posts')) return { available: false, posts: [] };
    if (path === '/admin/dispatch/products/catalog') return { products: CATALOG };
    if (path.includes('/lawn-assessment/service/')) return { shotListEnabled: true, assessment: null };
    if (path.endsWith('/lawn-assessment/assess')) return { success: true, assessment: ASSESSED, visitAssessment: REVIEW, adjustedScores: SCORES, observations: 'Synthetic observation' };
    if (path.endsWith('/lawn-assessment/confirm')) return { success: true, confirmed: true, assessment: { ...ASSESSED, confirmed_by_tech: true }, visitAssessment: REVIEW };
    if (path.endsWith('/complete')) return { success: true, invoiceId: null };
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

async function openSheet(request) {
  render(<FastCompleteLawnSheet service={SERVICE} request={request} catalog={CATALOG} onClose={() => {}} onCompleted={() => {}} onFullForm={() => {}} />);
  await screen.findByRole('heading', { name: 'Lawn assessment' });
}
const completeButton = () => document.querySelector('.tech-visit-footer .tech-visit-complete');
const prepareCalls = () => requests.filter((r) => r.path.endsWith('/lawn-fast/prepare-recommendations'));
const completeCalls = () => requests.filter((r) => r.path.endsWith('/complete'));
// Longer than the sheet's 1.5 s wait after the product list last changed.
const pastSettle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 2200); }); });
async function analyze() {
  const input = await screen.findByLabelText('Add turf photos');
  await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
  fireEvent.change(input, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' })] } });
  await screen.findByLabelText('Slot for photo 1');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze lawn' }));
  await screen.findByLabelText('Density score');
}
async function confirmAssessment() {
  await analyze();
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
  await screen.findByText('Assessment confirmed');
  await waitFor(() => expect(completeButton().disabled).toBe(false));
}

describe('the sheet names its products before the Complete tap', () => {
  test('without the recPrepare key nothing is sent', async () => {
    await openSheet(makeRequest({ recPrepare: false }));
    await confirmAssessment();
    await pastSettle();
    expect(prepareCalls()).toEqual([]);
  });

  test('nothing is sent before the assessment is confirmed; then the confirmed assessment and the product ids are sent once', async () => {
    await openSheet(makeRequest());
    await analyze();
    await pastSettle();
    expect(prepareCalls()).toEqual([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm assessment' }));
    await screen.findByText('Assessment confirmed');
    await waitFor(() => expect(prepareCalls()).toHaveLength(1), { timeout: 5000 });
    expect(prepareCalls()[0].options.method).toBe('POST');
    expect(prepareCalls()[0].body).toEqual({ assessmentId: 'assessment-1', productIds: [P_TALAK, P_IRON.toLowerCase()] });
    await pastSettle();
    expect(prepareCalls()).toHaveLength(1);
  });

  test('a changed product list is sent again', async () => {
    await openSheet(makeRequest());
    await confirmAssessment();
    await waitFor(() => expect(prepareCalls()).toHaveLength(1), { timeout: 5000 });

    fireEvent.click(within(screen.getByRole('group', { name: 'Iron Plus' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(prepareCalls()).toHaveLength(2), { timeout: 5000 });
    expect(prepareCalls()[1].body).toEqual({ assessmentId: 'assessment-1', productIds: [P_TALAK] });
  });

  test('Complete tapped before the list has stood still: the completion is sent and no product list after it', async () => {
    await openSheet(makeRequest());
    await confirmAssessment();
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    await pastSettle();
    expect(prepareCalls()).toEqual([]);
  });

  test('a failed request changes nothing on the sheet: Complete still sends the visit', async () => {
    await openSheet(makeRequest({ prepareFails: true }));
    await confirmAssessment();
    await waitFor(() => expect(prepareCalls()).toHaveLength(1), { timeout: 5000 });
    expect(completeButton().disabled).toBe(false);
    expect(screen.queryByText('Server error')).toBeNull();
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    expect(completeCalls()[0].body.lawnAssessmentId).toBe('assessment-1');
  });
});
