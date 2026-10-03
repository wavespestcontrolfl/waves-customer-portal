// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_RETENTION_MS,
  deleteServicePhotoDraft,
  deleteServicePhotoDraftIfCurrent,
  getServicePhotoDraft,
  pruneServicePhotoDrafts,
  putCompletionDraft,
  putRecapClipDraft,
  putServicePhotoDraft,
  putServicePhotoDraftIfCurrent,
} from './completion-resume-store';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('service photo drafts', () => {
  it('does not delete a refresh committed by another tab during the stale-row check', async () => {
    const now = Date.now();
    const key = 'service-photo:tech-a:visit-1';
    await putServicePhotoDraft('visit-1', { draftId: 'draft-a', stage: 'failed' }, 'tech-a', now - DRAFT_RETENTION_MS - 1);
    const otherTab = await new Promise((resolve, reject) => {
      const request = indexedDB.open('waves-completion-drafts', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let refresh;
    let intercepted = false;
    const originalGet = IDBObjectStore.prototype.get;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function readWithConcurrentRefresh(readKey) {
      const request = originalGet.call(this, readKey);
      if (readKey === key && !intercepted) {
        intercepted = true;
        request.addEventListener('success', () => {
          // A separate connection has no access to this module's in-memory
          // queue. It queues its write while the pruning read is still open.
          const tx = otherTab.transaction('bodies', 'readwrite');
          tx.objectStore('bodies').put({
            draft: { draftId: 'draft-a', stage: 'uploading' },
            storedAt: now, serviceId: 'visit-1', scope: 'service-photo:tech-a',
          }, key);
          refresh = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        }, { once: true });
      }
      return request;
    });
    try {
      await pruneServicePhotoDrafts(now);
      await refresh;
      expect(intercepted).toBe(true);
      expect(await getServicePhotoDraft('visit-1', 'tech-a')).toMatchObject({ stage: 'uploading' });
    } finally {
      spy.mockRestore();
      otherTab.close();
    }
  });

  it('keeps the same visit separate for each signed-in technician', async () => {
    const file = new File(['photo-a'], 'yard.jpg', { type: 'image/jpeg' });
    await putServicePhotoDraft('visit-1', { serviceId: 'visit-1', technicianId: 'tech-a', file, stage: 'uploading' }, 'tech-a');

    expect(await getServicePhotoDraft('visit-1', 'tech-b')).toBeNull();
    expect(await getServicePhotoDraft('visit-1', 'tech-a')).toMatchObject({
      serviceId: 'visit-1', technicianId: 'tech-a', stage: 'uploading',
    });

    expect(await deleteServicePhotoDraft('visit-1', 'tech-a')).toBe(true);
    expect(await getServicePhotoDraft('visit-1', 'tech-a')).toBeNull();
  });

  it('prunes only service-photo rows after the shared 14-day retention window', async () => {
    const old = Date.now() - DRAFT_RETENTION_MS - 1;
    await putServicePhotoDraft('old-photo', { stage: 'unconfirmed' }, 'tech-a', old);
    await putServicePhotoDraft('live-photo', { stage: 'failed' }, 'tech-a');
    await putRecapClipDraft('old-clip', { stage: 'failed' }, 'tech-a', old);
    await putCompletionDraft('old-form', { notes: 'keep this form' }, 'tech-a', old);

    expect(await pruneServicePhotoDrafts()).toEqual([
      { serviceId: 'old-photo', scope: 'service-photo:tech-a' },
    ]);
    expect(await getServicePhotoDraft('old-photo', 'tech-a')).toBeNull();
    expect(await getServicePhotoDraft('live-photo', 'tech-a')).toMatchObject({ stage: 'failed' });
  });

  it('orders an unmount discard behind its pending save and rejects late mutations from the discarded draft', async () => {
    const first = { draftId: 'draft-a', serviceId: 'visit-1', technicianId: 'tech-a', stage: 'uploading' };
    const save = putServicePhotoDraftIfCurrent('visit-1', first, 'tech-a', first.draftId, { allowMissing: true });
    const discard = deleteServicePhotoDraftIfCurrent('visit-1', 'tech-a', first.draftId);
    expect(await save).toBe(true);
    expect(await discard).toBe(true);
    expect(await getServicePhotoDraft('visit-1', 'tech-a')).toBeNull();

    const newer = { draftId: 'draft-b', serviceId: 'visit-1', technicianId: 'tech-a', stage: 'uploading' };
    expect(await putServicePhotoDraftIfCurrent('visit-1', newer, 'tech-a', newer.draftId, { allowMissing: true })).toBe(true);
    expect(await putServicePhotoDraftIfCurrent('visit-1', { ...first, stage: 'unconfirmed' }, 'tech-a', first.draftId)).toBe(false);
    expect(await deleteServicePhotoDraftIfCurrent('visit-1', 'tech-a', first.draftId)).toBe(false);
    expect(await getServicePhotoDraft('visit-1', 'tech-a')).toEqual(newer);
  });
});
