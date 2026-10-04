// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useServicePhotoRecovery from './useServicePhotoRecovery';

const auth = vi.hoisted(() => ({ getToken: vi.fn() }));
const store = vi.hoisted(() => ({
  deleteIfCurrent: vi.fn(),
  getDraft: vi.fn(),
  inspectDraft: vi.fn(),
  prune: vi.fn(),
}));
const recovery = vi.hoisted(() => ({
  confirm: vi.fn(),
  currentStaffId: vi.fn(),
  ensureIdentity: vi.fn(),
  getPhotos: vi.fn(),
  newDraftId: vi.fn(),
  persist: vi.fn(),
  photoVisitChanged: vi.fn(),
  postPhoto: vi.fn(),
  restore: vi.fn(),
  retain: vi.fn(),
  failureMessage: vi.fn(),
}));

vi.mock('../lib/adminAuth', () => ({ getAdminAuthToken: auth.getToken }));
vi.mock('../lib/completion-resume-store', () => ({
  deleteServicePhotoDraftIfCurrent: store.deleteIfCurrent,
  getServicePhotoDraft: store.getDraft,
  inspectServicePhotoDraft: store.inspectDraft,
  pruneServicePhotoDrafts: store.prune,
}));
vi.mock('../lib/service-photo-recovery', () => ({
  INTERRUPTED_UPLOAD_MESSAGE: 'Upload interrupted',
  confirmPhotoDraft: recovery.confirm,
  currentStaffId: recovery.currentStaffId,
  ensureCurrentDeviceIdentity: recovery.ensureIdentity,
  getServicePhotos: recovery.getPhotos,
  newDraftId: recovery.newDraftId,
  persistCurrentPhotoStage: recovery.persist,
  photoVisitChanged: recovery.photoVisitChanged,
  postServicePhoto: recovery.postPhoto,
  restoreServicePhoto: recovery.restore,
  retainFailedPhoto: recovery.retain,
  uploadFailureMessage: recovery.failureMessage,
}));

const visit = { customerId: 'customer-a', revision: 'revision-a', status: 'pending' };
const defaults = () => ({
  serviceId: 'visit-a',
  deviceIdentity: { staffId: 'tech-a', token: 'token-a' },
  visitSnapshot: visit,
  visitReadReady: true,
  onFreshPhotos: vi.fn(),
  onUploadFailed: vi.fn(),
  onUploaded: vi.fn(),
  refreshPhotos: vi.fn(),
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
let durableDraft;

function installLockManager() {
  const held = new Set();
  const request = vi.fn(async (name, options, callback) => {
    if (options?.ifAvailable && held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  installLockManager();
  durableDraft = null;
  auth.getToken.mockReturnValue('token-a');
  recovery.currentStaffId.mockReturnValue('tech-a');
  recovery.newDraftId.mockReturnValue('draft-a');
  recovery.persist.mockImplementation(async (photo) => {
    photo.draftStored = true;
    durableDraft = { ...photo };
    return 'saved';
  });
  recovery.postPhoto.mockResolvedValue({ photo: { id: 'photo-a', staged: false } });
  recovery.confirm.mockImplementation(async () => { durableDraft = null; return true; });
  recovery.retain.mockImplementation(async (photo) => { durableDraft = { ...photo }; return 'saved'; });
  recovery.restore.mockImplementation(record => (
    record?.file ? { ...record, draftStored: true } : null
  ));
  recovery.failureMessage.mockImplementation(error => error.message);
  recovery.photoVisitChanged.mockReturnValue(false);
  store.prune.mockResolvedValue(undefined);
  store.getDraft.mockResolvedValue(null);
  store.inspectDraft.mockImplementation(async (...args) => ({
    available: true, draft: durableDraft || await store.getDraft(...args),
  }));
  store.deleteIfCurrent.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else delete navigator.locks;
});

describe('service photo recovery controller', () => {
  it('uses conditional cleanup for an invalid restored record', async () => {
    const record = { draftId: 'stale-draft', stage: 'failed' };
    store.getDraft.mockResolvedValue(record);
    recovery.restore.mockReturnValue(null);
    store.deleteIfCurrent.mockResolvedValue(false);

    const { result } = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(result.current.restoring).toBe(false));

    expect(store.deleteIfCurrent).toHaveBeenCalledWith('visit-a', 'tech-a', 'stale-draft');
    expect(result.current.pendingPhoto).toBeNull();
  });

  it('restores a device-scoped draft and only clears it after durable discard succeeds', async () => {
    const record = { draftId: 'saved-a', stage: 'reconciliation_handed_off', message: 'hidden' };
    const photo = {
      draftId: 'saved-a',
      draftStored: true,
      file: new File(['photo'], 'yard.jpg'),
      stage: 'reconciliation_handed_off',
    };
    store.getDraft.mockResolvedValue(record);
    recovery.restore.mockReturnValue(photo);
    store.deleteIfCurrent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { result } = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(result.current.restoring).toBe(false));

    expect(store.prune.mock.invocationCallOrder[0]).toBeLessThan(store.getDraft.mock.invocationCallOrder[0]);
    expect(store.getDraft).toHaveBeenCalledWith('visit-a', 'tech-a');
    expect(recovery.restore).toHaveBeenCalledWith(record, 'visit-a', 'tech-a');
    expect(result.current).toMatchObject({
      pendingPhoto: { ...photo, serviceId: 'visit-a' },
      restoredPending: true,
      deviceSaveState: 'saved',
      closeNeedsConfirmation: false,
      errorMsg: '',
    });

    await act(async () => { expect(await result.current.discard()).toBe(false); });
    expect(result.current.pendingPhoto).toMatchObject(photo);
    expect(result.current.errorMsg).toMatch(/Could not dismiss/);

    await act(async () => { expect(await result.current.discard()).toBe(true); });
    expect(store.deleteIfCurrent).toHaveBeenLastCalledWith('visit-a', 'tech-a', 'saved-a');
    expect(result.current).toMatchObject({ pendingPhoto: null, deviceSaveState: 'idle', errorMsg: '' });
  });

  it('owns selection through persistence, upload confirmation, and refresh callbacks', async () => {
    const upload = deferred();
    recovery.postPhoto.mockReturnValue(upload.promise);
    const props = defaults();
    const { result } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    const file = new File(['photo'], 'lawn.jpg', { type: 'image/jpeg', lastModified: 1234 });

    act(() => {
      expect(result.current.selectPhoto(file, { photoType: 'before', caption: '  Front lawn  ' })).toBe(true);
    });
    await waitFor(() => expect(recovery.postPhoto).toHaveBeenCalledTimes(1));

    const photo = recovery.postPhoto.mock.calls[0][0];
    expect(photo).toMatchObject({
      draftId: 'draft-a', serviceId: 'visit-a', file, photoType: 'before', caption: 'Front lawn', expectedVisit: visit,
      capturedAt: new Date(1234).toISOString(),
    });
    expect(recovery.persist).toHaveBeenCalledWith(
      photo, 'visit-a', 'tech-a', 'uploading', 'Upload interrupted',
    );
    expect(recovery.postPhoto).toHaveBeenCalledWith(photo, 'visit-a', 'token-a', 'tech-a');
    expect(result.current.uploading).toBe(true);

    await act(async () => upload.resolve({ photo: { id: 'photo-a', staged: true } }));
    await waitFor(() => expect(result.current.uploading).toBe(false));

    expect(recovery.ensureIdentity).toHaveBeenCalledTimes(2);
    expect(recovery.confirm).toHaveBeenCalledWith(photo, 'visit-a', 'tech-a');
    expect(props.onUploaded).toHaveBeenCalledWith({ photo: { id: 'photo-a', staged: true } });
    expect(props.refreshPhotos).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ pendingPhoto: null, deviceSaveState: 'idle' });
  });

  it('closes the restore gate before layout effects on the initial render and a service switch', async () => {
    const secondRestore = deferred();
    const selections = [];
    let props = defaults();
    const { result, rerender } = renderHook(() => {
      const recoveryState = useServicePhotoRecovery(props);
      const attemptedService = useRef('');
      useLayoutEffect(() => {
        if (attemptedService.current === props.serviceId) return;
        attemptedService.current = props.serviceId;
        selections.push(recoveryState.selectPhoto(new File(['new'], 'new.jpg'), {
          photoType: 'after', caption: '',
        }));
      }, [props.serviceId, recoveryState.selectPhoto]);
      return recoveryState;
    });

    expect(selections).toEqual([false]);
    await waitFor(() => expect(result.current.restoring).toBe(false));
    store.prune.mockReturnValueOnce(secondRestore.promise);
    props = { ...props, serviceId: 'visit-b' };
    rerender();

    expect(selections).toEqual([false, false]);
    expect(result.current.restoring).toBe(true);
    expect(recovery.persist).not.toHaveBeenCalled();
    expect(recovery.postPhoto).not.toHaveBeenCalled();

    await act(async () => secondRestore.resolve());
    await waitFor(() => expect(result.current.restoring).toBe(false));
  });

  it('retains an accepted-photo receipt until draft confirmation is durable', async () => {
    let byteUploads = 0;
    recovery.postPhoto.mockImplementation(async (photo) => {
      if (!photo.uploadReceipt) {
        byteUploads += 1;
        photo.uploadReceipt = { photo: { id: 'photo-a', staged: false } };
      }
      return photo.uploadReceipt;
    });
    recovery.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    recovery.retain.mockResolvedValueOnce('unavailable');
    recovery.failureMessage.mockImplementation((error) => (
      error.uploadStage === 'receipt_unconfirmed' ? 'Keep the accepted receipt' : error.message
    ));
    const props = defaults();
    const { result } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.restoring).toBe(false));

    act(() => {
      expect(result.current.selectPhoto(new File(['photo'], 'yard.jpg'), {
        photoType: 'after', caption: '',
      })).toBe(true);
    });
    await waitFor(() => expect(result.current.uploading).toBe(false));

    expect(result.current).toMatchObject({
      pendingPhoto: {
        stage: 'receipt_unconfirmed',
        uploadReceipt: { photo: { id: 'photo-a', staged: false } },
      },
      deviceSaveState: 'unavailable',
      closeNeedsConfirmation: true,
      errorMsg: 'Keep the accepted receipt',
    });
    expect(props.onUploaded).not.toHaveBeenCalled();
    expect(props.onUploadFailed).toHaveBeenCalledWith(expect.objectContaining({
      uploadStage: 'receipt_unconfirmed',
    }));

    await act(async () => { await result.current.retry(); });
    expect(byteUploads).toBe(1);
    expect(result.current.pendingPhoto).toBeNull();
    expect(props.onUploaded).toHaveBeenCalledWith({ photo: { id: 'photo-a', staged: false } });
  });

  it('retains ownership when an accepted receipt cannot be persisted', async () => {
    const firstPost = deferred();
    let row = {
      draftId: 'shared-draft', serviceId: 'visit-a', technicianId: 'tech-a', stage: 'failed',
      file: new File(['photo'], 'yard.jpg'), photoType: 'after', caption: '',
      capturedAt: '2026-10-03T12:00:00.000Z', expectedVisit: visit,
    };
    let byteUploads = 0;
    store.getDraft.mockImplementation(async () => row);
    store.inspectDraft.mockImplementation(async () => ({ available: true, draft: row }));
    recovery.restore.mockImplementation(record => ({ ...record, draftStored: true }));
    recovery.getPhotos.mockResolvedValue({ photos: [], visit });
    recovery.persist.mockImplementation(async (photo) => {
      photo.draftStored = true;
      row = { ...photo };
      return 'saved';
    });
    recovery.retain.mockResolvedValue('unavailable');
    recovery.postPhoto.mockImplementation(async (photo) => {
      if (!photo.uploadReceipt) byteUploads += 1;
      if (recovery.postPhoto.mock.calls.length === 1) {
        await firstPost.promise;
        photo.uploadReceipt = { photo: { id: 'accepted-photo' }, reconcileRequired: true };
        throw Object.assign(new Error('Reconcile later'), { uploadStage: 'reconciliation_failed' });
      }
      return photo.uploadReceipt;
    });
    recovery.confirm.mockImplementation(async () => { row = null; return true; });
    const firstProps = defaults();
    const secondProps = defaults();
    const first = renderHook(() => useServicePhotoRecovery(firstProps));
    const second = renderHook(() => useServicePhotoRecovery(secondProps));
    await waitFor(() => expect(first.result.current.pendingPhoto?.draftId).toBe('shared-draft'));
    await waitFor(() => expect(second.result.current.pendingPhoto?.draftId).toBe('shared-draft'));

    let firstRetry;
    act(() => { firstRetry = first.result.current.retry(); });
    await waitFor(() => expect(recovery.postPhoto).toHaveBeenCalledTimes(1));
    await act(async () => { await second.result.current.retry(); });
    expect(second.result.current.errorMsg).toMatch(/active in another tab/i);
    await act(async () => { expect(await second.result.current.discard()).toBe(false); });
    expect(store.deleteIfCurrent).not.toHaveBeenCalled();

    await act(async () => { firstPost.resolve(); await firstRetry; });
    expect(first.result.current.pendingPhoto).toMatchObject({
      uploadReceipt: { photo: { id: 'accepted-photo' } }, stage: 'reconciliation_failed',
    });
    await act(async () => { await second.result.current.retry(); });
    expect(second.result.current.errorMsg).toMatch(/active in another tab/i);
    expect(recovery.postPhoto).toHaveBeenCalledTimes(1);
    expect(byteUploads).toBe(1);

    await act(async () => { await first.result.current.retry(); });
    expect(recovery.postPhoto).toHaveBeenCalledTimes(2);
    expect(recovery.postPhoto.mock.calls[1][0]).toMatchObject({
      uploadReceipt: { photo: { id: 'accepted-photo' } },
    });
    expect(first.result.current.pendingPhoto).toBeNull();
    await act(async () => { await second.result.current.retry(); });
    expect(recovery.postPhoto).toHaveBeenCalledTimes(2);
    expect(second.result.current.pendingPhoto).toBeNull();
    expect(firstProps.onUploadFailed).toHaveBeenCalledTimes(1);
    expect(firstProps.onUploaded).toHaveBeenCalledTimes(1);
    expect(secondProps.onUploaded).not.toHaveBeenCalled();
  });

  it('keeps ownership until an in-flight upload settles after unmount', async () => {
    const upload = deferred();
    let row = {
      draftId: 'shared-draft', serviceId: 'visit-a', technicianId: 'tech-a', stage: 'failed',
      file: new File(['photo'], 'yard.jpg'), photoType: 'after', caption: '',
      capturedAt: '2026-10-03T12:00:00.000Z', expectedVisit: visit,
    };
    store.getDraft.mockImplementation(async () => row);
    store.inspectDraft.mockImplementation(async () => ({ available: true, draft: row }));
    recovery.restore.mockImplementation(record => ({ ...record, draftStored: true }));
    recovery.getPhotos.mockResolvedValue({ photos: [], visit });
    recovery.persist.mockImplementation(async (photo) => {
      row = { ...photo };
      return 'saved';
    });
    recovery.postPhoto.mockReturnValue(upload.promise);
    recovery.confirm.mockImplementation(async () => { row = null; return true; });
    const first = renderHook(() => useServicePhotoRecovery(defaults()));
    const second = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(first.result.current.pendingPhoto?.draftId).toBe('shared-draft'));
    await waitFor(() => expect(second.result.current.pendingPhoto?.draftId).toBe('shared-draft'));

    let firstRetry;
    act(() => { firstRetry = first.result.current.retry(); });
    await waitFor(() => expect(recovery.postPhoto).toHaveBeenCalledTimes(1));
    first.unmount();
    await act(async () => { await second.result.current.retry(); });
    expect(second.result.current.errorMsg).toMatch(/active in another tab/i);
    expect(recovery.postPhoto).toHaveBeenCalledTimes(1);

    await act(async () => {
      upload.resolve({ photo: { id: 'photo-a', staged: false } });
      await firstRetry;
    });
    await act(async () => { await second.result.current.retry(); });
    expect(recovery.postPhoto).toHaveBeenCalledTimes(1);
    expect(second.result.current.pendingPhoto).toBeNull();
  });

  it.each([
    ['without cross-tab ownership support', () => { delete navigator.locks; }],
    ['when saved-draft storage is unreadable', () => {
      store.inspectDraft.mockResolvedValue({ available: false, draft: null });
    }],
  ])('keeps fresh upload, retry, and local discard available %s', async (_, arrangeFailure) => {
    arrangeFailure();
    recovery.getPhotos.mockResolvedValue({ photos: [], visit });
    recovery.retain.mockImplementation(async (_photo, _serviceId, scope) => (scope ? 'saved' : null));
    recovery.postPhoto.mockRejectedValueOnce(Object.assign(new Error('offline'), { uploadStage: 'failed' }));
    const props = defaults();
    const { result } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    act(() => expect(result.current.selectPhoto(new File(['photo'], 'yard.jpg'), {
      photoType: 'after', caption: '',
    })).toBe(true));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(recovery.persist).not.toHaveBeenCalled();
    expect(recovery.postPhoto).toHaveBeenLastCalledWith(
      expect.objectContaining({ draftStored: false }), 'visit-a', 'token-a', null,
    );
    expect(result.current).toMatchObject({
      pendingPhoto: expect.objectContaining({ draftStored: false }), closeNeedsConfirmation: true,
    });

    recovery.postPhoto.mockResolvedValueOnce({ photo: { id: 'photo-a', staged: false } });
    await act(async () => { await result.current.retry(); });
    expect(result.current.pendingPhoto).toBeNull();
    expect(props.onUploaded).toHaveBeenCalledTimes(1);
    expect(recovery.persist).not.toHaveBeenCalled();

    recovery.postPhoto.mockRejectedValueOnce(Object.assign(new Error('offline'), { uploadStage: 'failed' }));
    act(() => expect(result.current.selectPhoto(new File(['second'], 'second.jpg'), {
      photoType: 'before', caption: '',
    })).toBe(true));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    await act(async () => { expect(await result.current.discard()).toBe(true); });
    expect(result.current.pendingPhoto).toBeNull();
    expect(store.deleteIfCurrent).not.toHaveBeenCalled();
  });

  it('blocks a restored draft when cross-tab ownership is unavailable', async () => {
    delete navigator.locks;
    const record = {
      draftId: 'saved-a', serviceId: 'visit-a', technicianId: 'tech-a', stage: 'failed',
      file: new File(['photo'], 'yard.jpg'), photoType: 'after', caption: '',
      capturedAt: '2026-10-03T12:00:00.000Z', expectedVisit: visit,
    };
    store.getDraft.mockResolvedValue(record);
    recovery.restore.mockImplementation(saved => ({ ...saved, draftStored: true }));
    const { result } = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(result.current.pendingPhoto?.draftId).toBe('saved-a'));

    await act(async () => { await result.current.retry(); });

    expect(recovery.postPhoto).not.toHaveBeenCalled();
    expect(result.current.errorMsg).toMatch(/cannot safely coordinate/i);
  });

  it.each([
    ['stage persistence', true],
    ['photo POST', false],
    ['photo POST after unavailable persistence', false, true],
  ])('resumes a scoped draft restore after another service upload settles during %s', async (_, duringSave, unavailable) => {
    const stageSave = deferred();
    const upload = deferred();
    const record = { draftId: 'saved-b', stage: 'failed', message: 'Retry B' };
    const restored = { draftId: 'saved-b', draftStored: true, file: new File(['b'], 'b.jpg') };
    if (duringSave) recovery.persist.mockImplementationOnce(async (photo) => {
      await stageSave.promise; photo.draftStored = true; return 'saved';
    });
    else {
      if (unavailable) recovery.persist.mockResolvedValueOnce('unavailable');
      recovery.postPhoto.mockReturnValue(upload.promise);
    }
    store.getDraft.mockImplementation(service => Promise.resolve(service === 'visit-b' ? record : null));
    recovery.restore.mockReturnValue(restored);
    let props = defaults();
    const { result, rerender } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    act(() => result.current.selectPhoto(new File(['a'], 'a.jpg'), { photoType: 'before', caption: '' }));
    await waitFor(() => expect(duringSave ? recovery.persist : recovery.postPhoto).toHaveBeenCalledTimes(1));

    props = { ...props, serviceId: 'visit-b' };
    rerender();
    await waitFor(() => expect(store.getDraft).toHaveBeenCalledWith('visit-b', 'tech-a'));
    expect(result.current.pendingPhoto?.serviceId).toBe('visit-a');
    await act(async () => (duringSave
      ? stageSave.resolve() : upload.resolve({ photo: { id: 'photo-a' } })));

    await waitFor(() => expect(result.current.pendingPhoto?.draftId).toBe('saved-b'));
    expect(result.current).toMatchObject({ restoredPending: true, deviceSaveState: 'saved' });
    expect(recovery.postPhoto).toHaveBeenCalledTimes(duringSave ? 0 : 1);
    expect(props.onUploaded).not.toHaveBeenCalled();
    expect(props.refreshPhotos).not.toHaveBeenCalled();
  });

  it('protects an unavailable pending receipt but not a terminal handoff', async () => {
    recovery.persist.mockResolvedValue('unavailable');
    recovery.retain.mockResolvedValue('unavailable');
    const failAfterReceipt = (stage) => async (photo) => {
      photo.uploadReceipt = { photo: { id: 'photo-a' } };
      throw Object.assign(new Error('Report update pending'), { uploadStage: stage });
    };
    recovery.postPhoto.mockImplementationOnce(failAfterReceipt('reconciliation_handed_off'));

    const terminal = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(terminal.result.current.restoring).toBe(false));
    act(() => {
      terminal.result.current.selectPhoto(new File(['photo'], 'yard.jpg'), {
        photoType: 'after', caption: '',
      });
    });
    await waitFor(() => expect(terminal.result.current.uploading).toBe(false));
    expect(terminal.result.current).toMatchObject({
      pendingPhoto: { stage: 'reconciliation_handed_off' },
      deviceSaveState: 'unavailable',
      closeNeedsConfirmation: false,
    });
    terminal.unmount();

    recovery.persist.mockImplementation(async (photo) => {
      photo.draftStored = true;
      return 'saved';
    });
    const reconciliation = deferred();
    recovery.postPhoto.mockImplementationOnce(async (photo) => {
      await reconciliation.promise;
      return failAfterReceipt('reconciliation_pending')(photo);
    });
    let props = defaults();
    const pending = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(pending.result.current.restoring).toBe(false));
    const file = new File(['photo'], 'yard.jpg');
    act(() => {
      pending.result.current.selectPhoto(file, {
        photoType: 'after', caption: '',
      });
    });
    await waitFor(() => expect(recovery.postPhoto).toHaveBeenCalledTimes(2));
    props = { ...props, serviceId: 'visit-b', visitSnapshot: { ...visit, revision: 'revision-b' } };
    pending.rerender();
    await act(async () => reconciliation.resolve());
    await waitFor(() => expect(pending.result.current.uploading).toBe(false));
    expect(pending.result.current).toMatchObject({
      pendingPhoto: { stage: 'reconciliation_pending' },
      deviceSaveState: 'unavailable',
      closeNeedsConfirmation: true,
    });
    expect(props.onUploadFailed).not.toHaveBeenCalled();
    expect(props.refreshPhotos).not.toHaveBeenCalled();
    await waitFor(() => expect(pending.result.current.restoring).toBe(false));
    expect(pending.result.current.pendingPhoto).toMatchObject({
      file, serviceId: 'visit-a', uploadReceipt: { photo: { id: 'photo-a' } },
    });
    await act(async () => { await pending.result.current.retry(); });
    expect(pending.result.current.selectPhoto(new File(['new'], 'new.jpg'), {
      photoType: 'after', caption: '',
    })).toBe(false);
    expect(recovery.postPhoto).toHaveBeenCalledTimes(2);

    props = { ...props, serviceId: 'visit-a', visitSnapshot: visit };
    pending.rerender();
    await waitFor(() => expect(pending.result.current.restoring).toBe(false));
    await act(async () => { await pending.result.current.retry(); });
    expect(pending.result.current.pendingPhoto).toBeNull();
  });

  it('revalidates a restored photo before retry and retains it when the visit changed', async () => {
    const photo = {
      draftId: 'saved-a', draftStored: true, file: new File(['photo'], 'yard.jpg'), expectedVisit: visit,
    };
    store.getDraft.mockResolvedValue({ draftId: 'saved-a', stage: 'failed', message: 'Try again' });
    recovery.restore.mockReturnValue(photo);
    recovery.getPhotos.mockResolvedValue({ photos: [], visit: { ...visit, revision: 'revision-b' } });
    recovery.photoVisitChanged.mockReturnValue(true);
    recovery.failureMessage.mockReturnValue('The visit changed.');
    recovery.retain.mockResolvedValue('unavailable');
    const props = defaults();
    const { result } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.restoredPending).toBe(true));

    await act(async () => { await result.current.retry(); });

    expect(recovery.getPhotos).toHaveBeenCalledWith('visit-a', 'token-a');
    expect(props.onFreshPhotos).toHaveBeenCalledWith({
      photos: [], visit: { ...visit, revision: 'revision-b' },
    });
    expect(recovery.postPhoto).not.toHaveBeenCalled();
    expect(recovery.retain).toHaveBeenCalledWith(
      expect.objectContaining(photo), 'visit-a', 'tech-a', expect.objectContaining({ visitChanged: true }), 'The visit changed.',
    );
    expect(props.onUploadFailed).toHaveBeenCalledWith(expect.objectContaining({ visitChanged: true }));
    expect(result.current).toMatchObject({
      pendingPhoto: expect.objectContaining({ draftId: 'saved-a' }),
      deviceSaveState: 'unavailable',
      errorMsg: 'The visit changed.',
      uploading: false,
    });
    expect(props.refreshPhotos).toHaveBeenCalledTimes(1);
    await act(async () => { expect(await result.current.discard()).toBe(true); });
    expect(store.deleteIfCurrent).toHaveBeenCalledWith('visit-a', 'tech-a', 'saved-a');
  });

  it('refuses selection until the visit read is verified', async () => {
    const { result } = renderHook(() => useServicePhotoRecovery({ ...defaults(), visitReadReady: false }));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.selectPhoto(new File(['photo'], 'yard.jpg'), {
      photoType: 'after', caption: '',
    })).toBe(false);
    expect(recovery.persist).not.toHaveBeenCalled();
    expect(recovery.postPhoto).not.toHaveBeenCalled();
  });

  it('refuses selection while the saved-draft restore is unresolved', async () => {
    const restore = deferred();
    store.prune.mockReturnValue(restore.promise);
    const { result } = renderHook(() => useServicePhotoRecovery(defaults()));
    await waitFor(() => expect(result.current.restoring).toBe(true));

    expect(result.current.selectPhoto(new File(['new'], 'new.jpg'), {
      photoType: 'after', caption: '',
    })).toBe(false);
    expect(recovery.persist).not.toHaveBeenCalled();
    expect(recovery.postPhoto).not.toHaveBeenCalled();

    await act(async () => restore.resolve());
    await waitFor(() => expect(result.current.restoring).toBe(false));
  });

  it.each([[false, false], [true, false], [false, true]])('finishes a delayed discard (latest save unavailable: %s; empty next visit: %s)', async (unavailable, emptyVisit) => {
    const deletion = deferred();
    store.getDraft
      .mockResolvedValue(emptyVisit ? null : { draftId: 'saved-b', stage: 'failed' })
      .mockResolvedValueOnce({ draftId: 'saved-a', stage: 'failed' });
    recovery.restore.mockImplementation(record => ({
      draftId: record.draftId, draftStored: true, file: new File([record.draftId], `${record.draftId}.jpg`),
    }));
    store.inspectDraft.mockResolvedValue({
      available: true, draft: { draftId: 'saved-a', stage: 'failed' },
    });
    store.deleteIfCurrent.mockReturnValue(deletion.promise);
    let props = defaults();
    const { result, rerender } = renderHook(() => useServicePhotoRecovery(props));
    await waitFor(() => expect(result.current.pendingPhoto?.draftId).toBe('saved-a'));

    if (unavailable) {
      recovery.getPhotos.mockRejectedValueOnce(new Error('offline'));
      recovery.retain.mockResolvedValueOnce('unavailable');
      await act(async () => result.current.retry());
    }
    let discardPromise;
    act(() => { discardPromise = result.current.discard(); });
    await act(async () => {
      await result.current.retry();
      expect(await result.current.discard()).toBe(false);
    });
    expect(recovery.postPhoto).not.toHaveBeenCalled();
    expect(recovery.getPhotos).toHaveBeenCalledTimes(unavailable ? 1 : 0);
    props = { ...props, serviceId: 'visit-b', visitSnapshot: { ...visit, revision: 'revision-b' } };
    rerender();
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.pendingPhoto?.draftId).toBe(unavailable ? 'saved-a' : emptyVisit ? undefined : 'saved-b');
    expect(result.current.selectPhoto(new File(['new'], 'new.jpg'), { photoType: 'after', caption: '' })).toBe(false);
    await act(async () => {
      deletion.resolve(true);
      expect(await discardPromise).toBe(unavailable);
    });
    expect(store.deleteIfCurrent).toHaveBeenCalledWith('visit-a', 'tech-a', 'saved-a');
    await waitFor(() => expect(result.current.pendingPhoto?.draftId).toBe(emptyVisit ? undefined : 'saved-b'));
    if (emptyVisit) {
      store.inspectDraft.mockResolvedValue({ available: true, draft: null });
      act(() => expect(result.current.selectPhoto(new File(['new'], 'new.jpg'), { photoType: 'after', caption: '' })).toBe(true));
      await waitFor(() => expect(recovery.postPhoto).toHaveBeenCalledTimes(1));
    }
  });
});
