// Service-photo recovery operations shared by capture and explicit retry.
// UI state stays in the modal; this module owns file persistence, visit
// reconciliation, and upload receipts. No work runs on import.
import { getAdminUser } from './adminAuth';
import {
  deleteServicePhotoDraftIfCurrent,
  getServicePhotoDraft,
  putServicePhotoDraftIfCurrent,
} from './completion-resume-store';

const API = import.meta.env.VITE_API_URL || '';
const PHOTO_TYPES = ['before', 'after', 'progress', 'issue'];

const INTERRUPTED_UPLOAD_MESSAGE = 'This photo did not finish uploading. Retry the saved photo or discard it.';

function newDraftId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* use the fallback */ }
  return `service-photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentStaffId() {
  const id = getAdminUser()?.id;
  return id ? String(id) : '';
}

function servicePhotoDraftRecord(photo, serviceId, technicianId, stage, message = '') {
  return {
    version: 1,
    draftId: photo.draftId,
    serviceId: String(serviceId),
    technicianId: String(technicianId),
    stage,
    message,
    file: photo.file,
    fileName: photo.file?.name || '',
    fileType: photo.file?.type || '',
    fileLastModified: photo.file?.lastModified || 0,
    photoType: photo.photoType,
    caption: photo.caption,
    capturedAt: photo.capturedAt,
    expectedVisit: photo.expectedVisit || null,
  };
}

function ensureCurrentDeviceIdentity(deviceScope) {
  if (!deviceScope || currentStaffId() === deviceScope) return;
  const error = new Error('Signed-in technician changed. Close and reopen Service Photos before uploading.');
  error.identityChanged = true;
  throw error;
}

async function persistCurrentPhotoStage(photo, serviceId, deviceScope, stage, message, { verifyConflict = true } = {}) {
  const saved = await putServicePhotoDraftIfCurrent(
    serviceId,
    servicePhotoDraftRecord(photo, serviceId, deviceScope, stage, message),
    deviceScope,
    photo.draftId,
    { allowMissing: !photo.draftStored },
  );
  if (saved) {
    photo.draftStored = true;
    return 'saved';
  }
  if (verifyConflict) {
    const current = await getServicePhotoDraft(serviceId, deviceScope);
    if (current?.draftId && current.draftId !== photo.draftId) {
      const error = new Error('A newer saved photo is already pending for this visit. Close and reopen Service Photos.');
      error.superseded = true;
      throw error;
    }
  }
  return 'unavailable';
}

async function postServicePhoto(photo, serviceId, token) {
  const fd = new FormData();
  fd.append('photo', photo.file);
  fd.append('photoType', photo.photoType);
  fd.append('capturedAt', photo.capturedAt);
  if (photo.caption) fd.append('caption', photo.caption);
  if (photo.expectedVisit) fd.append('expectedVisit', JSON.stringify(photo.expectedVisit));
  const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data?.photo?.id) {
    if (data.reconcileRequired) await reconcileRecoveredPhoto(serviceId, token);
    return data;
  }
  if (res.ok) throw new Error('Upload response did not include a photo receipt');
  const failure = new Error(data.error || `HTTP ${res.status}`);
  failure.uploadStage = 'failed';
  failure.visitChanged = data.code === 'visit_identity_changed';
  throw failure;
}

async function reconcileRecoveredPhoto(serviceId, token) {
  const res = await fetch(`${API}/api/tech/services/${serviceId}/photos/reconcile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  const failure = new Error(data.error || `Photo attached, but visit reconciliation failed (HTTP ${res.status})`);
  failure.uploadStage = 'reconciliation_failed';
  throw failure;
}

async function getServicePhotos(serviceId, token) {
  const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const sameVisitValue = (left, right) => String(left ?? '') === String(right ?? '');
function photoVisitChanged(expected, live) {
  // During a rolling deploy an older server supplies neither side of the
  // snapshot contract. Preserve that deployed API until every pod serves the
  // new snapshot; one-sided absence is unverifiable and stays blocked.
  if (!expected && !live) return false;
  if (!expected || !live) return true;
  if (!sameVisitValue(expected.customerId, live.customerId)
    || !sameVisitValue(expected.propertyId, live.propertyId)
    || !sameVisitValue(expected.technicianId, live.technicianId)
    || !sameVisitValue(expected.scheduledDate, live.scheduledDate)
    || expected.revision !== live.revision) return true;
  return !sameVisitValue(expected.status, live.status) && live.status !== 'completed';
}

async function confirmPhotoDraft(photo, serviceId, deviceScope) {
  if (!deviceScope) return;
  const confirmed = await putServicePhotoDraftIfCurrent(
    serviceId,
    servicePhotoDraftRecord(photo, serviceId, deviceScope, 'confirmed'),
    deviceScope,
    photo.draftId,
  );
  if (confirmed) await deleteServicePhotoDraftIfCurrent(serviceId, deviceScope, photo.draftId);
}

function uploadFailureMessage(error, { saved = false } = {}) {
  if (error.visitChanged) return saved
    ? 'This visit changed since the photo was selected. Discard the saved photo, review the current visit, and select a new photo.'
    : 'This visit changed since the photo was selected. Keep this screen open, discard the selected photo, and review the current visit before selecting another.';
  if (error.visitVerificationFailed) return saved
    ? 'Could not verify the current visit. The saved photo was not uploaded. Retry after the visit is available, or discard it.'
    : 'Could not verify the current visit. Keep this screen open and retry, or discard the selected photo.';
  if (error.uploadStage === 'reconciliation_failed') return `${error.message}. Retry the saved photo to finish updating the completed visit.`;
  if (error.uploadStage === 'failed') return error.message || 'Upload failed';
  return `${error.message || 'Upload interrupted'}. Upload not confirmed — retry the saved photo or discard it.`;
}

async function retainFailedPhoto(photo, serviceId, deviceScope, error, message) {
  if (!deviceScope || error.superseded || error.identityChanged) return null;
  return persistCurrentPhotoStage(
    photo,
    serviceId,
    deviceScope,
    error.uploadStage || 'unconfirmed',
    message,
    { verifyConflict: false },
  );
}

function restoreServicePhoto(record, serviceId, technicianId) {
  if (!record?.file
    || String(record.serviceId) !== String(serviceId)
    || String(record.technicianId) !== String(technicianId)
    || !PHOTO_TYPES.includes(record.photoType)
    || !record.capturedAt) return null;
  try {
    const file = new File([record.file], record.fileName || 'service photo', {
      type: record.fileType || record.file.type || '',
      lastModified: Number(record.fileLastModified || 0),
    });
    return {
      draftId: record.draftId,
      draftStored: true,
      file,
      photoType: record.photoType,
      caption: typeof record.caption === 'string' ? record.caption : '',
      capturedAt: record.capturedAt,
      expectedVisit: record.expectedVisit || null,
    };
  } catch {
    return null;
  }
}

export {
  INTERRUPTED_UPLOAD_MESSAGE,
  newDraftId,
  currentStaffId,
  ensureCurrentDeviceIdentity,
  persistCurrentPhotoStage,
  postServicePhoto,
  getServicePhotos,
  photoVisitChanged,
  confirmPhotoDraft,
  uploadFailureMessage,
  retainFailedPhoto,
  restoreServicePhoto,
};
