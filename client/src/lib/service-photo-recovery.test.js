import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmPhotoDraft,
  persistCurrentPhotoStage,
  photoVisitChanged,
  postServicePhoto,
  retainFailedPhoto,
  restoreServicePhoto,
} from './service-photo-recovery';
import { getServicePhotoDraft } from './completion-resume-store';
afterEach(() => vi.unstubAllGlobals());

const captured = {
  customerId: 'customer-a', propertyId: 'property-a', technicianId: 'tech-a',
  scheduledDate: '2026-10-02', status: 'pending', revision: 'revision-a',
};

describe('recovered photo visit identity', () => {
  it.each(['pending', 'confirmed', 'en_route', 'on_site', 'completed'])(
    'keeps the same photo when its visit advances to %s', (status) => {
      expect(photoVisitChanged(captured, { ...captured, status })).toBe(false);
    },
  );
  it.each(['cancelled', 'skipped', 'rescheduled', 'no_show', 'unknown', null])(
    'refuses recovery for an unavailable visit state %s', (status) => {
      expect(photoVisitChanged(captured, { ...captured, status })).toBe(true);
    },
  );
  it.each(['customerId', 'propertyId', 'technicianId', 'scheduledDate', 'revision'])(
    'still refuses a changed %s after check-in', (field) => {
      expect(photoVisitChanged(captured, { ...captured, [field]: 'changed', status: 'on_site' })).toBe(true);
    },
  );
  it('blocks one-sided snapshot absence while preserving the deployed legacy response', () => {
    expect(photoVisitChanged(captured, null)).toBe(true);
    expect(photoVisitChanged(null, captured)).toBe(true);
    expect(photoVisitChanged(null, null)).toBe(false);
  });
});


it.each(['http', 'network'])('persists the upload receipt before reconciliation and retries only reconciliation after %s failure', async (failureKind) => {
  globalThis.indexedDB = new IDBFactory();
  let uploads = 0;
  let reconciles = 0;
  const reconcileBodies = [];
  const receiptVisit = { ...captured, status: 'completed' };
  const photo = {
    draftId: 'draft-receipt', file: new File(['original'], 'lawn.jpg', { type: 'image/jpeg' }),
    photoType: 'after', capturedAt: '2026-10-02T14:00:00Z', expectedVisit: captured,
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/photos/reconcile')) {
      reconciles += 1;
      reconcileBodies.push(JSON.parse(options.body));
      const persisted = await getServicePhotoDraft('visit-a', 'tech-a');
      expect(persisted.uploadReceipt).toMatchObject({
        photo: { id: 'photo-receipt' },
        serviceRecordId: 'record-original',
        visit: receiptVisit,
      });
      if (reconciles === 1) {
        if (failureKind === 'network') throw new Error('Connection lost');
        return { ok: false, status: 503, json: async () => ({ error: 'Reconciliation unavailable' }) };
      }
      return { ok: true };
    }
    uploads += 1;
    return { ok: true, json: async () => ({
      photo: { id: 'photo-receipt' }, reconcileRequired: true,
      serviceRecordId: 'record-original', visit: receiptVisit,
    }) };
  }));
  let failure;
  try { await postServicePhoto(photo, 'visit-a', 'token', 'tech-a'); } catch (error) { failure = error; }
  expect(failure?.uploadStage).toBe('reconciliation_failed');
  await retainFailedPhoto(photo, 'visit-a', 'tech-a', failure, 'Updates still owed');
  const stored = await getServicePhotoDraft('visit-a', 'tech-a');
  expect(stored.stage).toBe('reconciliation_failed');
  const restored = restoreServicePhoto(stored, 'visit-a', 'tech-a');
  expect(restored.stage).toBe('reconciliation_failed');
  expect(restored.uploadReceipt).toMatchObject({ serviceRecordId: 'record-original', visit: receiptVisit });
  await expect(postServicePhoto(restored, 'visit-a', 'token', 'tech-a')).resolves.toMatchObject({ photo: { id: 'photo-receipt' } });
  expect(uploads).toBe(1);
  expect(reconciles).toBe(2);
  expect(reconcileBodies).toEqual([
    { expectedServiceRecordId: 'record-original', expectedVisit: receiptVisit },
    { expectedServiceRecordId: 'record-original', expectedVisit: receiptVisit },
  ]);
});

it('keeps an accepted receipt in memory when IndexedDB cannot confirm or remove its draft', async () => {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  const photo = {
    draftId: 'draft-confirmation',
    file: new File(['original'], 'lawn.jpg', { type: 'image/jpeg' }),
    photoType: 'after',
    capturedAt: '2026-10-02T14:00:00Z',
    expectedVisit: captured,
  };
  expect(await persistCurrentPhotoStage(
    photo, 'visit-confirmation', 'tech-a', 'uploading', 'Uploading',
  )).toBe('saved');
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ photo: { id: 'accepted-photo' }, reconcileRequired: false }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('indexedDB', undefined);

  await expect(postServicePhoto(photo, 'visit-confirmation', 'token', 'tech-a'))
    .resolves.toMatchObject({ photo: { id: 'accepted-photo' } });
  expect(await confirmPhotoDraft(photo, 'visit-confirmation', 'tech-a')).toBe(false);
  expect(photo.uploadReceipt).toMatchObject({ photo: { id: 'accepted-photo' } });

  vi.stubGlobal('indexedDB', factory);
  await expect(getServicePhotoDraft('visit-confirmation', 'tech-a')).resolves.toMatchObject({
    stage: 'uploading', uploadReceipt: null,
  });
  await expect(postServicePhoto(photo, 'visit-confirmation', 'token', 'tech-a'))
    .resolves.toMatchObject({ photo: { id: 'accepted-photo' } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await confirmPhotoDraft(photo, 'visit-confirmation', 'tech-a')).toBe(true);
  await expect(getServicePhotoDraft('visit-confirmation', 'tech-a')).resolves.toBeNull();
});

it('refuses a receipt with missing identity instead of reconciling the latest record', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const malformed = {
    uploadReceipt: { photo: { id: 'new-photo' }, reconcileRequired: true },
  };

  await expect(postServicePhoto(malformed, 'visit-a', 'token', 'tech-a'))
    .rejects.toMatchObject({ uploadStage: 'reconciliation_failed' });
  expect(fetchMock).not.toHaveBeenCalled();
});


it('marks an office handoff as terminal without uploading the photo again', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: false, status: 409,
    json: async () => ({ code: 'photo_reconciliation_handed_off', error: 'Office follow-up required' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const photo = { uploadReceipt: {
    photo: { id: 'attached-photo' }, reconcileRequired: true,
    serviceRecordId: 'record-original', visit: captured,
  } };
  await expect(postServicePhoto(photo, 'visit-a', 'token', 'tech-a'))
    .rejects.toMatchObject({ uploadStage: 'reconciliation_handed_off' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toMatch(/photos\/reconcile$/);
});
