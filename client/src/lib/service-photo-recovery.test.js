import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { photoVisitChanged, postServicePhoto, retainFailedPhoto, restoreServicePhoto } from './service-photo-recovery';
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
  const photo = {
    draftId: 'draft-receipt', file: new File(['original'], 'lawn.jpg', { type: 'image/jpeg' }),
    photoType: 'after', capturedAt: '2026-10-02T14:00:00Z', expectedVisit: captured,
  };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/photos/reconcile')) {
      reconciles += 1;
      const persisted = await getServicePhotoDraft('visit-a', 'tech-a');
      expect(persisted.uploadReceipt.photo.id).toBe('photo-receipt');
      if (reconciles === 1) {
        if (failureKind === 'network') throw new Error('Connection lost');
        return { ok: false, status: 503, json: async () => ({ error: 'Reconciliation unavailable' }) };
      }
      return { ok: true };
    }
    uploads += 1;
    return { ok: true, json: async () => ({ photo: { id: 'photo-receipt' }, reconcileRequired: true }) };
  }));
  let failure;
  try { await postServicePhoto(photo, 'visit-a', 'token', 'tech-a'); } catch (error) { failure = error; }
  expect(failure?.uploadStage).toBe('reconciliation_failed');
  await retainFailedPhoto(photo, 'visit-a', 'tech-a', failure, 'Updates still owed');
  const stored = await getServicePhotoDraft('visit-a', 'tech-a');
  expect(stored.stage).toBe('reconciliation_failed');
  const restored = restoreServicePhoto(stored, 'visit-a', 'tech-a');
  expect(restored.stage).toBe('reconciliation_failed');
  await expect(postServicePhoto(restored, 'visit-a', 'token', 'tech-a')).resolves.toMatchObject({ photo: { id: 'photo-receipt' } });
  expect(uploads).toBe(1);
  expect(reconciles).toBe(2);
});
