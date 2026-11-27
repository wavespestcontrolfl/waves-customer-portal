// @vitest-environment jsdom
// The note step on the pest Fast Complete sheet (GATE_REPORT_OWN_NOTE, report speed plan step 2): on a plain pest
// visit the customer's report shows the tech's own note, as POST /pest-recap/report-note tidied it, in place of the
// writer's report. These pin the request, what the report step shows, the /complete body (the note as said plus the
// tidied text, no draft base), and the old writer path when the step is off or fails.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));

import FastCompleteSheet from './FastCompleteSheet';
import { fixedNoteLine } from './FastCompleteReport';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'LESCO Crosscheck Plus', category: 'Insecticide' },
];
const VISIT = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-01', address: { line1: '123 Main St' },
  serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const REPORT = [
  'WHAT WE FOUND', 'Ghost ants were trailing along the counter.', '',
  'WHAT WE DID AND WHY', 'We placed bait along the counter edge.', '',
  'WHAT TO EXPECT', 'You may see a few more ants for a few days.', '',
  "WHAT'S NEXT", 'Keeping the counters wiped helps the bait work.',
].join('\n');
const NOTE = '  Ghost ants on the kitchen counter, light. Baited the counter edge.  ';
const TIDIED = 'Our technician said ghost ants were on the kitchen counter and baited the counter edge.';
const FACTS = { available: true, status: 'read', areas: ['Inside'], pests: ['ghost ants'] };

// As utils/admin-fetch throws: the status, the server's code and its parsed body.
function httpError(status, details = null) {
  const err = new Error(details?.error || `HTTP ${status}`);
  err.status = status;
  if (details?.code) err.code = details.code;
  if (details) err.details = details;
  return err;
}
const GATE_OFF = () => httpError(404, { enabled: false });
const NOTE_GONE_403 = 'This visit is no longer yours to complete. Close the sheet and open your schedule again.';

// `reportNote`: the note step's answer, an Error it throws, or a function of the call count.
function makeRequest({ reportNote, complete = () => ({ success: true }) }) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) {
      return { ok: true, eligible: true, taurusYearly: { count: 0, high: 0, low: 0, eligible: true, year: 2026 }, reportFlow: true, service: VISIT, products: CATALOG };
    }
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (path.endsWith('/pest-recap/report-note')) {
      const answer = typeof reportNote === 'function' ? reportNote(calls.filter((c) => c.path.endsWith('/report-note')).length) : reportNote;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/voice-facts')) return FACTS;
    if (path.endsWith('/complete')) return complete(calls.filter((c) => c.path.endsWith('/complete')).length);
    return {};
  });
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

const SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Quarterly Pest Control', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, traceEligible: true, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};

async function writeReport(request, heading) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} />);
  await screen.findByText(/Taurus SC 1.6 fl oz/);
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
  fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText(heading, {}, { timeout: 10000 });
}

async function send(request) {
  fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
  await screen.findByTestId('fast-complete-sent', {}, { timeout: 10000 });
  return request.bodies('/complete')[0];
}

describe('the note step answers', () => {
  test('a tidied note is the report: no writer call, read only, and /complete carries the note as said plus the tidied text', async () => {
    const request = makeRequest({ reportNote: { ok: true, source: 'cleaned', text: TIDIED } });
    await writeReport(request, 'Your note on the customer’s report');
    expect(request.bodies('/report-note')).toEqual([{ note: NOTE }]);
    expect(request.bodies('/generate-report')).toEqual([]);
    expect(screen.getByText(TIDIED)).toBeTruthy();
    expect(screen.getByText('From your note')).toBeTruthy();
    // The text is not edited on the sheet: the tech changes the note and writes again.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    const body = await send(request);
    expect(body.technicianNotes).toBe(NOTE.trim());
    expect(body.reportNote).toEqual({ source: 'cleaned', text: TIDIED });
    expect(body).not.toHaveProperty('reportDraftBase');
  });

  test('the standard sentence says why, and goes out as the fixed note', async () => {
    const fixedText = 'Your technician completed your pest control service today.';
    const request = makeRequest({ reportNote: { ok: true, source: 'fixed', text: fixedText, reason: 'writer_unavailable' } });
    await writeReport(request, 'Your note on the customer’s report');
    expect(screen.getByText('Standard sentence')).toBeTruthy();
    expect(screen.getByText(fixedNoteLine('writer_unavailable'))).toBeTruthy();
    const body = await send(request);
    expect(body.reportNote).toEqual({ source: 'fixed', text: fixedText });
    expect(body.technicianNotes).toBe(NOTE.trim());
  });
});

describe('the note step off or failing writes the report the old way', () => {
  test('gate off (404): the writer report, no note on /complete, and the sheet does not ask again', async () => {
    const request = makeRequest({ reportNote: GATE_OFF() });
    await writeReport(request, 'Report the customer will see');
    expect(request.bodies('/generate-report')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Write again' }));
    await waitFor(() => expect(request.bodies('/generate-report')).toHaveLength(2));
    expect(request.bodies('/report-note')).toHaveLength(1);
    await screen.findByText('Report the customer will see');
    const body = await send(request);
    expect(body).not.toHaveProperty('reportNote');
    expect(body.reportDraftBase).toBe(REPORT);
    expect(body.technicianNotes).toBe(REPORT);
  });

  test('an outage (503) falls back to the writer, and the next write asks the note step again', async () => {
    const request = makeRequest({ reportNote: (n) => (n === 1 ? httpError(503) : { ok: true, source: 'cleaned', text: TIDIED }) });
    await writeReport(request, 'Report the customer will see');
    fireEvent.click(screen.getByRole('button', { name: 'Write again' }));
    await screen.findByText('Your note on the customer’s report', {}, { timeout: 10000 });
    expect(request.bodies('/report-note')).toHaveLength(2);
    const body = await send(request);
    expect(body.reportNote).toEqual({ source: 'cleaned', text: TIDIED });
  });

  test('an answer in no shape the sheet reads is no note', async () => {
    const request = makeRequest({ reportNote: { ok: true, source: 'other', text: TIDIED } });
    await writeReport(request, 'Report the customer will see');
    const body = await send(request);
    expect(body).not.toHaveProperty('reportNote');
  });
});

describe('a visit the note step no longer gives this tech', () => {
  test.each([
    ['reassigned (403)', httpError(403, { code: 'service_not_assigned' }), NOTE_GONE_403],
    ['gone (404 not_found)', httpError(404, { code: 'not_found' }), 'This visit was not found. Close the sheet and open your schedule again.'],
    ['left with no customer (409)', httpError(409, { code: 'visit_has_no_customer' }), 'This visit has no customer on it now. Close the sheet and ask the office.'],
  ])('%s: no writer call, the sheet says so, and the next write asks again', async (_label, refusal, message) => {
    const request = makeRequest({ reportNote: refusal });
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} />);
    await screen.findByText(/Taurus SC 1.6 fl oz/);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    expect(await screen.findByText(message, {}, { timeout: 10000 })).toBeTruthy();
    expect(request.bodies('/generate-report')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request.bodies('/report-note')).toHaveLength(2));
    expect(request.bodies('/generate-report')).toEqual([]);
  }, 30000);
});

test('a rewrite that finds the visit reassigned drops the earlier draft: no Complete & send', async () => {
  const request = makeRequest({ reportNote: (n) => (n === 1 ? { ok: true, source: 'cleaned', text: TIDIED } : httpError(403, { code: 'service_not_assigned' })) });
  await writeReport(request, 'Your note on the customer’s report');
  fireEvent.click(screen.getByRole('button', { name: 'Write again' }));
  expect(await screen.findByText(NOTE_GONE_403, {}, { timeout: 10000 })).toBeTruthy();
  expect(screen.queryByText(TIDIED)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
  expect(request.bodies('/complete')).toEqual([]);
}, 30000);

test('the note step turned off between the preview and the send: the form stays, the writer report goes out under a new key', async () => {
  const off = httpError(409, { code: 'REPORT_NOTE_OFF', error: 'The report note is turned off. Write the report again, then send.' });
  const request = makeRequest({
    reportNote: { ok: true, source: 'cleaned', text: TIDIED },
    complete: (n) => { if (n === 1) throw off; return { success: true }; },
  });
  await writeReport(request, 'Your note on the customer’s report');
  fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
  expect(await screen.findByText('The report note is turned off. Write the report again, then send.', {}, { timeout: 10000 })).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
  expect(request.bodies('/report-note')).toHaveLength(1);
  const [first, second] = [await send(request), request.bodies('/complete')[1]];
  expect(first.reportNote).toEqual({ source: 'cleaned', text: TIDIED });
  expect(second).not.toHaveProperty('reportNote');
  expect(second.technicianNotes).toBe(REPORT);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
}, 30000);

test('each standard-sentence reason has its own line', () => {
  const lines = ['timeout', 'no_note', 'note_too_long', 'nothing_for_customer', 'stored_code'].map(fixedNoteLine);
  expect(new Set(lines).size).toBe(5);
  expect(fixedNoteLine('screen_unavailable')).toBe(fixedNoteLine('timeout'));
});
