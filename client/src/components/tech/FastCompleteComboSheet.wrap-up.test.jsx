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

vi.setConfig({ testTimeout: 20000 });
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `key_${id}`,
  completionReconcilePrompt: () => null,
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
