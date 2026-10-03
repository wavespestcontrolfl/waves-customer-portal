// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useFastCompleteSubmit from './useFastCompleteSubmit';
import {
  getFastCompletionAttempt,
  putFastCompletionAttempt,
} from '../lib/completion-resume-store';

const scope = { base: '/admin/dispatch/svc-1', serviceId: 'svc-1', operatorId: 'tech-a' };
const photoBody = {
  visitOutcome: 'completed',
  expectedVisit: { customerId: 'cust-1', scheduledDate: '2026-10-02' },
  technicianNotes: 'Treated the palms.',
  completionPhotos: [{
    data: 'data:image/jpeg;base64,QUJDREVGRw==',
    name: 'front-beds.jpg',
    photoType: 'after',
    sortOrder: 0,
    capturedAt: '2026-10-02T14:00:00.000Z',
    slot: 'front_beds',
  }],
};
const FAST_DB = 'waves-fast-completion-attempts';
const FAST_STORE = 'bodies';
const fastKey = (serviceId, operatorId) => `fast-complete:${operatorId}:${serviceId}`;

function replaceFromSecondConnection(serviceId, operatorId, body, summary) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(FAST_DB, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(FAST_STORE, 'readwrite');
      tx.objectStore(FAST_STORE).put({
        version: 1, serviceId, operatorId, body, summary, storedAt: Date.now(),
      }, fastKey(serviceId, operatorId));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useFastCompleteSubmit durable attempts', () => {
  it('keeps existing callers without scope on their in-memory submission path', async () => {
    globalThis.indexedDB = undefined;
    const request = vi.fn().mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ base: scope.base, request }));
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    await act(async () => { await view.result.current.submit(() => photoBody, 'Legacy caller'); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.result.current.storageWarning).toBe('');
    expect(view.result.current.done.summary).toBe('Legacy caller');
  });

  it('clears a rejected row after storage recovers before sending corrected input', async () => {
    const deviceDatabase = globalThis.indexedDB;
    const request = vi.fn().mockImplementationOnce(async () => {
      globalThis.indexedDB = undefined;
      throw Object.assign(new Error('Correct the report.'), { status: 422 });
    }).mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request }));
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    await act(async () => { await view.result.current.submit(() => photoBody, 'Original'); });
    const original = JSON.parse(request.mock.calls[0][1].body);
    const corrected = { ...photoBody, technicianNotes: 'Corrected report' };
    await act(async () => { await view.result.current.submit(() => corrected, 'Corrected'); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toContain('Could not clear');
    globalThis.indexedDB = deviceDatabase;
    await act(async () => { await view.result.current.submit(() => corrected, 'Corrected'); });
    expect(request).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(request.mock.calls[1][1].body);
    expect(sent).toMatchObject(corrected);
    expect(sent.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(view.result.current.done.summary).toBe('Corrected');
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toBeNull();
  });

  it('restores an uncertain photo completion without auto-submit, then retries the exact body, key, and summary', async () => {
    const uncertain = Object.assign(new Error('Connection dropped.'), { status: undefined });
    const firstRequest = vi.fn().mockRejectedValue(uncertain);
    const first = renderHook(() => useFastCompleteSubmit({ ...scope, request: firstRequest }));
    await waitFor(() => expect(first.result.current.recovering).toBe(false));

    await act(async () => {
      await first.result.current.submit(() => photoBody, 'Merit 2F · Palms');
    });
    expect(first.result.current.retryPending).toBe(true);
    const firstWireBody = firstRequest.mock.calls[0][1].body;
    const prepared = JSON.parse(firstWireBody);
    expect(prepared).toMatchObject(photoBody);
    expect(prepared.idempotencyKey).toEqual(expect.any(String));
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toMatchObject({
      body: prepared,
      summary: 'Merit 2F · Palms',
    });
    first.unmount();

    const receipt = { success: true, receiptId: 'receipt-1' };
    const retryRequest = vi.fn().mockResolvedValue(receipt);
    const reopened = renderHook(() => useFastCompleteSubmit({ ...scope, request: retryRequest }));
    await waitFor(() => expect(reopened.result.current.restored).toBe(true));
    expect(retryRequest).not.toHaveBeenCalled();
    expect(reopened.result.current.pendingSummary).toBe('Merit 2F · Palms');

    await act(async () => { await reopened.result.current.retry(); });
    expect(retryRequest).toHaveBeenCalledTimes(1);
    expect(retryRequest.mock.calls[0][0]).toBe('/admin/dispatch/svc-1/complete');
    expect(retryRequest.mock.calls[0][1].body).toBe(firstWireBody);
    expect(reopened.result.current.done).toMatchObject({ summary: 'Merit 2F · Palms', response: receipt });
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toBeNull();
  });

  it('never restores another operator or visit and ignores a receipt after the active scope changes', async () => {
    const stored = { body: { idempotencyKey: 'same-key', ...photoBody }, summary: 'Private visit' };
    await putFastCompletionAttempt('svc-1', 'tech-a', stored);
    const request = vi.fn();
    const view = renderHook(
      ({ serviceId, operatorId }) => useFastCompleteSubmit({
        base: `/admin/dispatch/${serviceId}`, serviceId, operatorId, request,
      }),
      { initialProps: { serviceId: 'svc-1', operatorId: 'tech-b' } },
    );
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    expect(view.result.current.restored).toBe(false);

    view.rerender({ serviceId: 'svc-2', operatorId: 'tech-a' });
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    expect(view.result.current.restored).toBe(false);

    view.rerender({ serviceId: 'svc-1', operatorId: 'tech-a' });
    await waitFor(() => expect(view.result.current.restored).toBe(true));

    let resolveReceipt;
    request.mockImplementation(() => new Promise((resolve) => { resolveReceipt = resolve; }));
    let retryPromise;
    act(() => { retryPromise = view.result.current.retry(); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const newer = { idempotencyKey: 'new-tab-key', ...photoBody, technicianNotes: 'New tab body' };
    await replaceFromSecondConnection('svc-1', 'tech-a', newer, 'New tab attempt');
    view.rerender({ serviceId: 'svc-2', operatorId: 'tech-b' });
    await act(async () => {
      resolveReceipt({ success: true, receiptId: 'old-scope' });
      await retryPromise;
    });
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    expect(view.result.current.restored).toBe(false);
    expect(view.result.current.done).toBeNull();
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toMatchObject({
      body: newer,
      summary: 'New tab attempt',
    });
  });

  it('persists a recovered confirmation under the original key before sending it', async () => {
    const original = { idempotencyKey: 'confirm-key', ...photoBody };
    await putFastCompletionAttempt('svc-1', 'tech-a', { body: original, summary: 'Confirmed report' });
    const confirmError = Object.assign(new Error('The report changed.'), {
      status: 409,
      code: 'report_rules_review',
    });
    const request = vi.fn()
      .mockRejectedValueOnce(confirmError)
      .mockImplementationOnce(async () => {
        const stored = (await getFastCompletionAttempt('svc-1', 'tech-a')).attempt;
        expect(stored.body).toEqual({ ...original, reportRulesConfirmed: true });
        return { success: true, receiptId: 'confirmed' };
      });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request, confirmable: true }));
    await waitFor(() => expect(view.result.current.restored).toBe(true));

    await act(async () => { await view.result.current.retry(); });
    expect(view.result.current.prompt?.code).toBe('report_rules_review');
    await act(async () => { await view.result.current.confirm(); });

    const confirmed = JSON.parse(request.mock.calls[1][1].body);
    expect(confirmed).toEqual({ ...original, reportRulesConfirmed: true });
    expect(confirmed.idempotencyKey).toBe('confirm-key');
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toBeNull();
  });

  it('keeps a recovered attempt until the technician explicitly discards it', async () => {
    await putFastCompletionAttempt('svc-1', 'tech-a', {
      body: { idempotencyKey: 'discard-key', ...photoBody },
      summary: 'Old visit',
    });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request: vi.fn() }));
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    const newer = { idempotencyKey: 'newer-discard-key', ...photoBody };
    await replaceFromSecondConnection('svc-1', 'tech-a', newer, 'Newer tab');

    await act(async () => { await view.result.current.discard(); });
    expect(view.result.current.restored).toBe(false);
    expect(view.result.current.hasPendingBody()).toBe(false);
    await waitFor(async () => {
      expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toMatchObject({
        body: newer,
        summary: 'Newer tab',
      });
    });
  });

  it('keeps recovery visible when device storage cannot confirm discard', async () => {
    await putFastCompletionAttempt('svc-1', 'tech-a', {
      body: { idempotencyKey: 'retained-key', ...photoBody }, summary: 'Saved visit',
    });
    const request = vi.fn();
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request }));
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    const deviceDatabase = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    await act(async () => { await view.result.current.discard(); });
    expect(view.result.current.restored).toBe(true);
    expect(view.result.current.hasPendingBody()).toBe(true);
    expect(view.result.current.error).toMatch(/Could not discard/);
    expect(request).not.toHaveBeenCalled();
    globalThis.indexedDB = deviceDatabase;
    await act(async () => { await view.result.current.discard(); });
    expect(view.result.current.restored).toBe(false);
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toBeNull();
  });

  it('blocks a stale tab before network when another tab owns a newer attempt key', async () => {
    const request = vi.fn();
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request }));
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    const newer = { idempotencyKey: 'other-tab-key', ...photoBody, technicianNotes: 'Other tab' };
    await replaceFromSecondConnection('svc-1', 'tech-a', newer, 'Other tab attempt');

    await act(async () => {
      await view.result.current.submit(() => photoBody, 'Stale tab attempt');
    });

    expect(request).not.toHaveBeenCalled();
    expect(view.result.current.failure).toBe('terminal');
    expect(view.result.current.error).toContain('prepared in a different tab');
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toMatchObject({ body: newer });
  });

  it('warns before sending when persistence fails, then sends only after another explicit tap', async () => {
    const request = vi.fn().mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request }));
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    globalThis.indexedDB = undefined;

    await act(async () => {
      await view.result.current.submit(() => photoBody, 'Inspection · Palms');
    });
    expect(request).not.toHaveBeenCalled();
    expect(view.result.current.storageWarning).toContain('reload-safe copy');
    expect(view.result.current.storageBypassPending).toBe(true);

    await act(async () => { await view.result.current.retry(); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject(photoBody);
    expect(view.result.current.done?.summary).toBe('Inspection · Palms');
  });
});
