// @vitest-environment jsdom
// The pest Fast Complete sheet with the "They told us" block (GATE_RESERVICE_ASKS, step S2b of the consolidated
// re-service report; owner 2026-11-02), on both of its forms: the short re-service form and the report flow.
// Flag absent: no read, no block, today's /complete body. Flag on: the block reads the asks, Complete waits for
// every answer, and the answers ride the body as `reserviceAnswers`. A failed read never holds Complete.
// Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => <div role="region" aria-label="Tracer" /> }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => <div role="dialog" aria-label="Photo manager" /> }));

import FastCompleteSheet from './FastCompleteSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
];
const VISIT = {
  id: 'svc-1', customerName: 'Dana Q.', hasPhone: true, customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '100 Example St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const SHORT_SERVICE = {
  id: 'svc-1', customerId: 'cust-1', customerName: 'Dana Q.', serviceType: 'Pest Re-Service', address: '100 Example St', timeLabel: '2:00 PM',
  recapEnabled: true, onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
};
const REPORT_SERVICE = {
  id: 'svc-1', customerName: 'Dana Q.', serviceType: 'Pest Control Re-Service', address: '100 Example St', timeLabel: '9:00 AM',
  reportFlow: true, traceEligible: true, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};
const REPORT = [
  'WHAT WE FOUND', 'You asked us back because ants returned to the kitchen counter.', '',
  'WHAT WE DID AND WHY', 'We placed bait along the counter edge.', '',
  'WHAT TO EXPECT', 'You may see a few more ants near the bait for a few days.', '',
  "WHAT'S NEXT", 'Keeping the counters wiped helps the bait work.',
].join('\n');
const FACTS = { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] };

const ITEMS = [
  { id: 'form:1', source: 'request_form', at: '2026-10-06T14:00:00.000Z', text: 'Ants are back in the kitchen', quoted: true, lead: null, kind: 'problem', pests: ['Ants'] },
  { id: 'text:9', source: 'text', at: '2026-10-08T15:00:00.000Z', text: 'Will it smell?', quoted: true, lead: null, kind: 'question', pests: [] },
];

function makeRequest({ reportFlow = false, asks = { enabled: true, lane: 'pest', window: { from: 'a', to: 'b' }, items: ITEMS }, complete = null } = {}) {
  const calls = [];
  let askReads = 0;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/pest-recap/context')) {
      return { ok: true, eligible: true, ...(reportFlow ? { reportFlow: true } : {}), service: VISIT, products: CATALOG, existingRecord: null };
    }
    if (bare.endsWith('/reservice-asks')) {
      askReads += 1;
      return typeof asks === 'function' ? asks(askReads) : asks;
    }
    if (bare.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (bare.endsWith('/tech-tips')) return { available: false };
    if (bare.endsWith('/promises')) return { available: false, promises: [] };
    if (bare.endsWith('/blog-posts')) return { available: false, posts: [] };
    if (bare.endsWith('/photos')) return { photos: [] };
    if (bare.endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (bare.endsWith('/voice-facts')) return FACTS;
    if (bare.endsWith('/complete')) return complete ? complete(calls.filter((c) => c.path.endsWith('/complete')).length) : { success: true };
    return {};
  });
  request.completes = () => calls.filter((call) => call.path.endsWith('/complete'));
  request.askReads = () => calls.filter((call) => call.path.endsWith('/reservice-asks'));
  return request;
}

const HINT = 'Answer each item in They told us.';
const card = (label) => screen.getByRole('group', { name: label });
const tap = (scope, name) => fireEvent.click(within(scope).getByRole('button', { name }));

describe('the short re-service form', () => {
  const SHORT_FLAGGED = { ...SHORT_SERVICE, reserviceAsksEnabled: true };
  async function openShort(request, service = SHORT_FLAGGED) {
    render(<FastCompleteSheet service={service} request={request} onClose={() => {}} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
  }
  const tapRequired = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
  };
  const completeButton = () => screen.getByRole('button', { name: 'Complete re-service' });

  test.each([['absent', SHORT_SERVICE], ['false', { ...SHORT_SERVICE, reserviceAsksEnabled: false }]])('flag %s: no read, no block, no extra body field', async (_name, service) => {
    const request = makeRequest();
    await openShort(request, service);
    tapRequired();
    expect(screen.queryByText(/They told us/)).toBeNull();
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.askReads()).toHaveLength(0);
    expect(Object.keys(request.completes()[0].body).filter((key) => /reservice|ask/i.test(key))).toEqual([]);
  });

  test('the block leads the sheet, above the products; Complete waits; the answers ride the body', async () => {
    const request = makeRequest();
    await openShort(request);
    expect(await screen.findByText('They told us · 2 items')).toBeTruthy();
    const block = screen.getByRole('region', { name: 'They told us' });
    const products = screen.getByRole('heading', { name: 'Products used' }).closest('section');
    expect(block.compareDocumentPosition(products) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card('Request form · Oct 6')).getByText('“Ants are back in the kitchen”')).toBeTruthy();
    tapRequired();
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText(HINT)).toBeTruthy();

    tap(card('Request form · Oct 6'), 'Treated');
    const picker = within(card('Request form · Oct 6')).getByRole('group', { name: 'Products used for this item' });
    // Every row on the completion is offered (the house mix); none names ants, so they stay in sheet order.
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Taurus SC', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']);
    tap(picker, 'Atticus Talak 7.9 F');
    fireEvent.change(within(card('Question · Oct 8')).getByLabelText('Your answer'), { target: { value: 'No, the smell fades fast.' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByText(HINT)).toBeNull();

    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body.reserviceAnswers).toEqual({
      items: [
        { itemId: 'form:1', answer: 'treated', productIds: ['talstar'] },
        { itemId: 'text:9', answer: 'answered', text: 'No, the smell fades fast.' },
      ],
    });
  });

  test('the server\'s 400 shows in plain words; a failed read does not hold Complete and sends nothing', async () => {
    const failing = makeRequest({ asks: () => { throw Object.assign(new Error('Server error'), { status: 500 }); } });
    await openShort(failing);
    expect(await screen.findByText('Could not load what the customer told us.')).toBeTruthy();
    tapRequired();
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(failing.completes()).toHaveLength(1));
    expect(failing.completes()[0].body).not.toHaveProperty('reserviceAnswers');
    cleanup();

    const refused = makeRequest({
      asks: { enabled: true, lane: 'pest', items: [ITEMS[1]] },
      complete: () => { throw Object.assign(new Error('Leave web links out of the answer.'), { status: 400, code: 'reservice_answer_invalid' }); },
    });
    await openShort(refused);
    await screen.findByText('They told us · 1 item');
    tapRequired();
    fireEvent.change(within(card('Question · Oct 8')).getByLabelText('Your answer'), { target: { value: 'Yes.' } });
    fireEvent.click(completeButton());
    expect(await screen.findByText('Leave web links out of the answer.')).toBeTruthy();
  });

  test.each([
    ['gate off (404)', () => { throw Object.assign(new Error('x'), { status: 404 }); }],
    ['not a re-service (409)', () => { throw Object.assign(new Error('x'), { status: 409 }); }],
  ])('%s: no block and nothing held', async (_name, asks) => {
    const request = makeRequest({ asks });
    await openShort(request);
    await waitFor(() => expect(request.askReads()).toHaveLength(1));
    tapRequired();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByText(/They told us|Could not load/)).toBeNull();
  });
});

describe('the report flow', () => {
  const FLAGGED = { ...REPORT_SERVICE, reserviceAsksEnabled: true };
  async function openReport(request, service = FLAGGED) {
    render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} />);
    await screen.findByText(/Taurus SC 4 fl oz/);
  }
  async function generate() {
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Ghost ants on the counter, light. Baited the counter edge.' } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
  }

  test('flag absent: no read, no block, no extra body field', async () => {
    const request = makeRequest({ reportFlow: true });
    await openReport(request, REPORT_SERVICE);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.askReads()).toHaveLength(0);
    expect(screen.queryByText(/They told us/)).toBeNull();
    expect(Object.keys(request.completes()[0].body).filter((key) => /reservice|ask/i.test(key))).toEqual([]);
  });

  test('the block leads the visit step; Complete & send waits on the report step until every item is answered', async () => {
    const request = makeRequest({ reportFlow: true });
    await openReport(request);
    expect(await screen.findByText('They told us · 2 items')).toBeTruthy();
    // Generating the report is not held by the answers.
    await generate();
    const complete = screen.getByRole('button', { name: 'Complete & send' });
    expect(complete.disabled).toBe(true);
    // The block is on the visit step, so the report step's hold says where to go.
    expect(screen.getByText('Go back to the visit and answer each item in They told us.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    tap(card('Request form · Oct 6'), 'Treated');
    tap(within(card('Request form · Oct 6')).getByRole('group', { name: 'Products used for this item' }), 'Taurus SC');
    tap(card('Question · Oct 8'), 'Not about this visit');
    // The report is still current: the answers are not part of what it was written from.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the report' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
    expect(screen.queryByText(/answer each item in They told us/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body.reserviceAnswers).toEqual({
      items: [
        { itemId: 'form:1', answer: 'treated', productIds: ['taurus'] },
        { itemId: 'text:9', answer: 'hidden' },
      ],
    });
  });

  test('a failed read shows the notice with Retry and does not hold Complete & send', async () => {
    const request = makeRequest({ reportFlow: true, asks: () => { throw Object.assign(new Error('Server error'), { status: 500 }); } });
    await openReport(request);
    expect(await screen.findByText('Could not load what the customer told us.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await generate();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false);
  });
});
