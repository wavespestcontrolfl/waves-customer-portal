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

  test('a change behind the prepared body revokes it and tells the container; no change keeps it', async () => {
    const onPrepared = vi.fn();
    const prepared = mount({ onPrepared });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'one', products: [1] }), 's'); });
    onPrepared.mockClear();
    // The same inputs (a fresh builder, equal result): stays prepared, nobody is told.
    act(() => prepared.result.current.revokeIfChanged(() => ({ technicianNotes: 'one', products: [1] })));
    expect(prepared.result.current.prepared).not.toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
    // A changed input: revoked, container told with null.
    act(() => prepared.result.current.revokeIfChanged(() => ({ technicianNotes: 'one', products: [1, 2] })));
    await waitFor(() => expect(prepared.result.current.prepared).toBeNull());
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(onPrepared).toHaveBeenCalledWith('svc-a', null);
    // Revoked once: a later change does not tell the container again.
    act(() => prepared.result.current.revokeIfChanged(() => ({ technicianNotes: 'three' })));
    expect(onPrepared).toHaveBeenCalledTimes(1);
    // Preparing again hands over the new body.
    await act(async () => { await prepared.result.current.submit(() => ({ technicianNotes: 'three' }), 's'); });
    expect(onPrepared).toHaveBeenLastCalledWith('svc-a', expect.objectContaining({ technicianNotes: 'three' }));
    expect(prepared.result.current.prepared.technicianNotes).toBe('three');
  });

  test('a body that can no longer be built revokes the prepared state', async () => {
    const onPrepared = vi.fn();
    const prepared = mount({ onPrepared });
    await waitFor(() => expect(prepared.result.current.recovering).toBe(false));
    await act(async () => { await prepared.result.current.submit(() => ({ a: 1 }), 's'); });
    onPrepared.mockClear();
    act(() => prepared.result.current.revokeIfChanged(() => { throw new Error('no draft'); }));
    await waitFor(() => expect(prepared.result.current.prepared).toBeNull());
    expect(onPrepared).toHaveBeenCalledWith('svc-a', null);
  });

  test('outside prepare mode revokeIfChanged does nothing', async () => {
    const sent = mount();
    await waitFor(() => expect(sent.result.current.recovering).toBe(false));
    act(() => sent.result.current.revokeIfChanged(() => ({ a: 1 })));
    expect(sent.result.current.prepared).toBeNull();
  });

  test('a handoff that settles after the scope changed does not touch the next part\'s signature or state', async () => {
    let release;
    const slow = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const request = vi.fn(async () => ({}));
    const view = renderHook((p) => useFastCompleteSubmit(p), { initialProps: { base: '/a', request, serviceId: 'svc-a', operatorId: 'op-a', onPrepared: slow } });
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    let pending;
    act(() => { pending = view.result.current.submit(() => ({ n: 'A' }), 's'); });
    // Switch to part B before A's handoff settles; B prepares at once.
    const fast = vi.fn();
    view.rerender({ base: '/b', request, serviceId: 'svc-b', operatorId: 'op-a', onPrepared: fast });
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    await act(async () => { await view.result.current.submit(() => ({ n: 'B' }), 's'); });
    expect(view.result.current.prepared.n).toBe('B');
    fast.mockClear();
    await act(async () => { release(); await pending; });
    // A's late settle left B's prepared state and signature alone: B's own body does not revoke.
    expect(view.result.current.prepared.n).toBe('B');
    act(() => view.result.current.revokeIfChanged(() => ({ n: 'B' })));
    expect(view.result.current.prepared.n).toBe('B');
    expect(fast).not.toHaveBeenCalled();
  });
});
