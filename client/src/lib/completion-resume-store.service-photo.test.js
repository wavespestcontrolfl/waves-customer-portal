// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

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
