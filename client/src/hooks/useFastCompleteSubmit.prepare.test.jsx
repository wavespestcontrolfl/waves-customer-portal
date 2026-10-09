// @vitest-environment jsdom
// GATE_COMBO_FAST_COMPLETE (PR 1): useFastCompleteSubmit in prepare mode hands the body it would have
// posted to onPrepared and does nothing else with it: no request, no saved-completion record, no
// recovery of an older saved attempt, no held body for a retry. Synthetic ids only.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import useFastCompleteSubmit from './useFastCompleteSubmit';
import { getFastCompletionAttempt, putFastCompletionAttempt } from '../lib/completion-resume-store';

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => cleanup());

const mount = (extra = {}) => {
  const request = vi.fn(async () => ({ success: true }));
  const props = { base: '/admin/dispatch/svc-a', request, serviceId: 'svc-a', operatorId: 'op-a', ...extra };
  return { request, ...renderHook((p) => useFastCompleteSubmit(p), { initialProps: props }) };
};

describe('prepare mode', () => {
  test('hands over the body a send would post (key, built fields, invoice fields), and only that', async () => {
    const onPrepared = vi.fn();
    const prepared = mount({ onPrepared, invoiceFields: { invoiceAlreadySent: true } });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'n' }), 'sum'); });
    expect(prepared.request).not.toHaveBeenCalled();
    expect(onPrepared).toHaveBeenCalledTimes(1);
    const [serviceId, body] = onPrepared.mock.calls[0];
    expect(serviceId).toBe('svc-a');
    expect(body).toEqual({ idempotencyKey: expect.any(String), technicianNotes: 'n', invoiceAlreadySent: true });
    expect(prepared.result.current.prepared).toEqual(body);
    expect(prepared.result.current.preparing).toBe(true);
    expect(prepared.result.current.done).toBeNull();

    const sent = mount({ invoiceFields: { invoiceAlreadySent: true } });
    await waitFor(() => expect(sent.result.current.recovering).toBe(false));
    await act(async () => { await sent.result.current.submit(() => ({ technicianNotes: 'n' }), 'sum'); });
    const posted = JSON.parse(sent.request.mock.calls[0][1].body);
    const { idempotencyKey: _a, ...preparedRest } = body;
    const { idempotencyKey: _b, ...postedRest } = posted;
    expect(preparedRest).toEqual(postedRest);
  });

  test('writes no saved-completion record and holds no body for a retry', async () => {
    const prepared = mount({ onPrepared: vi.fn() });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'n' }), 'sum'); });
    expect((await getFastCompletionAttempt('svc-a', 'op-a')).attempt).toBeNull();
    expect(prepared.result.current.hasPendingBody()).toBe(false);
    expect(prepared.result.current.retryPending).toBe(false);
    expect(prepared.result.current.restored).toBe(false);
  });

  test('does not recover or offer an older saved attempt, and leaves it where it is', async () => {
    const old = { idempotencyKey: 'old-key', technicianNotes: 'older send' };
    await putFastCompletionAttempt('svc-a', 'op-a', { body: old, summary: 's' });
    const prepared = mount({ onPrepared: vi.fn() });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    expect(prepared.result.current.restored).toBe(false);
    expect(prepared.result.current.failure).toBeNull();
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'new' }), 'sum'); });
    expect((await getFastCompletionAttempt('svc-a', 'op-a')).attempt.body).toEqual(old);
  });

  test('submitting again after an edit replaces the prepared body', async () => {
    const onPrepared = vi.fn();
    const prepared = mount({ onPrepared });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'one' }), 's'); });
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'two' }), 's'); });
    expect(onPrepared).toHaveBeenCalledTimes(2);
    expect(prepared.result.current.prepared.technicianNotes).toBe('two');
    expect(onPrepared.mock.calls[0][1].idempotencyKey).toBe(onPrepared.mock.calls[1][1].idempotencyKey);
  });

  test('a refused hand-over shows the message and sends nothing', async () => {
    const prepared = mount({ onPrepared: vi.fn(async () => { throw new Error('No room on this device'); }) });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({}), 's'); });
    expect(prepared.result.current.error).toBe('No room on this device');
    expect(prepared.result.current.prepared).toBeNull();
    expect(prepared.request).not.toHaveBeenCalled();
  });

  test('without onPrepared the hook still posts and stores as before', async () => {
    const sent = mount();
    await waitFor(() => expect(sent.result.current.recovering).toBe(false));
    expect(sent.result.current.preparing).toBe(false);
    await act(async () => { await sent.result.current.submit(() => ({ technicianNotes: 'n' }), 's'); });
    expect(sent.request).toHaveBeenCalledTimes(1);
    expect(sent.result.current.done).not.toBeNull();
    expect(sent.result.current.prepared).toBeNull();
  });
});
