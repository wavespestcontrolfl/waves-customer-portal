// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
    const open = indexedDB.open(FAST_DB, 2);
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
    corrected.technicianNotes = 'Further correction after blocked send';
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

  it('offers an explicit storage bypass when a confirmation write fails but the original is readable', async () => {
    const original = { idempotencyKey: 'quota-key', ...photoBody };
    await putFastCompletionAttempt('svc-1', 'tech-a', { body: original, summary: 'Report' });
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Confirm'), {
      status: 409, code: 'report_rules_review',
    })).mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request, confirmable: true }));
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    await act(async () => { await view.result.current.retry(); });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (record, key) {
      if (record.body?.reportRulesConfirmed) throw new DOMException('Full', 'QuotaExceededError');
      return put.call(this, record, key);
    });
    await act(async () => { await view.result.current.confirm(); });
    expect(view.result.current.storageBypassPending).toBe(true);
    expect(view.result.current.storageWarning).toContain('reload-safe copy');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt.body).toEqual(original);
    await act(async () => { await view.result.current.retry(); });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ ...original, reportRulesConfirmed: true });
    expect(view.result.current.done.summary).toBe('Report');
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toBeNull();
  });

  it.each([401, 403, 408, 425, 429])('retains exact recovery through temporary request rejection %s', async (status) => {
    const body = { idempotencyKey: 'auth-retry-key', ...photoBody };
    await putFastCompletionAttempt('svc-1', 'tech-a', { body, summary: 'Saved report' });
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Request rejected'), { status }))
      .mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request }));
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    await act(async () => { await view.result.current.retry(); });
    expect(view.result.current.retryPending).toBe(true);
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt.body).toEqual(body);
    await act(async () => { await view.result.current.retry(); });
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body);
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
    expect(view.result.current.error).toContain('another tab');
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt).toMatchObject({ body: newer });
  });

  it.each([400, 409])('allows in-memory correction or prompt dismissal without storage (%s)', async (status) => {
    globalThis.indexedDB = undefined;
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Review input'), {
      status, code: status === 409 ? 'report_rules_review' : 'invalid_input',
    })).mockResolvedValue({ success: true });
    const view = renderHook(() => useFastCompleteSubmit({ ...scope, request, confirmable: true }));
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    await act(async () => { await view.result.current.submit(() => photoBody, 'Original'); });
    if (status === 409) {
      expect(view.result.current.prompt.code).toBe('report_rules_review');
      await act(async () => { await view.result.current.dismissPrompt(); });
      expect(view.result.current.prompt).toBeNull();
    }
    const corrected = { ...photoBody, technicianNotes: 'Corrected in memory' };
    await act(async () => { await view.result.current.submit(() => corrected, 'Corrected'); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject(corrected);
    expect(view.result.current.done.summary).toBe('Corrected');
  });

  it.each(['retry', 'discard'])('keeps a different tab’s confirmed same-key body during stale %s', async (action) => {
    const original = { idempotencyKey: 'shared-key', ...photoBody };
    await putFastCompletionAttempt('svc-1', 'tech-a', { body: original, summary: 'Report' });
    const firstRequest = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Confirm'), {
      status: 409, code: 'report_rules_review',
    })).mockRejectedValue(new Error('Response lost'));
    const first = renderHook(() => useFastCompleteSubmit({ ...scope, request: firstRequest, confirmable: true }));
    const staleRequest = vi.fn();
    const stale = renderHook(() => useFastCompleteSubmit({ ...scope, request: staleRequest, confirmable: true }));
    await waitFor(() => expect(first.result.current.restored && stale.result.current.restored).toBe(true));
    await act(async () => { await first.result.current.retry(); });
    await act(async () => { await first.result.current.confirm(); });
    await act(async () => { await stale.result.current[action](); });
    expect(staleRequest).not.toHaveBeenCalled();
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt.body).toEqual({ ...original, reportRulesConfirmed: true });
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

describe('a late response after leaving and reopening the same visit (handoff P1 on 463069ad05)', () => {
  const confirmError = () => Object.assign(new Error('The report changed.'), { status: 409, code: 'report_rules_review' });

  async function reopenWithNewerAttempt(lateOutcome) {
    const original = { idempotencyKey: 'late-key', ...photoBody };
    await putFastCompletionAttempt('svc-1', 'tech-a', { body: original, summary: 'Late report' });
    let settleFirst;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve, reject) => { settleFirst = { resolve, reject }; }))
      .mockRejectedValueOnce(confirmError())
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = renderHook(
      ({ serviceId }) => useFastCompleteSubmit({ base: `/admin/dispatch/${serviceId}`, serviceId, operatorId: 'tech-a', request, confirmable: true }),
      { initialProps: { serviceId: 'svc-1' } },
    );
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    // The first send waits on the network...
    let firstSend;
    act(() => { firstSend = view.result.current.retry(); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // ...while the tech leaves and reopens the same visit,
    view.rerender({ serviceId: 'svc-2' });
    await waitFor(() => expect(view.result.current.recovering).toBe(false));
    view.rerender({ serviceId: 'svc-1' });
    await waitFor(() => expect(view.result.current.restored).toBe(true));
    // ...and confirms a newer revision of the attempt, which is saved before its send.
    await act(async () => { await view.result.current.retry(); });
    expect(view.result.current.prompt?.code).toBe('report_rules_review');
    act(() => { view.result.current.confirm(); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    const newer = { ...original, reportRulesConfirmed: true };
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt.body).toEqual(newer);
    // The first send's response arrives late.
    await act(async () => {
      if (lateOutcome === 'success') settleFirst.resolve({ success: true, receiptId: 'late' });
      else settleFirst.reject(Object.assign(new Error('Invalid input'), { status: 400, code: 'invalid_input' }));
      await firstSend;
    });
    return { newer };
  }

  it.each(['success', 'rejection'])('a late %s cleans up only its own row, never the newer attempt', async (lateOutcome) => {
    const { newer } = await reopenWithNewerAttempt(lateOutcome);
    expect((await getFastCompletionAttempt('svc-1', 'tech-a')).attempt?.body).toEqual(newer);
  });
});
