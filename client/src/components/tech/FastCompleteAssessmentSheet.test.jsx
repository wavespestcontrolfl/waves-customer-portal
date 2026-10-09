// @vitest-environment jsdom
// Waves Assessment Fast Complete: a note and an outcome pick gate Complete, the
// outcome is recorded before the completion goes out, and the /complete body
// carries only what the tech said (no products, rating, texts or review ask),
// with the inspection credit sent only when its toggle was shown.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteAssessmentSheet, { assessmentCompletionBody, assessmentVisitIdentity } from './FastCompleteAssessmentSheet';

// The admin shell hands the server-returned role down through its Outlet context.
let mockRole = 'admin';
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useOutletContext: () => (mockRole ? { user: { role: mockRole } } : undefined),
}));

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { mockRole = 'admin'; vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
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

function makeRequest({ row = null, loadError = null, completeError = null, estimate = undefined, estimateError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (path === '/admin/consultations/svc-a/outcome') {
      if (!options.method) {
        if (loadError) throw loadError;
        if (!row) throw notFound();
        return { outcome: row };
      }
      // The sheet never writes here: the read rides the completion.
      throw new Error('unexpected outcome write');
    }
    if (path === '/admin/consultations/svc-a/estimate') {
      if (estimateError) throw estimateError;
      return estimate === undefined ? {} : { estimate };
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
    expect(posts(request, '/complete')).toHaveLength(0);
    // A lost pick needs its reason.
    fireEvent.click(screen.getByRole('button', { name: 'Lost' }));
    expect(screen.getByText('Pick why it was lost')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Competitor' }));
    expect(screen.queryByText('Pick why it was lost')).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('makes exactly one write: the read rides the complete body, and the credit rides as the explicit boolean', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: '  Chinch bugs in the front, wants a quote.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lawn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mosquito' }));
    fireEvent.click(completeButton());

    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    const writes = request.calls.filter((call) => call.method === 'POST').map((call) => call.path);
    expect(writes).toEqual(['/admin/dispatch/svc-a/complete']);

    const body = posts(request, '/complete')[0].body;
    const { idempotencyKey, ...rest } = body;
    expect(typeof idempotencyKey).toBe('string');
    expect(rest).toEqual({
      visitOutcome: 'completed',
      expectedVisit: { customerId: 'cust-1', propertyId: 'prop-1', serviceType: 'Waves Assessment', scheduledDate: '2026-10-09' },
      technicianNotes: 'Chinch bugs in the front, wants a quote.',
      consultationOutcome: {
        outcome: 'warm', lostReason: null, interests: ['lawn', 'mosquito'], quotedAmount: null,
        quotedCadence: null, quoteNotes: null, followUpAt: null,
      },
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

  test('a refusal of the read inside the completion shows the server\'s words, and closing refreshes the schedule', async () => {
    const onClose = vi.fn();
    const request = makeRequest({ completeError: Object.assign(new Error('This visit changed since it was opened.'), { status: 409, code: 'visit_identity_changed' }) });
    await openSheet(request, SERVICE, { onClose });
    fireEvent.change(note(), { target: { value: 'Looked fine.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(completeButton());
    expect(await screen.findByText('This visit changed since it was opened.')).toBeTruthy();
    expect(request.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
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
    expect(posts(request, '/complete')[0].body.consultationOutcome).toEqual({
      outcome: 'cold', lostReason: null, interests: ['termite'], quotedAmount: '129.5',
      quotedCadence: 'quarter', quoteNotes: 'Side yard ants', followUpAt: '2026-11-01T13:00:00.000Z',
    });
  });

  test('a converted (won) consultation keeps its read: no pick is asked and no outcome is sent', async () => {
    const request = makeRequest({ row: { outcome: 'won', won_at: '2026-10-08T15:00:00.000Z', won_via: 'estimate_accept', interests: [] } });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText(/This consultation converted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Warm' })).toBeNull();
    fireEvent.change(note(), { target: { value: 'Follow-up walk.' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body).not.toHaveProperty('consultationOutcome');
  });

  test('an unreadable recorded read stops the sheet instead of writing over it, and closing refreshes the schedule', async () => {
    const onClose = vi.fn();
    const request = makeRequest({ loadError: Object.assign(new Error('Could not load this consultation'), { status: 500 }) });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={onClose} />);
    expect(await screen.findByText(/Could not load this consultation/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Warm' })).toBeNull();
    expect(request.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a clean close without any failure does not ask for a refresh', async () => {
    const onClose = vi.fn();
    await openSheet(makeRequest(), SERVICE, { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(undefined);
  });

  test('a retry after a dropped completion resends the same body and key', async () => {
    const request = makeRequest({ completeError: Object.assign(new Error('Network down'), { status: 503 }) });
    await openSheet(request);
    fireEvent.change(note(), { target: { value: 'Looked fine.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(completeButton());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(2));
    // Same body, same idempotency key.
    expect(posts(request, '/complete')[1].body).toEqual(posts(request, '/complete')[0].body);
  });
});

const SENT_ESTIMATE = {
  state: 'found',
  estimate: {
    id: 'est-1', slug: 'EST-2026-0001', status: 'sent', sentAt: '2026-10-03T14:00:00.000Z',
    createdAt: '2026-10-02T14:00:00.000Z', monthlyTotal: 59, annualTotal: 708, onetimeTotal: 0,
  },
};

describe('the call-back date', () => {
  const dateField = () => screen.getByLabelText('Call back on');

  test('is optional: left blank, the complete body carries followUpAt null and Complete is not blocked', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: 'Walked it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    expect(screen.getByText(/Leave blank for the default: warm in 3 days, cold in 30\./)).toBeTruthy();
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body.consultationOutcome.followUpAt).toBeNull();
  });

  test('a picked date rides the same consultationOutcome as 9 AM that day, in the one write', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: 'Walked it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cold' }));
    fireEvent.change(dateField(), { target: { value: '2026-10-20' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(request.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual(['/admin/dispatch/svc-a/complete']);
    expect(posts(request, '/complete')[0].body.consultationOutcome.followUpAt).toBe('2026-10-20T09:00');
  });

  test('a lost outcome has no call-back date, and none is sent even after one was picked', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: 'Not buying.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.change(dateField(), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lost' }));
    expect(screen.queryByLabelText('Call back on')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'DIY' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body.consultationOutcome.followUpAt).toBeNull();
  });

  test('a clearing of a picked date sends null, so the server default applies', async () => {
    const request = await openSheet();
    fireEvent.change(note(), { target: { value: 'Walked it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.change(dateField(), { target: { value: '2026-10-20' } });
    fireEvent.change(dateField(), { target: { value: '' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body.consultationOutcome.followUpAt).toBeNull();
  });

  test('a saved date is shown and, untouched, rides unchanged; a changed outcome does not carry it', async () => {
    const row = { outcome: 'warm', interests: [], follow_up_at: '2026-11-01T13:00:00.000Z' };
    const request = makeRequest({ row });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Warm' });
    expect(dateField().value).toBe('2026-11-01');
    fireEvent.change(note(), { target: { value: 'Second look.' } });
    // Switching the outcome drops the saved date from view, as it drops it from the write.
    fireEvent.click(screen.getByRole('button', { name: 'Cold' }));
    expect(dateField().value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    expect(dateField().value).toBe('2026-11-01');
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(posts(request, '/complete')[0].body.consultationOutcome.followUpAt).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('the estimate line', () => {
  const links = () => screen.getAllByRole('link');

  test('shows the estimate\'s own total, status and a staff link; nothing to type', async () => {
    const request = makeRequest({ estimate: SENT_ESTIMATE });
    await openSheet(request);
    expect(await screen.findByText('Estimate: $59.00 / month · Sent Oct 3')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open estimate' });
    expect(link.getAttribute('href')).toBe('/admin/estimates?estimateId=est-1');
    expect(link.getAttribute('target')).toBe('_blank');
    // Never the customer's token link.
    expect(links().map((a) => a.getAttribute('href')).join(' ')).not.toMatch(/token|\/estimate\//);
    // No price input anywhere on the sheet.
    expect(screen.queryByPlaceholderText('$')).toBeNull();
    expect(screen.queryByLabelText(/price|amount|quote/i)).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(request.calls.filter((call) => call.path.endsWith('/estimate'))).toEqual([{ path: '/admin/consultations/svc-a/estimate', method: 'GET', body: null }]);
  });

  test('a draft says it is not sent; an annual and one-time total read as the estimate states them', async () => {
    await openSheet(makeRequest({ estimate: { state: 'found', estimate: { ...SENT_ESTIMATE.estimate, status: 'draft', sentAt: null, monthlyTotal: 0, annualTotal: 708, onetimeTotal: 150 } } }));
    expect(await screen.findByText('Estimate: $708.00 / year + $150.00 one-time · Not sent yet')).toBeTruthy();
  });

  test('"No estimate yet" with a link that starts one for this customer', async () => {
    await openSheet(makeRequest({ estimate: { state: 'none' } }));
    expect(await screen.findByText('No estimate yet')).toBeTruthy();
    const href = screen.getByRole('link', { name: 'Create estimate' }).getAttribute('href');
    expect(href).toContain('/admin/estimates?');
    expect(href).toContain('customerId=cust-1');
  });

  test('a retired (declined, expired or archived) estimate shows no amount and no open link', async () => {
    await openSheet(makeRequest({ estimate: { state: 'retired', status: 'declined' } }));
    expect(await screen.findByText('No current estimate · the last one was declined')).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open estimate' })).toBeNull();
  });

  test.each([
    ['more than one live estimate', { state: 'ambiguous' }],
    ['an unreadable estimate', { state: 'unavailable' }],
  ])('shows nothing for %s', async (_label, estimate) => {
    const request = makeRequest({ estimate });
    await openSheet(request);
    await waitFor(() => expect(request.calls.some((call) => call.path.endsWith('/estimate'))).toBe(true));
    expect(screen.queryByText(/estimate/i)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('a failed estimate read does not block the sheet or the completion', async () => {
    const request = makeRequest({ estimateError: Object.assign(new Error('boom'), { status: 500 }) });
    await openSheet(request);
    fireEvent.change(note(), { target: { value: 'Walked it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    expect(screen.queryByText(/No estimate yet/)).toBeNull();
  });

  test('the estimate figure never reaches the write: the saved quote rides through, an estimate total is not copied in', async () => {
    const row = { outcome: 'warm', interests: [], quoted_amount: '129.5', quoted_cadence: 'quarter', quote_notes: 'Side yard' };
    const request = makeRequest({ row, estimate: SENT_ESTIMATE });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    await screen.findByText('Estimate: $59.00 / month · Sent Oct 3');
    fireEvent.change(note(), { target: { value: 'Second look.' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(posts(request, '/complete')).toHaveLength(1));
    const outcome = posts(request, '/complete')[0].body.consultationOutcome;
    expect(outcome).toMatchObject({ quotedAmount: '129.5', quotedCadence: 'quarter', quoteNotes: 'Side yard' });
    expect(Object.values(outcome).filter((v) => v === 59 || v === '59' || v === '59.00')).toEqual([]);
  });

  test.each([['technician'], [null]])('role %s: the estimate line shows, with no Open estimate link', async (role) => {
    mockRole = role;
    await openSheet(makeRequest({ estimate: SENT_ESTIMATE }));
    expect(await screen.findByText('Estimate: $59.00 / month · Sent Oct 3')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('a technician with no estimate sees "No estimate yet" and no Create estimate link', async () => {
    mockRole = 'technician';
    await openSheet(makeRequest({ estimate: { state: 'none' } }));
    expect(await screen.findByText('No estimate yet')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('a won consultation still shows the estimate line', async () => {
    const request = makeRequest({ row: { outcome: 'won', won_at: '2026-10-08T15:00:00.000Z', interests: [] }, estimate: SENT_ESTIMATE });
    render(<FastCompleteAssessmentSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('Estimate: $59.00 / month · Sent Oct 3')).toBeTruthy();
  });
});

describe('assessment sheet helpers', () => {
  test('the visit identity leaves out what the row does not carry', () => {
    expect(assessmentVisitIdentity({ routedCustomerId: null, routedPropertyId: undefined, routedServiceType: null, routedScheduledDate: null })).toEqual({});
    expect(assessmentVisitIdentity({ routedPropertyId: null })).toEqual({ propertyId: null });
  });

  test('the body omits the credit unless it is a boolean and the identity unless it has keys', () => {
    expect(assessmentCompletionBody({ note: ' x ', offerCredit: null, expectedVisit: {}, consultationOutcome: null })).toEqual({
      visitOutcome: 'completed', technicianNotes: 'x', sendCompletionSms: false, requestReview: false,
    });
  });
});
