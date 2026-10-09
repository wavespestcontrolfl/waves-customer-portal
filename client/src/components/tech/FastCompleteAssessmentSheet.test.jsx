// @vitest-environment jsdom
// Waves Assessment Fast Complete: a note and an outcome pick gate Complete, the
// outcome is recorded before the completion goes out, and the /complete body
// carries only what the tech said (no products, rating, texts or review ask),
// with the inspection credit sent only when its toggle was shown.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteAssessmentSheet, { assessmentCompletionBody, assessmentVisitIdentity } from './FastCompleteAssessmentSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The schedule row Dispatch passes (DispatchPageV2.jsx).
const SERVICE = {
  id: 'svc-a',
  customerName: 'Pat Jones',
  serviceType: 'Waves Assessment',
  address: '123 Main St',
  timeLabel: '2:00 PM',
  routedCustomerId: 'cust-1',
  routedScheduledDate: '2026-10-09',
  routedPropertyId: 'prop-1',
  routedServiceType: 'Waves Assessment',
  completionProfile: { category: 'inspection', serviceKey: 'lawn_inspection' },
  inspectionCreditAvailable: true,
};

const notFound = () => Object.assign(new Error('No outcome recorded for that visit'), { status: 404 });

function makeRequest({ row = null, loadError = null, outcomeError = null, completeError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (path === '/admin/consultations/svc-a/outcome') {
      if (!options.method) {
        if (loadError) throw loadError;
        if (!row) throw notFound();
        return { outcome: row };
      }
      if (outcomeError) throw outcomeError;
      return { outcome: { id: 'out-1' } };
    }
    if (path === '/tech/services/svc-a/photos') return { photos: [] };
    if (path === '/admin/dispatch/svc-a/complete') {
      if (completeError) throw completeError;
      return { success: true };
    }
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest(), service = SERVICE, props = {}) {
  render(<FastCompleteAssessmentSheet service={service} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: 'Warm' });
  return request;
}

const note = () => screen.getByLabelText('Tell me about the visit');
const completeButton = () => screen.getByRole('button', { name: 'Complete assessment' });
const posts = (request, suffix) => request.calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));

describe('FastCompleteAssessmentSheet', () => {
  test('shows the note, photos, outcome and recommended sections, and nothing about products, rating or texts', async () => {
    await openSheet();
    expect(note()).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How did it go' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quarterly pest' })).toBeTruthy();
    expect(screen.queryByText(/product/i)).toBeNull();
    expect(screen.queryByText(/rating|pest pressure|review|customer text/i)).toBeNull();
  });

  test('Complete is blocked without a note, then without an outcome, and nothing is sent', async () => {
    const request = await openSheet();
    expect(screen.getByText('Tell me about the visit.', { selector: 'p' })).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(note(), { target: { value: 'Walked the yard with the owner.' } });
    expect(screen.getByText('Pick warm, cold or lost')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(completeButton());
    expect(posts(request, '/outcome')).toHaveLength(0);
    expect(posts(request, '/complete')).toHaveLength(0);
    // A lost pick needs its reason.
    fireEvent.click(screen.getByRole('button', { name: 'Lost' }));
    expect(screen.getByText('Pick why it was lost')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Competitor' }));
    expect(screen.queryByText('Pick why it was lost')).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('records the outcome first, then posts the complete body, and the credit rides as the explicit boolean', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: '  Chinch bugs in the front, wants a quote.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lawn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mosquito' }));
    fireEvent.click(completeButton());

    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    const writes = request.calls.filter((call) => call.method === 'POST').map((call) => call.path);
    expect(writes).toEqual(['/admin/consultations/svc-a/outcome', '/admin/dispatch/svc-a/complete']);

    expect(posts(request, '/outcome')[0].body).toEqual({
      outcome: 'warm', lostReason: null, interests: ['lawn', 'mosquito'], quotedAmount: null,
      quotedCadence: null, quoteNotes: null, followUpAt: null,
    });
    const body = posts(request, '/complete')[0].body;
    const { idempotencyKey, ...rest } = body;
    expect(typeof idempotencyKey).toBe('string');
    expect(rest).toEqual({
      visitOutcome: 'completed',
      expectedVisit: { customerId: 'cust-1', propertyId: 'prop-1', serviceType: 'Waves Assessment', scheduledDate: '2026-10-09' },
      technicianNotes: 'Chinch bugs in the front, wants a quote.',
      offerInspectionCredit: true,
      sendCompletionSms: false,
      requestReview: false,
    });
    // Never a product, a rating or a photo list.
    for (const key of ['products', 'clientPestRating', 'completionPhotos', 'photos', 'customerRecap']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test('turning the credit off sends false', async () => {
    const request = await openSheet();
    const toggle = screen.getByRole('button', { name: 'Credit this inspection toward booked service' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    fireEvent.change(note(), { target: { value: 'Quick look.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cold' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body.offerInspectionCredit).toBe(false);
  });

  test.each([
    ['the credit lane is off', { inspectionCreditAvailable: false }],
    ['the profile is not an inspection', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_inspection' } }],
    ['the profile read failed', { completionProfileLookupFailed: true }],
  ])('the credit toggle is hidden when %s, and the field is not sent', async (_label, overrides) => {
    const request = await openSheet(makeRequest(), { ...SERVICE, ...overrides });
    expect(screen.queryByRole('button', { name: 'Credit this inspection toward booked service' })).toBeNull();
    fireEvent.change(note(), { target: { value: 'Quick look.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cold' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body).not.toHaveProperty('offerInspectionCredit');
  });

  test('a failed outcome write stops before the completion and shows why; a second tap tries again', async () => {
    const request = makeRequest({ outcomeError: Object.assign(new Error('That consultation has not started yet'), { status: 409, code: 'CONSULTATION_IN_FUTURE' }) });
    await openSheet(request);
    fireEvent.change(note(), { target: { value: 'Early look.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(completeButton());
    expect(await screen.findByText('That consultation has not started yet')).toBeTruthy();
    expect(posts(request, '/complete')).toHaveLength(0);
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/outcome')).toHaveLength(2));
    expect(posts(request, '/complete')).toHaveLength(0);
  });

  test('a recorded read starts the form, and its quote and follow-up date ride through unchanged', async () => {
    const row = {
      outcome: 'cold', lost_reason: null, interests: ['termite'], quoted_amount: '129.5', quoted_cadence: 'quarter',
      quote_notes: 'Side yard ants', follow_up_at: '2026-11-01T13:00:00.000Z',
    };
    const request = makeRequest({ row });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Cold' });
    expect(screen.getByRole('button', { name: 'Cold' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Termite' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(note(), { target: { value: 'Second look.' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/outcome')[0].body).toEqual({
      outcome: 'cold', lostReason: null, interests: ['termite'], quotedAmount: '129.5',
      quotedCadence: 'quarter', quoteNotes: 'Side yard ants', followUpAt: '2026-11-01T13:00:00.000Z',
    });
  });

  test('a converted (won) consultation keeps its read: no pick is asked and no outcome is written', async () => {
    const request = makeRequest({ row: { outcome: 'won', won_at: '2026-10-08T15:00:00.000Z', won_via: 'estimate_accept', interests: [] } });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText(/This consultation converted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Warm' })).toBeNull();
    fireEvent.change(note(), { target: { value: 'Follow-up walk.' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/outcome')).toHaveLength(0);
  });

  test('an unreadable recorded read stops the sheet instead of writing over it', async () => {
    const request = makeRequest({ loadError: Object.assign(new Error('Could not load this consultation'), { status: 500 }) });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText(/Could not load this consultation/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Warm' })).toBeNull();
    expect(posts(request, '/outcome')).toHaveLength(0);
  });

  test('a retry after a dropped completion resends it and does not write the outcome again', async () => {
    const request = makeRequest({ completeError: Object.assign(new Error('Network down'), { status: 503 }) });
    await openSheet(request);
    fireEvent.change(note(), { target: { value: 'Looked fine.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(completeButton());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(2));
    expect(posts(request, '/outcome')).toHaveLength(1);
    // Same body, same idempotency key.
    expect(posts(request, '/complete')[1].body).toEqual(posts(request, '/complete')[0].body);
  });
});

describe('assessment sheet helpers', () => {
  test('the visit identity leaves out what the row does not carry', () => {
    expect(assessmentVisitIdentity({ routedCustomerId: null, routedPropertyId: undefined, routedServiceType: null, routedScheduledDate: null })).toEqual({});
    expect(assessmentVisitIdentity({ routedPropertyId: null })).toEqual({ propertyId: null });
  });

  test('the body omits the credit unless it is a boolean and the identity unless it has keys', () => {
    expect(assessmentCompletionBody({ note: ' x ', offerCredit: null, expectedVisit: {} })).toEqual({
      visitOutcome: 'completed', technicianNotes: 'x', sendCompletionSms: false, requestReview: false,
    });
  });
});
