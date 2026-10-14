// @vitest-environment jsdom
// The stop-level Wrap-up of the grouped pest + lawn container (GATE_FAST_COMPLETE_WRAP_UP with GATE_COMBO_FAST_COMPLETE; owner
// 2026-10-12): one section above "Complete stop" (clock, completion text, review request with timing, next visit; no pay-link,
// time-correction or re-entry rows). Its choices are laid onto BOTH item bodies at send; untouched, the posted packet is exactly
// today's. The parts are stubs that hand up bodies the way the real sheets do (pest: no reviewTiming; lawn: reviewTiming 'auto').
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React, { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FastCompleteComboSheet from './FastCompleteComboSheet';
import { adminFetch } from '../../utils/admin-fetch';
import * as store from '../../lib/completion-resume-store';
import { reviewScheduledForOf } from '../../lib/completion-review-timing';

vi.setConfig({ testTimeout: 20000 });
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `key_${id}`,
  completionReconcilePrompt: (error) => (error.code === 'report_reconcile' ? 'Confirm recorded values' : null),
  completionReportRulesPrompt: () => null,
  completionPromiseMarksPrompt: () => null,
}));

// Each part reports the Wrap-up gate the way the real sheets do (`wrapUpGate` set per test) and hands up today's bodies.
let wrapUpGate = true;
const BODIES = {
  pest: { visitOutcome: 'completed', areasServiced: ['Inside'], sendCompletionSms: true, includePayLink: true, requestReview: true },
  lawn: { visitOutcome: 'completed', structuredFindings: { type: 'lawn_visit' }, sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' },
};
const partProps = { pest: null, lawn: null };
function stubPart(kind) {
  return function Part({ service, onPrepared, onWrapUpGate, sharedNote }) {
    partProps[kind] = { onWrapUpGate, sharedNote };
    useEffect(() => { if (wrapUpGate) onWrapUpGate?.(true); }, [onWrapUpGate]);
    return (
      <div data-testid={`${kind}-part`}>
        <button type="button" onClick={() => onPrepared(service.id, { ...BODIES[kind] }, kind === 'pest' ? 1 : 2)}>{kind} save</button>
      </div>
    );
  };
}
vi.mock('./FastCompleteSheet', () => ({ default: (props) => stubPart('pest')(props) }));
vi.mock('./FastCompleteLawnSheet', () => ({ default: (props) => stubPart('lawn')(props) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
vi.mock('./DictationButton', () => ({ default: () => null }));

const PEST = { id: 'svc-pest', customerId: 'cust-1', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Quarterly Pest Control', reportFlow: true, onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString() };
const LAWN = { id: 'svc-lawn', customerId: 'cust-1', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Lawn Care', onSiteAt: PEST.onSiteAt };
const members = [
  { id: 'svc-lawn', serviceType: 'Lawn Care', status: 'on_site', requiresForm: true },
  { id: 'svc-pest', serviceType: 'Quarterly Pest Control', status: 'on_site', requiresForm: true },
];
const rows = [{ id: 'svc-lawn', visitId: 'visit' }, { id: 'svc-pest', visitId: 'visit' }];
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };
let detail;
let post;
let request;
let held;
const onClose = vi.fn();

// `holdRereads`: the first send-time read answers, later ones wait for release().
function makeRequest({ holdRereads = false } = {}) {
  let reads = 0;
  held = [];
  return vi.fn(async (path) => {
    const bare = path.split('?')[0];
    if (bare === '/admin/schedule/next-visit') return { nextVisit: { id: 'svc-next', date: '2026-11-05', serviceType: 'Pest Control' } };
    if (bare === '/admin/reviews/send-time-preview') {
      reads += 1;
      if (holdRereads && reads > 1) return new Promise((resolve) => { held.push(() => resolve(PREVIEW)); });
      return PREVIEW;
    }
    return {};
  });
}
function mount(extra = {}) {
  return render(<FastCompleteComboSheet visitId="visit" pest={{ service: PEST }} lawn={{ service: LAWN }} request={request} operatorId="op-1" catalog={[]} onClose={onClose} onSaved={vi.fn()} onFullForm={vi.fn()} {...extra} />);
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const completeStop = () => screen.getByRole('button', { name: /Complete stop|Resume closeout/ });
async function prepareBoth() {
  await screen.findByTestId('pest-part');
  click('pest save');
  click('lawn save');
  await waitFor(() => expect(completeStop()).toBeEnabled());
}
const wrapUpSection = () => screen.queryByRole('region', { name: 'Wrap-up' }) || document.querySelector('section[aria-label="Wrap-up"]');
const postedBodies = (call = 0) => Object.fromEntries(JSON.parse(post.mock.calls[call][1].body).items.map((item) => [item.serviceId, item.body]));
const TIMING_KEYS = ['reviewTiming', 'reviewDelayMinutes', 'reviewScheduledFor'];

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
  wrapUpGate = true;
  detail = { visitId: 'visit', serviceDate: '2020-01-01', members, packet: null };
  post = vi.fn(async () => ({ packetId: 'packet', state: 'done' }));
  request = makeRequest();
  adminFetch.mockReset().mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return post(path, options);
    if (path.startsWith('/admin/schedule?')) return { services: rows };
    return detail;
  });
  onClose.mockClear();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

async function postedPacket({ gate }) {
  wrapUpGate = gate;
  post.mockClear();
  mount();
  await prepareBoth();
  click('Complete stop');
  await screen.findByText(/Stop recorded/);
  return { body: JSON.parse(post.mock.calls[0][1].body), key: post.mock.calls[0][1].headers['Idempotency-Key'] };
}

describe('the section', () => {
  it('shows above Complete stop with the clock, completion text, review with timing and the next visit, and none of the per-service rows', async () => {
    mount();
    await prepareBoth();
    await waitFor(() => expect(wrapUpSection()).toBeTruthy());
    expect(screen.getAllByRole('heading', { name: 'Time on-site' })).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).checked).toBe(true);
    expect(screen.getByLabelText('Review request timing')).toBeTruthy();
    await screen.findByText('Next scheduled visit');
    // A stop has two completions: a next-visit note would be written once per member, so the stop takes none.
    expect(screen.queryByRole('button', { name: 'Needs adjustment?' })).toBeNull();
    expect(screen.queryByLabelText('Next visit adjustment note')).toBeNull();
    // The packet records these per service: not on the stop's section, even for an admin.
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    expect(screen.queryByLabelText('Adjust time on site (minutes)')).toBeNull();
    expect(screen.queryByText('Re-entry countdown')).toBeNull();
    const after = wrapUpSection().compareDocumentPosition(completeStop());
    expect(after & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The parts get the gate callback and nothing else new.
    expect(typeof partProps.pest.onWrapUpGate).toBe('function');
  });

  it('is absent when no part says the gate is on (gate off), and nothing is read for it', async () => {
    wrapUpGate = false;
    mount();
    await prepareBoth();
    expect(wrapUpSection()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time on-site' })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('what the packet carries', () => {
  it('untouched, with the gate on: byte for byte the packet of the gate-off container, same key', async () => {
    const off = await postedPacket({ gate: false });
    cleanup();
    globalThis.indexedDB = new IDBFactory();
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    const on = await postedPacket({ gate: true });
    expect(on.body).toEqual(off.body);
    expect(on.key).toBe(off.key);
    expect(JSON.stringify(on.body)).toBe(JSON.stringify(off.body));
    // And it is today's bodies as the parts handed them up.
    expect(on.body.items.find((i) => i.serviceId === 'svc-pest').body).toEqual(BODIES.pest);
    expect(on.body.items.find((i) => i.serviceId === 'svc-lawn').body).toEqual(BODIES.lawn);
  });

  it('the packet carries no next-visit note or id, whatever the section does (the visit is shown, not noted)', async () => {
    mount();
    await prepareBoth();
    await screen.findByText('Next scheduled visit');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send completion text' }));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    for (const body of Object.values(postedBodies())) {
      expect(body).not.toHaveProperty('nextVisitAdjustmentNote');
      expect(body).not.toHaveProperty('nextVisitId');
    }
  });

  it('completion text off: false on BOTH bodies; everything else as the parts handed it', async () => {
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send completion text' }));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    const sent = postedBodies();
    expect(sent['svc-pest']).toEqual({ ...BODIES.pest, sendCompletionSms: false });
    // The stop owns the timing keys once touched: the lawn part's own Automatic ('auto', which the server reads as no timing) is
    // cleared so both bodies carry the same thing, none.
    const { reviewTiming, ...lawnRest } = BODIES.lawn;
    expect(reviewTiming).toBe('auto');
    expect(sent['svc-lawn']).toEqual({ ...lawnRest, sendCompletionSms: false });
  });

  it('review off: false on BOTH bodies (the stop asks only if every item allows it)', async () => {
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    const sent = postedBodies();
    expect(sent['svc-pest'].requestReview).toBe(false);
    expect(sent['svc-lawn'].requestReview).toBe(false);
    expect(sent['svc-pest'].sendCompletionSms).toBe(true);
    for (const kind of ['svc-pest', 'svc-lawn']) for (const key of TIMING_KEYS.slice(1)) expect(sent[kind]).not.toHaveProperty(key);
  });

  it('a timing off Automatic: the same reviewTiming, delay and time on BOTH bodies (the first member decides the delay)', async () => {
    mount();
    await prepareBoth();
    fireEvent.change(await screen.findByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    const sent = postedBodies();
    for (const key of TIMING_KEYS) expect(sent['svc-pest'][key]).toEqual(sent['svc-lawn'][key]);
    expect(sent['svc-pest']).toMatchObject({ reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0 });
    expect(sent['svc-pest'].reviewScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  });

  it('a timing changed and put back to Automatic leaves no timing keys behind (the lawn part\'s own auto is cleared too)', async () => {
    mount();
    await prepareBoth();
    const select = await screen.findByLabelText('Review request timing');
    fireEvent.change(select, { target: { value: 'tomorrow_8' } });
    fireEvent.change(select, { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send completion text' }));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    const sent = postedBodies();
    for (const kind of ['svc-pest', 'svc-lawn']) for (const key of TIMING_KEYS) expect(sent[kind]).not.toHaveProperty(key);
  });
});

describe('a retry and a reload replay what was first sent', () => {
  it('a lost response: the retry sends the same bodies under the same key, and the saved draft holds them', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    expect(post).toHaveBeenCalledTimes(1);
    // The draft store carries the overlaid bodies, not the parts' originals.
    const stored = await store.getVisitCompletionDraft('combo:visit', 'op-1');
    expect(stored.forms['svc-pest'].body.requestReview).toBe(false);
    expect(stored.forms['svc-lawn'].body.requestReview).toBe(false);
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(post.mock.calls[0][1].headers['Idempotency-Key']);
  });

  it('a reload after a failed send: the restored bodies go as saved (untouched section), same key', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    const first = post.mock.calls[0][1];
    cleanup();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(first.body);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });
});

// The packet a send posts always matches the section as shown at that send: the choices are laid onto the parts' handed-over
// bodies each time, never onto what an earlier send carried. The idempotency key stays the draft's one key (the container's rule
// for an edited part after a refusal): the server holds no packet after a refused first send, so a changed body under it is
// accepted; only an attempt whose outcome is unknown replays unchanged, and the section is held while it does.
describe('a new attempt after a rejection follows the screen', () => {
  const refused = () => Object.assign(new Error('The server refused this closeout.'), { status: 422 });
  const review = () => screen.getByRole('checkbox', { name: 'Send review request', hidden: true });
  const originals = () => ({ 'svc-pest': BODIES.pest, 'svc-lawn': BODIES.lawn });
  const keyOf = (call) => post.mock.calls[call][1].headers['Idempotency-Key'];

  it('a rejection, then the review back on: both bodies are the originals again (the lawn part\'s own auto included), same key', async () => {
    post.mockRejectedValueOnce(refused());
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/The server refused/);
    expect(postedBodies(0)['svc-pest'].requestReview).toBe(false);
    fireEvent.click(review());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(postedBodies(1)).toEqual(originals());
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a rejection, then the timing back to Automatic: no stale delay or time, and the lawn body is what it first was', async () => {
    post.mockRejectedValueOnce(refused());
    mount();
    await prepareBoth();
    const select = await screen.findByLabelText('Review request timing');
    fireEvent.change(select, { target: { value: 'tomorrow_8' } });
    click('Complete stop');
    await screen.findByText(/The server refused/);
    expect(postedBodies(0)['svc-pest']).toMatchObject({ reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0 });
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'auto' } });
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    const sent = postedBodies(1);
    expect(sent).toEqual(originals());
    for (const kind of ['svc-pest', 'svc-lawn']) for (const key of ['reviewDelayMinutes', 'reviewScheduledFor']) expect(sent[kind]).not.toHaveProperty(key);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a declined confirmation, then the review back on: the defaults again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    post.mockRejectedValueOnce(Object.assign(new Error('Recorded values differ'), { status: 409, code: 'report_reconcile', details: { serviceId: 'svc-pest' } }));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await waitFor(() => expect(completeStop()).toBeEnabled());
    fireEvent.click(review());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(2);
    expect(postedBodies(1)).toEqual(originals());
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a confirmation that was accepted stays on the body through a later send built from the handed-over bodies', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    post.mockRejectedValueOnce(Object.assign(new Error('Recorded values differ'), { status: 409, code: 'report_reconcile', details: { serviceId: 'svc-pest' } }));
    post.mockRejectedValueOnce(refused());
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/The server refused/);
    // The flag rode the second send; a third, after the review goes back on, still carries it on that body only.
    expect(postedBodies(1)['svc-pest'].reportReconcileConfirmed).toBe(true);
    fireEvent.click(review());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(postedBodies(2)['svc-pest']).toEqual({ ...BODIES.pest, reportReconcileConfirmed: true });
    expect(postedBodies(2)['svc-lawn']).toEqual(BODIES.lawn);
  });

  it('an attempt whose outcome is unknown (no answer, and the server cannot be re-read): the section is held and the retry replays the same bodies', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    adminFetch.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return post(path, options);
      throw new TypeError('Failed to fetch');
    });
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    await waitFor(() => expect(review().matches(':disabled')).toBe(true));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('after a reload one part is edited: the section shown at its defaults sends the restored part\'s original body too', async () => {
    post.mockRejectedValueOnce(refused());
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/The server refused/);
    await waitFor(async () => expect((await store.getVisitCompletionDraft('combo:visit', 'op-1')).forms['svc-lawn'].base).toEqual(BODIES.lawn));
    cleanup();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit this part' })[0]);
    await screen.findByTestId('pest-part');
    await waitFor(() => expect(wrapUpSection()).toBeTruthy());
    click('pest save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(postedBodies(1)).toEqual(originals());
  });
});

// What a send posts is decided once: a definite refusal starts a new attempt that follows the screen; anything the server may have
// recorded (the shared submit's "retry" class: no answer, 408, 5xx ...) replays the first attempt's own draft, bodies and key, with the
// section held and without the fresh-submit check.
describe('the retry rule', () => {
  const keyOf = (call) => post.mock.calls[call][1].headers['Idempotency-Key'];
  const review = () => screen.getByRole('checkbox', { name: 'Send review request', hidden: true });

  it.each([[504], [503], [408], [500]])('a %i may have been recorded: the retry replays the same draft under the same key, with the section held', async (status) => {
    post.mockRejectedValueOnce(Object.assign(new Error('Gateway timeout'), { status }));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Gateway timeout/);
    await waitFor(() => expect(review().matches(':disabled')).toBe(true));
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('a 422 is a definite refusal: the section is not held and the next attempt follows the screen', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('The server refused this closeout.'), { status: 422 }));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/The server refused/);
    expect(review().matches(':disabled')).toBe(false);
    fireEvent.click(review());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(JSON.parse(post.mock.calls[1][1].body).items.map((i) => i.body)).toEqual(expect.arrayContaining([BODIES.pest, BODIES.lawn]));
  });

  it('a replay keeps the first draft\'s exact bodies when the clock has passed Eastern midnight ("tomorrow at 8 AM" is not recomputed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-12T03:30:00Z'));
      post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      mount();
      await prepareBoth();
      fireEvent.change(await screen.findByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
      click('Complete stop');
      await screen.findByText(/Connection interrupted/);
      const first = post.mock.calls[0][1].body;
      const shown = reviewScheduledForOf({ willReview: true, reviewTiming: 'tomorrow_8', reviewCustomAt: '' });
      vi.setSystemTime(new Date('2026-10-12T05:30:00Z'));
      // The control: a recomputation now would give another day.
      expect(reviewScheduledForOf({ willReview: true, reviewTiming: 'tomorrow_8', reviewCustomAt: '' })).not.toBe(shown);
      click('Complete stop');
      await screen.findByText(/Stop recorded/);
      expect(post.mock.calls[1][1].body).toBe(first);
      expect(keyOf(1)).toBe(keyOf(0));
    } finally { vi.useRealTimers(); }
  });

  it('a replay does not run the fresh-submit check: a preview read that fails cannot block or change it', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send review request' }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'auto' } });
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    const readsBefore = request.mock.calls.filter(([p]) => p.startsWith('/admin/reviews/send-time-preview')).length;
    request.mockImplementation(async (path) => { if (path.startsWith('/admin/reviews/send-time-preview')) throw new Error('preview down'); return {}; });
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(request.mock.calls.filter(([p]) => p.startsWith('/admin/reviews/send-time-preview')).length).toBe(readsBefore);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
  });
});

// A replay pending locks the WHOLE stop like a send in flight; only Complete stop (which replays the stored draft unchanged) and Close stay.
// The hold ends on success or a definite refusal, and it survives closing and reopening the sheet.
describe('the stop is locked while a replay is pending', () => {
  const timeout = () => Object.assign(new Error('Gateway timeout'), { status: 504 });
  const note = () => screen.getByLabelText('Tell me about the visit', { selector: 'textarea' });
  const keyOf = (call) => post.mock.calls[call][1].headers['Idempotency-Key'];

  it('the shared note, both parts, Full form and Details are locked; Complete stop and Close are not', async () => {
    post.mockRejectedValueOnce(timeout());
    mount({ onViewDetails: vi.fn() });
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Gateway timeout/);
    await waitFor(() => expect(note().disabled).toBe(true));
    expect(document.querySelector('[inert]').contains(screen.getByTestId('pest-part'))).toBe(true);
    expect(document.querySelector('[inert]').contains(screen.getByTestId('lawn-part'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Full form' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Details' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(false);
    expect(completeStop()).toBeEnabled();
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(keyOf(0));
  });

  it('a definite refusal on the replay ends the hold', async () => {
    post.mockRejectedValueOnce(timeout());
    post.mockRejectedValueOnce(Object.assign(new Error('The server refused this closeout.'), { status: 422 }));
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Gateway timeout/);
    await waitFor(() => expect(note().disabled).toBe(true));
    click('Complete stop');
    await screen.findByText(/The server refused/);
    await waitFor(() => expect(note().disabled).toBe(false));
    expect(document.querySelector('[inert]')).toBeNull();
    // The store no longer says a send is pending.
    await waitFor(async () => expect((await store.getVisitCompletionDraft('combo:visit', 'op-1')).pending).toBeUndefined());
  });

  it('closing and reopening the sheet during the hold restores the same draft, still locked, and replays it unchanged', async () => {
    post.mockRejectedValueOnce(timeout());
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    click('Complete stop');
    await screen.findByText(/Gateway timeout/);
    const first = post.mock.calls[0][1];
    cleanup();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    await waitFor(() => expect(note().disabled).toBe(true));
    for (const edit of screen.getAllByRole('button', { name: 'Edit this part', hidden: true })) expect(edit.disabled).toBe(true);
    expect(wrapUpSection()).toBeNull();
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(first.body);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });
});

// The draft is written before it is posted, and the write must land.
describe('the draft is written before it is sent', () => {
  it('the POST waits for the store write of the exact draft', async () => {
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    const real = store.putVisitCompletionDraft;
    let release;
    vi.spyOn(store, 'putVisitCompletionDraft').mockImplementationOnce((...args) => new Promise((resolve) => { release = () => resolve(real(...args)); }));
    click('Complete stop');
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(post).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(postedBodies()['svc-pest'].requestReview).toBe(false);
  });

  it('a write that fails sends nothing, says so, and leaves the stop editable (then it sends)', async () => {
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    // "Complete stop" is ready from the map, before the parts' own writes land: wait for them, so the one failing
    // write is the stop's and not a part's (which would leave that part not ready).
    await waitFor(async () => expect(Object.keys((await store.getVisitCompletionDraft('combo:visit', 'op-1'))?.forms || {})).toHaveLength(2));
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValueOnce(false);
    click('Complete stop');
    await screen.findByText(/Could not save this on this device/);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).matches(':disabled')).toBe(false);
    expect(document.querySelector('[inert]')).toBeNull();
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(postedBodies()['svc-lawn'].requestReview).toBe(false);
  });

  it('a reload while the request is in flight restores exactly what was posted, locked, and replays it', async () => {
    post.mockImplementationOnce(() => new Promise(() => {}));
    mount();
    await prepareBoth();
    fireEvent.change(await screen.findByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
    click('Complete stop');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const first = post.mock.calls[0][1];
    cleanup();
    const stored = await store.getVisitCompletionDraft('combo:visit', 'op-1');
    expect(stored.pending).toBe(true);
    expect(Object.fromEntries(Object.entries(stored.forms).map(([id, form]) => [id, form.body]))).toEqual(postedBodies());
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post.mock.calls[1][1].body).toBe(first.body);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
  });
});

// The section is on only while the parts' latest contexts allow it: fail closed.
describe('the gate, from the parts\' current answers', () => {
  const reporters = () => ({ pest: partProps.pest.onWrapUpGate, lawn: partProps.lawn.onWrapUpGate });

  it('a part that says false, or that is not mounted, does not grant the section', async () => {
    mount();
    await prepareBoth();
    await waitFor(() => expect(wrapUpSection()).toBeTruthy());
    act(() => reporters().lawn(false));
    await waitFor(() => expect(wrapUpSection()).toBeNull());
    act(() => reporters().lawn(true));
    await waitFor(() => expect(wrapUpSection()).toBeTruthy());
    // Both parts leave (restored from the saved draft): nothing grants it.
    act(() => { reporters().pest(null); reporters().lawn(null); });
    await waitFor(() => expect(wrapUpSection()).toBeNull());
  });

  it('rollback: true, a choice made, the part remounts and reports false: the send posts the parts\' own bodies', async () => {
    mount();
    await prepareBoth();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send completion text' }));
    act(() => { reporters().pest(null); reporters().pest(false); });
    await waitFor(() => expect(wrapUpSection()).toBeNull());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(postedBodies()).toEqual({ 'svc-pest': BODIES.pest, 'svc-lawn': BODIES.lawn });
  });

  it('the review send time is previewed for the packet\'s first member (window start, then id), not the billing part', async () => {
    rows[0] = { id: 'svc-lawn', visitId: 'visit', windowStart: '08:00:00' };
    rows[1] = { id: 'svc-pest', visitId: 'visit', windowStart: '09:00:00' };
    try {
      mount({ pest: { service: { ...PEST, estimatedPrice: 95, createInvoiceOnComplete: true } } });
      await prepareBoth();
      await waitFor(() => expect(request.mock.calls.some(([p]) => p.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
      const paths = request.mock.calls.map(([p]) => p).filter((p) => p.startsWith('/admin/reviews/send-time-preview'));
      expect(paths.every((p) => p.includes('serviceType=Lawn+Care'))).toBe(true);
      expect(paths.some((p) => p.includes('Quarterly'))).toBe(false);
    } finally {
      rows[0] = { id: 'svc-lawn', visitId: 'visit' };
      rows[1] = { id: 'svc-pest', visitId: 'visit' };
    }
  });
});

describe('while the review send time is being re-checked', () => {
  async function startHeldComplete() {
    request = makeRequest({ holdRereads: true });
    mount();
    await prepareBoth();
    await screen.findByLabelText('Review request timing');
    await waitFor(() => expect(request.mock.calls.some(([p]) => p.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
    click('Complete stop');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
  }

  it('Complete stop, Close, Full form and Esc are inert, the section is disabled, and nothing posts until the answer lands', async () => {
    await startHeldComplete();
    expect(completeStop()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Full form' }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Send review request', hidden: true }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    await act(async () => { held.forEach((release) => release()); });
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('an answer that lands after the container is gone posts nothing', async () => {
    await startHeldComplete();
    cleanup();
    await act(async () => { held.forEach((release) => release()); });
    await act(async () => { await Promise.resolve(); });
    expect(post).not.toHaveBeenCalled();
  });
});
