import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAdminAuthToken } from '../lib/adminAuth';
import {
  deleteServicePhotoDraftIfCurrent,
  getServicePhotoDraft,
  inspectServicePhotoDraft,
  pruneServicePhotoDrafts,
} from '../lib/completion-resume-store';
import {
  INTERRUPTED_UPLOAD_MESSAGE,
  confirmPhotoDraft,
  currentStaffId,
  ensureCurrentDeviceIdentity,
  getServicePhotos,
  newDraftId,
  persistCurrentPhotoStage,
  photoVisitChanged,
  postServicePhoto,
  restoreServicePhoto,
  retainFailedPhoto,
  uploadFailureMessage,
} from '../lib/service-photo-recovery';

const terminalHandoff = (stage) => stage === 'reconciliation_handed_off';
const visibleError = (stage, message) => (terminalHandoff(stage) ? '' : message);

export function createServicePhotoDeviceIdentity() {
  return { staffId: currentStaffId(), token: getAdminAuthToken() };
}

const canUploadPhoto = (photo, activeServiceId, inFlight) => (
  Boolean(photo) && photo.serviceId === activeServiceId && !inFlight
);
const releaseDiscardClaim = (preserveReceiptClaim, mounted) => !preserveReceiptClaim || !mounted;
const samePendingPhoto = (photo, pendingPhoto) => (
  pendingPhoto?.serviceId === photo.serviceId && pendingPhoto?.draftId === photo.draftId
);

function photoOwnershipError(message, type) {
  return Object.assign(new Error(message), { photoOwnership: type });
}

const claimMatchesPhoto = (claim, photo, deviceScope) => (
  claim?.draftId === photo.draftId
  && claim.serviceId === photo.serviceId
  && claim.deviceScope === deviceScope
);

async function releaseServicePhotoClaim(claimRef, photo, deviceScope) {
  const claim = claimRef.current;
  if (!claim || (photo && !claimMatchesPhoto(claim, photo, deviceScope))) return;
  claimRef.current = null;
  claim.release();
  await claim.done;
}

async function acquireServicePhotoClaim(photo, deviceScope, claimRef, mountedRef) {
  const incumbent = claimRef.current;
  if (claimMatchesPhoto(incumbent, photo, deviceScope)) return { claim: incumbent, existing: true };
  if (incumbent) throw photoOwnershipError(
    'Finish the pending photo before handling another saved photo.', 'busy',
  );
  let locks;
  try { locks = typeof navigator !== 'undefined' ? navigator.locks : null; } catch { locks = null; }
  if (typeof locks?.request !== 'function') {
    throw photoOwnershipError(
      'This browser cannot safely coordinate photo recovery across tabs. Close other tabs and reopen this screen in an updated browser.',
      'unavailable',
    );
  }
  let release;
  let settleAcquisition;
  const held = new Promise(resolve => { release = resolve; });
  const acquired = new Promise(resolve => { settleAcquisition = resolve; });
  const claim = {
    deviceScope,
    draftId: photo.draftId,
    serviceId: photo.serviceId,
    release,
    done: null,
  };
  claim.done = Promise.resolve().then(() => locks.request(
    `waves-service-photo:${deviceScope || 'anonymous'}:${photo.serviceId}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      settleAcquisition({ lock });
      if (lock) await held;
    },
  )).catch(error => { settleAcquisition({ error }); });
  const result = await acquired;
  if (result.error) throw photoOwnershipError(
    'Could not claim this photo for recovery. Keep this screen open and try again.', 'unavailable',
  );
  if (!result.lock) throw photoOwnershipError(
    'This photo is active in another tab. Finish there, then try again.', 'busy',
  );
  claimRef.current = claim;
  if (!mountedRef.current) {
    await releaseServicePhotoClaim(claimRef, photo, deviceScope);
    throw photoOwnershipError('This photo screen was closed.', 'stale');
  }
  return { claim, existing: false };
}

function adoptCurrentServicePhotoDraft(photo, deviceScope, current, differentDraft) {
  if (current.draft && current.draft.draftId !== photo.draftId) {
    if (differentDraft === 'stale') {
      throw photoOwnershipError('A newer photo is already pending for this visit.', 'stale');
    }
    throw photoOwnershipError(
      'Another saved photo is pending for this visit. Close and reopen Service Photos.', 'conflict',
    );
  }
  if (!current.draft && photo.draftStored) {
    throw photoOwnershipError('This photo was already handled in another tab.', 'stale');
  }
  if (!current.draft) return;
  if (current.draft.stage === 'confirmed') {
    throw photoOwnershipError('This photo was already handled in another tab.', 'stale');
  }
  const latest = restoreServicePhoto(current.draft, photo.serviceId, deviceScope);
  if (!latest) throw photoOwnershipError(
    'Could not verify this saved photo. Keep this screen open and try again.', 'unavailable',
  );
  Object.assign(photo, latest, {
    // A receipt can be newer than IndexedDB when its best-effort stage
    // write failed. Never regress to bytes-only state.
    uploadReceipt: latest.uploadReceipt || photo.uploadReceipt,
    serviceId: photo.serviceId,
  });
}

async function withServicePhotoOwnership(
  photo,
  deviceScope,
  claimRef,
  mountedRef,
  operation,
  { differentDraft = 'conflict' } = {},
) {
  let ownership;
  try {
    ownership = await acquireServicePhotoClaim(photo, deviceScope, claimRef, mountedRef);
  } catch (error) {
    // A never-persisted selection is private to this controller. Preserve the
    // older-browser path without exposing restored bytes to another tab.
    if (error?.photoOwnership === 'unavailable' && !photo.draftStored) return operation(null);
    throw error;
  }
  let current;
  try {
    current = await inspectServicePhotoDraft(photo.serviceId, deviceScope);
  } catch {
    current = { available: false, draft: null };
  }
  if (!current.available) {
    if (!photo.draftStored) return operation(null);
    // The controller already owns this exact draft and holds its accepted
    // receipt in memory, so retry cannot send the bytes again.
    if (ownership.existing && photo.uploadReceipt?.photo?.id) return operation(deviceScope);
    throw photoOwnershipError(
      'Could not verify saved photos for this visit. Keep this screen open and try again.', 'unavailable',
    );
  }
  adoptCurrentServicePhotoDraft(photo, deviceScope, current, differentDraft);
  return operation(deviceScope, current);
}

async function verifyFreshPhotoVisit(photo, serviceId, token, onFreshPhotos) {
  if (photo.uploadReceipt?.photo?.id) return;
  let current;
  try {
    current = await getServicePhotos(serviceId, token);
  } catch (error) {
    error.visitVerificationFailed = true;
    throw error;
  }
  onFreshPhotos(current);
  if (photoVisitChanged(photo.expectedVisit, current.visit)) {
    const changed = new Error('Visit changed');
    changed.visitChanged = true;
    throw changed;
  }
}

const persistBeforeUpload = (photo, serviceId, deviceScope) => (
  deviceScope
    ? persistCurrentPhotoStage(photo, serviceId, deviceScope, 'uploading', INTERRUPTED_UPLOAD_MESSAGE)
    : Promise.resolve('unavailable')
);

const discardOwnedPhoto = (photo, deviceScope, current) => (
  current?.available && !current.draft
    ? Promise.resolve(true)
    : deleteServicePhotoDraftIfCurrent(photo.serviceId, deviceScope, photo.draftId)
);

export default function useServicePhotoRecovery({
  serviceId,
  deviceIdentity: initialDeviceIdentity,
  visitSnapshot,
  visitReadReady,
  onFreshPhotos,
  onUploadFailed,
  onUploaded,
  refreshPhotos,
}) {
  const [deviceIdentity] = useState(initialDeviceIdentity);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const deviceScope = deviceIdentity.staffId;
  const activeServiceId = String(serviceId || '');
  const restoreToken = useMemo(
    () => ({ activeServiceId, deviceScope, restoreAttempt }),
    [activeServiceId, deviceScope, restoreAttempt],
  );
  const [restoredToken, setRestoredToken] = useState(null);
  const restoring = Boolean(activeServiceId && deviceScope && restoredToken !== restoreToken);
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const [deviceSaveState, setDeviceSaveState] = useState('idle');
  const [discarding, setDiscarding] = useState(false);
  const [restoredPending, setRestoredPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const pendingPhotoRef = useRef(null);
  const deviceSaveStateRef = useRef(deviceSaveState);
  const uploadInFlight = useRef(false);
  const discardInFlight = useRef(false);
  const ownershipClaimRef = useRef(null);
  const mountedRef = useRef(true);
  const activeServiceIdRef = useRef(activeServiceId);
  activeServiceIdRef.current = activeServiceId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!uploadInFlight.current && !discardInFlight.current) {
        void releaseServicePhotoClaim(ownershipClaimRef);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const retainUnsavedPhoto = pendingPhotoRef.current
      && (uploadInFlight.current || deviceSaveStateRef.current !== 'saved');
    if (!retainUnsavedPhoto) {
      pendingPhotoRef.current = null;
      deviceSaveStateRef.current = 'idle';
      setPendingPhoto(null);
      setDeviceSaveState('idle');
      setRestoredPending(false);
      setErrorMsg('');
    }
    if (!activeServiceId || !deviceScope) {
      return undefined;
    }
    (async () => {
      await pruneServicePhotoDrafts();
      if (cancelled) return;
      const record = await getServicePhotoDraft(activeServiceId, deviceScope);
      if (cancelled || !record) return;
      if (!record.draftId) return;
      if (record.stage === 'confirmed') {
        await deleteServicePhotoDraftIfCurrent(activeServiceId, deviceScope, record.draftId);
        return;
      }
      const restored = restoreServicePhoto(record, activeServiceId, deviceScope);
      if (!restored) {
        await deleteServicePhotoDraftIfCurrent(activeServiceId, deviceScope, record.draftId);
        return;
      }
      if (cancelled || pendingPhotoRef.current || uploadInFlight.current) return;
      const scopedPhoto = { ...restored, serviceId: activeServiceId };
      pendingPhotoRef.current = scopedPhoto;
      deviceSaveStateRef.current = 'saved';
      setPendingPhoto(scopedPhoto);
      setDeviceSaveState('saved');
      setRestoredPending(true);
      setErrorMsg(visibleError(restored.stage, record.message || INTERRUPTED_UPLOAD_MESSAGE));
    })().finally(() => { if (!cancelled) setRestoredToken(restoreToken); });
    return () => { cancelled = true; };
  }, [activeServiceId, deviceScope, restoreAttempt, restoreToken]);

  useEffect(() => {
    if (!pendingPhoto || deviceSaveState === 'saved' || terminalHandoff(pendingPhoto.stage)) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingPhoto, deviceSaveState]);

  const uploadPhoto = useCallback(async (photo, { verifyFresh = false } = {}) => {
    const photoServiceId = String(photo?.serviceId || '');
    if (!canUploadPhoto(photo, activeServiceIdRef.current, uploadInFlight.current || discardInFlight.current)) return;
    const stillActive = () => activeServiceIdRef.current === photoServiceId;
    uploadInFlight.current = true;
    setUploading(true);
    setErrorMsg('');
    setRestoredPending(false);
    let keepOwnership = Boolean(
      claimMatchesPhoto(ownershipClaimRef.current, photo, deviceScope) && photo.uploadReceipt?.photo?.id,
    );
    const retainUploadFailure = async (error, persistenceScope) => {
      const savedState = await retainFailedPhoto(
        photo, photoServiceId, persistenceScope, error, uploadFailureMessage(error, { saved: true }),
      );
      keepOwnership = Boolean(
        persistenceScope && photo.uploadReceipt?.photo?.id && savedState !== 'saved',
      );
      const message = uploadFailureMessage(error, {
        saved: savedState === 'saved' || deviceSaveState === 'saved',
      });
      if (samePendingPhoto(photo, pendingPhotoRef.current)) {
        if (savedState) deviceSaveStateRef.current = savedState;
        photo.stage = error.uploadStage;
        pendingPhotoRef.current = photo;
        setPendingPhoto({ ...photo });
        setErrorMsg(visibleError(error.uploadStage, message));
        if (savedState) setDeviceSaveState(savedState);
        if (stillActive()) {
          onUploadFailed(error);
          refreshPhotos();
        }
      }
    };
    try {
      await withServicePhotoOwnership(photo, deviceScope, ownershipClaimRef, mountedRef, async (persistenceScope) => {
        try {
          ensureCurrentDeviceIdentity(deviceScope);
          if (verifyFresh) {
            await verifyFreshPhotoVisit(photo, photoServiceId, deviceIdentity.token, (current) => {
              if (stillActive()) onFreshPhotos(current);
            });
            if (!stillActive()) return;
          }
          deviceSaveStateRef.current = 'saving';
          setDeviceSaveState('saving');
          const savedState = await persistBeforeUpload(photo, photoServiceId, persistenceScope);
          deviceSaveStateRef.current = savedState;
          setDeviceSaveState(savedState);
          if (!stillActive()) return;
          ensureCurrentDeviceIdentity(deviceScope);
          const data = await postServicePhoto(photo, photoServiceId, deviceIdentity.token, persistenceScope);
          const confirmationDurable = await confirmPhotoDraft(photo, photoServiceId, persistenceScope);
          if (!confirmationDurable) {
            const failure = new Error('Photo attached, but this device could not save its upload receipt');
            failure.uploadStage = 'receipt_unconfirmed';
            throw failure;
          }
          if (samePendingPhoto(photo, pendingPhotoRef.current)) {
            keepOwnership = false;
            pendingPhotoRef.current = null;
            deviceSaveStateRef.current = 'idle';
            setPendingPhoto(null);
            setDeviceSaveState('idle');
            if (stillActive()) {
              onUploaded(data);
              refreshPhotos();
            }
          }
        } catch (error) {
          await retainUploadFailure(error, persistenceScope);
        }
      });
    } catch (error) {
      if (error.photoOwnership === 'stale' && samePendingPhoto(photo, pendingPhotoRef.current)) {
        pendingPhotoRef.current = null;
        deviceSaveStateRef.current = 'idle';
        setPendingPhoto(null);
        setDeviceSaveState('idle');
        setRestoredPending(false);
        setErrorMsg('');
        if (stillActive()) refreshPhotos();
        setRestoreAttempt(attempt => attempt + 1);
      } else if (error.photoOwnership) {
        setErrorMsg(error.message);
      } else {
        await retainUploadFailure(error, deviceScope);
      }
    } finally {
      if (!keepOwnership || !mountedRef.current) {
        await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
      }
      uploadInFlight.current = false;
      setUploading(false);
      if (activeServiceIdRef.current !== photoServiceId) setRestoreAttempt(attempt => attempt + 1);
    }
  }, [deviceIdentity.token, deviceScope, deviceSaveState, onFreshPhotos, onUploadFailed, onUploaded, refreshPhotos]);

  const selectPhoto = useCallback((file, { photoType, caption }) => {
    if (!file || !activeServiceId || restoring || uploadInFlight.current || discardInFlight.current || pendingPhotoRef.current || !visitReadReady) return false;
    const photo = {
      draftId: newDraftId(),
      draftStored: false,
      serviceId: activeServiceId,
      file,
      photoType,
      caption: caption.trim(),
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
      expectedVisit: visitSnapshot,
    };
    pendingPhotoRef.current = photo;
    setPendingPhoto(photo);
    void uploadPhoto(photo);
    return true;
  }, [activeServiceId, restoring, uploadPhoto, visitReadReady, visitSnapshot]);

  const retry = useCallback(() => uploadPhoto(pendingPhotoRef.current, { verifyFresh: true }), [uploadPhoto]);

  const discard = useCallback(async () => {
    const photo = pendingPhotoRef.current;
    if (!canUploadPhoto(
      photo, activeServiceIdRef.current, uploadInFlight.current || discardInFlight.current,
    )) return false;
    discardInFlight.current = true;
    setDiscarding(true);
    const existingReceiptClaim = Boolean(
      claimMatchesPhoto(ownershipClaimRef.current, photo, deviceScope) && photo.uploadReceipt?.photo?.id,
    );
    if (!photo.draftStored && !existingReceiptClaim) {
      pendingPhotoRef.current = null;
      deviceSaveStateRef.current = 'idle';
      setPendingPhoto(null);
      setDeviceSaveState('idle');
      setRestoredPending(false);
      setErrorMsg('');
      discardInFlight.current = false;
      setDiscarding(false);
      await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
      return true;
    }
    const preserveReceiptClaim = existingReceiptClaim;
    let removed = false;
    let ownershipStale = false;
    try {
      await withServicePhotoOwnership(photo, deviceScope, ownershipClaimRef, mountedRef, async (_scope, current) => {
        removed = await discardOwnedPhoto(photo, deviceScope, current);
      }, { differentDraft: 'stale' });
    } catch (error) {
      if (error.photoOwnership === 'stale') {
        ownershipStale = true;
        removed = true;
      }
      else {
        setErrorMsg(error.message || 'Could not safely discard this photo. Try again.');
        if (releaseDiscardClaim(preserveReceiptClaim, mountedRef.current)) {
          await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
        }
        discardInFlight.current = false;
        setDiscarding(false);
        return false;
      }
    }
    if (!samePendingPhoto(photo, pendingPhotoRef.current)) {
      if (releaseDiscardClaim(preserveReceiptClaim, mountedRef.current)) {
        await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
      }
      discardInFlight.current = false;
      setDiscarding(false);
      return false;
    }
    if (!removed) {
      setErrorMsg(terminalHandoff(photo.stage)
        ? 'Could not dismiss the saved notice from this device. Try Dismiss again.'
        : 'Could not remove the saved photo from this device. Try Discard again.');
      if (releaseDiscardClaim(preserveReceiptClaim, mountedRef.current)) {
        await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
      }
      discardInFlight.current = false;
      setDiscarding(false);
      return false;
    }
    pendingPhotoRef.current = null;
    deviceSaveStateRef.current = 'idle';
    setPendingPhoto(null);
    setDeviceSaveState('idle');
    setRestoredPending(false);
    setErrorMsg('');
    await releaseServicePhotoClaim(ownershipClaimRef, photo, deviceScope);
    discardInFlight.current = false;
    setDiscarding(false);
    if (ownershipStale || activeServiceIdRef.current !== photo.serviceId) {
      setRestoreAttempt(attempt => attempt + 1);
    }
    return true;
  }, [deviceScope]);

  return {
    pendingPhoto,
    deviceSaveState,
    restoring,
    discarding,
    restoredPending,
    uploading,
    errorMsg,
    setErrorMsg,
    selectPhoto,
    retry,
    discard,
    uploadInFlight,
    closeNeedsConfirmation: Boolean(
      pendingPhoto && deviceSaveState !== 'saved' && !terminalHandoff(pendingPhoto.stage),
    ),
  };
}
