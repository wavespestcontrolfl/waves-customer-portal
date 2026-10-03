import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminAuthToken } from '../lib/adminAuth';
import {
  deleteServicePhotoDraftIfCurrent,
  getServicePhotoDraft,
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
const samePendingPhoto = (photo, pendingPhoto) => (
  pendingPhoto?.serviceId === photo.serviceId && pendingPhoto?.draftId === photo.draftId
);

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
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const [deviceSaveState, setDeviceSaveState] = useState('idle');
  const [restoring, setRestoring] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [restoredPending, setRestoredPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [deviceIdentity] = useState(initialDeviceIdentity);
  const pendingPhotoRef = useRef(null);
  const deviceSaveStateRef = useRef(deviceSaveState);
  const uploadInFlight = useRef(false);
  const discardInFlight = useRef(false);
  const deviceScope = deviceIdentity.staffId;
  const activeServiceId = String(serviceId || '');
  const activeServiceIdRef = useRef(activeServiceId);
  activeServiceIdRef.current = activeServiceId;

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
      setRestoring(false);
      return undefined;
    }
    setRestoring(true);
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
    })().finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [activeServiceId, deviceScope, restoreAttempt]);

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
      const savedState = await persistBeforeUpload(photo, photoServiceId, deviceScope);
      deviceSaveStateRef.current = savedState;
      setDeviceSaveState(savedState);
      if (!stillActive()) return;
      ensureCurrentDeviceIdentity(deviceScope);
      const data = await postServicePhoto(photo, photoServiceId, deviceIdentity.token, deviceScope);
      await confirmPhotoDraft(photo, photoServiceId, deviceScope);
      if (samePendingPhoto(photo, pendingPhotoRef.current)) {
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
      const savedState = await retainFailedPhoto(
        photo, photoServiceId, deviceScope, error, uploadFailureMessage(error, { saved: true }),
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
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
      if (activeServiceIdRef.current !== photoServiceId) setRestoreAttempt(attempt => attempt + 1);
    }
  }, [deviceIdentity.token, deviceScope, deviceSaveState, onFreshPhotos, onUploadFailed, onUploaded, refreshPhotos]);

  const selectPhoto = useCallback((file, { photoType, caption }) => {
    if (!file || !activeServiceId || restoring || uploadInFlight.current || pendingPhotoRef.current || !visitReadReady) return false;
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
    if (!photo || photo.serviceId !== activeServiceIdRef.current || uploadInFlight.current || discardInFlight.current) return false;
    discardInFlight.current = true;
    setDiscarding(true);
    const removed = !deviceScope || !photo.draftStored
      || await deleteServicePhotoDraftIfCurrent(photo.serviceId, deviceScope, photo.draftId);
    if (!samePendingPhoto(photo, pendingPhotoRef.current)) {
      discardInFlight.current = false;
      setDiscarding(false);
      return false;
    }
    if (!removed) {
      setErrorMsg(terminalHandoff(photo.stage)
        ? 'Could not dismiss the saved notice from this device. Try Dismiss again.'
        : 'Could not remove the saved photo from this device. Try Discard again.');
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
    discardInFlight.current = false;
    setDiscarding(false);
    if (activeServiceIdRef.current !== photo.serviceId) setRestoreAttempt(attempt => attempt + 1);
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
