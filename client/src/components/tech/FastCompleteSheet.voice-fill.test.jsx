// @vitest-environment jsdom
// Fast Complete voice fill on the pest re-service sheet (GATE_FAST_COMPLETE_
// VOICE_FILL, delivered as the `voiceFillEnabled` prop): what the tech says
// becomes ordinary taps with a "Heard" line, anything unsettled is a Check that
// holds Complete, and the gate off leaves the sheet as it was. The plan's rules
// are pinned one by one in lib/fast-complete-voice-plan.test.js.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The mics: a supported browser whose transcript the test delivers by hand. The
// sheet's voice mic is the first instance, the visit note's mic the second.
const dictation = vi.hoisted(() => ({ slots: [], state: { listening: false, mode: 'speech', starting: false, uploading: false } }));
vi.mock('../../hooks/useSpeechDictation', async () => {
  const { useRef, useState } = await import('react');
  return {
    default: (onTranscript) => {
      const [, setTick] = useState(0);
      const index = useRef(null);
      if (index.current === null) { index.current = dictation.slots.length; dictation.slots.push(null); }
      dictation.slots[index.current] = { onTranscript, rerender: () => setTick((tick) => tick + 1) };
      return { supported: true, toggle: () => {}, cancel: () => {}, ...dictation.state };
    },
  };
});

import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  dictation.slots = [];
  dictation.state = { listening: false, mode: 'speech', starting: false, uploading: false };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  { id: 'extra', name: 'Advion Ant Bait Gel', category: 'Bait' },
];
const CONTEXT_SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };
const TRANSCRIPT = 'okay so I did the perimeter outside for ants and roaches, Taurus six ounces, five grams of the Advion gel, light activity, 120 linear feet, note for the office the gate code changed, and some other stuff';

const FILL = {
  enabled: true,
  products: [
    { productId: 'taurus', amount: 6, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Taurus six ounces' },
    { productId: 'extra', amount: 5, unit: 'g', sameAsLast: false, method: '', heard: 'five grams of the Advion gel' },
  ],
  visit: {
    pests: ['Ants', 'Roaches'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: 120, activity: 'light',
    heard: 'perimeter outside for ants and roaches, 120 linear feet, light activity',
  },
  customerNote: 'Treated the perimeter for ants and roaches.',
  officeNote: 'The gate code changed.',
  unclear: [{ heard: 'some other stuff', reason: 'unknown_product' }],
};

function makeRequest({ fill = FILL, fillError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, service: CONTEXT_SERVICE, products: CATALOG };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, scaleLabels: null };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.endsWith('/voice-fill')) {
      if (fillError) throw fillError;
      return fill;
    }
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request, props = { voiceFillEnabled: true }) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /Taurus SC/ });
}

// The tech taps the mic, talks (the words arrive in chunks), and taps again.
const setDictation = (patch) => React.act(() => {
  dictation.state = { ...dictation.state, ...patch };
  dictation.slots.forEach((slot) => slot?.rerender());
});
function say(...chunks) {
  setDictation({ listening: true });
  React.act(() => { chunks.forEach((chunk) => dictation.slots[0].onTranscript(chunk)); });
  setDictation({ listening: false });
}
const voiceFillCalls = (request) => request.calls.filter((c) => c.path.endsWith('/voice-fill'));
const completeBodies = (request) => request.calls.filter((c) => c.path.endsWith('/complete')).map((c) => JSON.parse(c.options.body));
const completeButton = () => screen.getByRole('button', { name: 'Complete re-service' });

describe('FastCompleteSheet voice fill, gate off', () => {
  test('no mic, no office note, no request, and the /complete body is the sheet\'s own', async () => {
    const request = makeRequest();
    await openSheet(request, {});

    expect(screen.queryByRole('button', { name: 'Tell me what you did' })).toBeNull();
    expect(screen.queryByLabelText('Office note (not on the report)')).toBeNull();
    // Only the visit note's mic is there.
    expect(dictation.slots).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeBodies(request)).toHaveLength(1));
    const [body] = completeBodies(request);
    expect(Object.keys(body).sort()).toEqual([
      'areasServiced', 'clientPestRating', 'expectedVisit', 'idempotencyKey', 'includePayLink', 'products', 'requestReview',
      'sendCompletionSms', 'techTips', 'technicianNotes', 'visitOutcome',
    ]);
    expect(voiceFillCalls(request)).toHaveLength(0);
  });

  test('the prop must be exactly true', async () => {
    await openSheet(makeRequest(), { voiceFillEnabled: 'yes' });
    expect(screen.queryByRole('button', { name: 'Tell me what you did' })).toBeNull();
  });
});

describe('FastCompleteSheet voice fill, gate on', () => {
  test('shows the big mic and the office note', async () => {
    await openSheet(makeRequest());
    expect(screen.getByRole('button', { name: 'Tell me what you did' })).toBeTruthy();
    expect(screen.getByLabelText('Office note (not on the report)')).toBeTruthy();
  });

  test('what was said becomes ordinary taps, notes and Heard lines; Complete then waits on the Check', async () => {
    const request = makeRequest();
    await openSheet(request);
    say('okay so I did the perimeter outside for ants and roaches, Taurus six ounces,', 'five grams of the Advion gel, light activity, 120 linear feet,', 'note for the office the gate code changed, and some other stuff');

    // Products: the house row's amount changes, the other product is added like "+ Other product".
    expect(await screen.findByRole('button', { name: /Taurus SC — 6 fl oz/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advion Ant Bait Gel — 5 g/ })).toBeTruthy();
    // Visit taps.
    for (const name of ['Ants', 'Roaches', 'Outside', 'Perimeter spray', 'Light']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(screen.getByLabelText('Linear ft sprayed').value).toBe('120');
    // Notes: the customer note joins the visit note; the office note is its own field.
    expect(screen.getByLabelText('Tell me about the visit').value).toBe(FILL.customerNote);
    expect(screen.getByLabelText('Office note (not on the report)').value).toBe(FILL.officeNote);
    // Heard lines, small and muted.
    expect(screen.getByText('Heard: “Taurus six ounces”')).toBeTruthy();
    expect(screen.getByText('Heard: “five grams of the Advion gel”')).toBeTruthy();
    expect(screen.getByText(`Heard: “${FILL.visit.heard}”`)).toBeTruthy();
    // The one thing it could not place is a Check, and it holds Complete.
    const check = screen.getByRole('region', { name: 'Check' });
    expect(within(check).getByText(/some other stuff/)).toBeTruthy();
    expect(within(check).getByText(/not a product on this list/)).toBeTruthy();
    expect(screen.getByText('Check what I couldn\'t fill.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);

    fireEvent.click(within(check).getByRole('button', { name: '✓ Got it' }));
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();
    expect(completeButton().disabled).toBe(false);

    fireEvent.click(completeButton());
    await waitFor(() => expect(completeBodies(request)).toHaveLength(1));
    const [body] = completeBodies(request);
    const byId = Object.fromEntries(body.products.map((p) => [p.productId, p]));
    expect(byId.taurus).toMatchObject({ totalAmount: 6, amountUnit: 'fl_oz', applicationMethod: 'perimeter_spray', areaValue: 120, targets: ['Ants', 'Roaches'], applicationArea: 'Outside' });
    expect(byId.extra).toMatchObject({ totalAmount: 5, amountUnit: 'g' });
    expect(body.areasServiced).toEqual(['Outside']);
    expect(body.technicianNotes).toBe(FILL.customerNote);
    expect(body.clientPestRating).toBe(2);
  });

  test('the customer note joins what the tech already typed', async () => {
    await openSheet(makeRequest());
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Sprayed the garage threshold.' } });
    say('hello');
    await waitFor(() => expect(screen.getByLabelText('Tell me about the visit').value).toBe(`Sprayed the garage threshold. ${FILL.customerNote}`));
  });

  test('a unit the row does not offer leaves the amount alone and becomes a Check', async () => {
    const request = makeRequest({ fill: { ...FILL, products: [{ productId: 'taurus', amount: 6, unit: 'g', sameAsLast: false, method: '', heard: 'Taurus six grams' }], unclear: [] } });
    await openSheet(request);
    say('Taurus six grams');
    const check = await screen.findByRole('region', { name: 'Check' });
    expect(within(check).getByText('Heard “Taurus six grams” — enter the amount for Taurus SC.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Taurus SC — 4 fl oz/ })).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });

  test('a tap the tech already made is kept, and the difference is a Check that fixing the field clears', async () => {
    await openSheet(makeRequest());
    fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
    say('light activity');
    const check = await screen.findByRole('region', { name: 'Check' });
    expect(screen.getByRole('button', { name: 'Heavy' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(check).getByText('You tapped Heavy; heard Light.')).toBeTruthy();

    // Changing the field it points at is the fix.
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    expect(screen.queryByText('You tapped Heavy; heard Light.')).toBeNull();
  });

  test('a Check holds Complete until it is dismissed', async () => {
    const request = makeRequest({ fill: { ...FILL, products: [], visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: '', linearFt: null, activity: 'light', heard: 'ants outside light' }, unclear: [{ heard: 'the fuzzy one', reason: 'ambiguous_product' }, { heard: 'and another', reason: 'unclear_amount' }] } });
    await openSheet(request);
    say('ants outside light');
    await screen.findByRole('region', { name: 'Check' });
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText('Check what I couldn\'t fill.')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '✓ Got it' })[0]);
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '✓ Got it' }));
    expect(completeButton().disabled).toBe(false);
  });

  test('the existing required items still come first', async () => {
    const request = makeRequest({ fill: { ...FILL, products: [], visit: { pests: [], otherPest: '', areas: [], method: '', linearFt: null, activity: '', heard: '' }, customerNote: '', officeNote: '', unclear: [{ heard: 'mumble', reason: 'unclear_other' }] } });
    await openSheet(request);
    say('mumble');
    await screen.findByRole('region', { name: 'Check' });
    expect(screen.getByText('Select at least one pest.')).toBeTruthy();
    expect(screen.queryByText('Check what I couldn\'t fill.')).toBeNull();
  });

  test('the transcript goes to the fill only: not into the note, not on /complete', async () => {
    const request = makeRequest();
    await openSheet(request);
    say(TRANSCRIPT);
    await screen.findByRole('region', { name: 'Check' });

    const [fillCall] = voiceFillCalls(request);
    expect(fillCall.path).toBe('/admin/dispatch/svc-1/fast-complete/voice-fill');
    expect(fillCall.options.method).toBe('POST');
    expect(JSON.parse(fillCall.options.body)).toEqual({ sheet: 'pest_reservice', transcript: TRANSCRIPT });
    expect(screen.getByLabelText('Tell me about the visit').value).not.toContain('perimeter outside for ants and roaches, Taurus');
    expect(screen.getByLabelText('Office note (not on the report)').value).not.toContain('Taurus six ounces');

    fireEvent.click(screen.getByRole('button', { name: '✓ Got it' }));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeBodies(request)).toHaveLength(1));
    const body = completeBodies(request)[0];
    // The raw transcript never rides /complete; internal matters ride only the
    // staff-only officeNote field, never the customer note.
    expect(JSON.stringify(body)).not.toContain(TRANSCRIPT);
    expect(JSON.stringify(body)).not.toContain('some other stuff');
    expect(body.technicianNotes).not.toContain('gate code');
  });

  test('a failed fill shows the short message and the typed sheet stays usable', async () => {
    const err = Object.assign(new Error('Voice fill is unavailable right now. Keep typing.'), { status: 502 });
    const request = makeRequest({ fillError: err });
    await openSheet(request);
    say('anything');
    expect(await screen.findByText('Couldn\'t fill from your words — tap the answers instead')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(completeButton().disabled).toBe(false);
  });

  test('a 404 (gate off on the server) hides the mic without a word', async () => {
    const request = makeRequest({ fillError: Object.assign(new Error('Request failed (404)'), { status: 404 }) });
    await openSheet(request);
    say('anything');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tell me what you did' })).toBeNull());
    expect(screen.queryByText(/Couldn't fill/)).toBeNull();
    expect(screen.queryByLabelText('Office note (not on the report)')).toBeNull();
  });

  test('the office note is editable and rides /complete only as officeNote, never in the customer note', async () => {
    const request = makeRequest({ fill: { ...FILL, unclear: [] } });
    await openSheet(request);
    say('hello');
    const office = await screen.findByLabelText('Office note (not on the report)');
    await waitFor(() => expect(office.value).toBe(FILL.officeNote));
    fireEvent.change(office, { target: { value: 'Gate code is 4-4-4-4 now.' } });
    expect(office.value).toBe('Gate code is 4-4-4-4 now.');

    fireEvent.click(completeButton());
    await waitFor(() => expect(completeBodies(request)).toHaveLength(1));
    const body = completeBodies(request)[0];
    expect(body.officeNote).toBe('Gate code is 4-4-4-4 now.');
    expect(body.technicianNotes).not.toContain('Gate code');
  });

  test('no office note → no officeNote key on /complete', async () => {
    const request = makeRequest({ fill: { ...FILL, officeNote: '', unclear: [] } });
    await openSheet(request);
    say('hello');
    await waitFor(() => expect(screen.getByLabelText('Office note (not on the report)').value).toBe(''));
    fireEvent.click(completeButton());
    await waitFor(() => expect(completeBodies(request)).toHaveLength(1));
    expect(completeBodies(request)[0]).not.toHaveProperty('officeNote');
  });
});
