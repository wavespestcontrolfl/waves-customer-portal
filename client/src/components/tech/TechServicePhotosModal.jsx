// client/src/components/tech/TechServicePhotosModal.jsx
//
// Tech-side service photo manager. Surfaces an existing tech-track
// API contract (POST/GET /api/tech/services/:id/photos) that until
// now had no UI — techs were working around it via curl/Postman.
//
// Endpoints:
//   GET  /api/tech/services/:id/photos  -> presigned thumbnails
//   POST /api/tech/services/:id/photos  -> multipart upload
//
// Photos taken before completion are staged against the scheduled visit.
// The completion transaction promotes them into service_photos once the
// immutable service_record exists, preserving true before/progress capture.
//
// PhotoType options come from VALID_PHOTO_TYPES in tech-track.js
// (before / after / issue / progress). Keep this set in sync if the
// server set ever changes — the UI lets users pick one before each
// upload so photos categorize correctly for the missed_photo
// detector / customer-track view downstream.
import { useCallback, useEffect, useRef, useState, useId } from 'react';
import { Camera } from 'lucide-react';
import { useFieldPortalClass } from './fieldPortal';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { getAdminAuthToken } from '../../lib/adminAuth';
import {
  deleteServicePhotoDraft,
  deleteServicePhotoDraftIfCurrent,
  getServicePhotoDraft,
  pruneServicePhotoDrafts,
} from '../../lib/completion-resume-store';
import {
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
} from '../../lib/service-photo-recovery';
import { DVH } from '../../lib/viewportUnits';
import TechPhotoMarksModal from './TechPhotoMarksModal';
import { UiSurface, Button, Field, Input, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const API = import.meta.env.VITE_API_URL || '';
const PHOTO_TYPES = ['before', 'after', 'progress', 'issue'];
// Mirrors MARKABLE_PHOTO_TYPES in tech-track.js. 'before' is definitionally
// pre-treatment, so it can never carry treated-point marks.
const MARKABLE_PHOTO_TYPES = new Set(['after', 'progress', 'issue']);

function PendingPhotoRecovery({ photo, uploading, deviceSaveState, restored, discarding, onRetry, onDiscard }) {
  if (!photo) return null;
  let progress = 'Photo upload is pending.';
  if (uploading) progress = deviceSaveState === 'saving' ? 'Saving photo on this device…' : 'Uploading photo…';
  else if (restored) progress = 'Recovered a photo saved on this device.';
  return <>
    <div className="tech-visit-card">
      <ActionFeedback className="tech-visit-feedback">{progress}</ActionFeedback>
      <p className="tech-visit-muted">{photo.file.name}</p>
      {!uploading && <div className="tech-visit-actions">
        <Button className="tech-visit-action tech-visit-primary" onClick={onRetry}>Retry upload</Button>
        <Button variant="secondary" className="tech-visit-action" onClick={onDiscard} loading={discarding}>{deviceSaveState === 'saved' ? 'Discard saved photo' : 'Discard selected photo'}</Button>
      </div>}
    </div>
    {deviceSaveState === 'saved' && <ActionFeedback className="tech-visit-feedback">Saved on this device for this visit. If the app closes, return to Retry or Discard.</ActionFeedback>}
    {deviceSaveState === 'unavailable' && <ActionFeedback error className="tech-visit-feedback">This photo is not saved on this device. Keep the app open until upload finishes, or the selected photo may be lost.</ActionFeedback>}
  </>;
}

export default function TechServicePhotosModal({ serviceId, customerName, onClose }) {
  const fieldPortalClass = useFieldPortalClass();
  const isMobile = useIsMobile();
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [photoType, setPhotoType] = useState('after');
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadError, setLoadError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [visitSnapshot, setVisitSnapshot] = useState(null);
  const [visitReadReady, setVisitReadReady] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const [deviceSaveState, setDeviceSaveState] = useState('idle');
  const [restoring, setRestoring] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [restoredPending, setRestoredPending] = useState(false);
  // Bind the upload token to the same login snapshot as the device scope.
  // Retry must never read a replacement login's fresh token for an older
  // technician's recovered File.
  const [deviceIdentity] = useState(() => ({ staffId: currentStaffId(), token: getAdminAuthToken() }));
  const deviceScope = deviceIdentity.staffId;
  const uploadInFlight = useRef(false);
  const pendingPhotoRef = useRef(null);
  const loadSequence = useRef(0);
  // Treated-point marking (GATE_PHOTO_MARKS, dark). The probe 404s when the
  // gate is off, which leaves marksSupported false and the affordance absent —
  // no separate client-side flag to keep in sync.
  const [marksSupported, setMarksSupported] = useState(false);
  const [markTarget, setMarkTarget] = useState(null);
  const fileInputRef = useRef(null);

  const close = () => {
    if (uploadInFlight.current) return;
    if (pendingPhoto && deviceSaveState !== 'saved'
      && !window.confirm('This photo is not saved on this device. Close and discard the selected photo?')) return;
    onClose?.();
  };
  useEffect(() => {
    if (!pendingPhoto || deviceSaveState === 'saved') return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingPhoto, deviceSaveState]);

  useEffect(() => {
    let cancelled = false;
    if (!serviceId || !deviceScope) return undefined;
    setRestoring(true);
    (async () => {
      // Prune first so an expired row cannot briefly appear as durable and
      // then be deleted behind the open recovery card.
      await pruneServicePhotoDrafts();
      if (cancelled) return;
      const record = await getServicePhotoDraft(serviceId, deviceScope);
      if (cancelled || !record) return;
      if (!record.draftId) {
        await deleteServicePhotoDraft(serviceId, deviceScope);
        return;
      }
      // A 2xx response was received before the app closed, but cleanup of
      // the recovery row did not finish. It is safe to forget without asking
      // the technician to send the same bytes again.
      if (record.stage === 'confirmed') {
        await deleteServicePhotoDraftIfCurrent(serviceId, deviceScope, record.draftId);
        return;
      }
      const restored = restoreServicePhoto(record, serviceId, deviceScope);
      if (!restored) {
        await deleteServicePhotoDraft(serviceId, deviceScope);
        return;
      }
      if (cancelled || pendingPhotoRef.current || uploadInFlight.current) return;
      pendingPhotoRef.current = restored;
      setPendingPhoto(restored);
      setPhotoType(restored.photoType);
      setCaption(restored.caption);
      setDeviceSaveState('saved');
      setRestoredPending(true);
      setErrorMsg(record.message || INTERRUPTED_UPLOAD_MESSAGE);
      setStatusMsg('');
    })().finally(() => {
      if (!cancelled) setRestoring(false);
    });
    return () => { cancelled = true; };
  }, [serviceId, deviceScope]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const data = await getServicePhotos(serviceId, deviceIdentity.token);
      if (sequence === loadSequence.current) {
        setPhotos(data.photos || []);
        setVisitSnapshot(data.visit || null);
        setVisitReadReady(true);
      }
    } catch (err) {
      if (sequence === loadSequence.current) setLoadError(err.message || 'Failed to load photos');
    }
    if (sequence === loadSequence.current) setLoading(false);
  }, [serviceId, deviceIdentity.token]);

  useEffect(() => {
    setVisitReadReady(false);
    setVisitSnapshot(null);
  }, [serviceId]);
  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, [load]);

  // Probe whether this lane takes treated-point marks. Fail-soft in both
  // directions: gate off returns 404 and any error leaves the affordance
  // hidden, so a marks outage never blocks ordinary photo capture.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAdminAuthToken();
        const res = await fetch(`${API}/api/tech/services/${serviceId}/photo-marks`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMarksSupported(Boolean(data.supported));
      } catch { /* affordance stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [serviceId]);

  const handlePickFile = () => {
    if (uploadInFlight.current || pendingPhoto || restoring || !visitReadReady) return;
    setErrorMsg('');
    setStatusMsg('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const uploadPhoto = async (photo, { verifyFresh = false } = {}) => {
    if (!photo || uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    setErrorMsg('');
    setStatusMsg('');
    setRestoredPending(false);
    try {
      ensureCurrentDeviceIdentity(deviceScope);
      if (verifyFresh) {
        let current;
        try {
          current = await getServicePhotos(serviceId, deviceIdentity.token);
        } catch (err) {
          err.visitVerificationFailed = true;
          throw err;
        }
        setPhotos(current.photos || []);
        setVisitSnapshot(current.visit || null);
        if (photoVisitChanged(photo.expectedVisit, current.visit)) {
          const changed = new Error('Visit changed');
          changed.visitChanged = true;
          throw changed;
        }
      }
      if (deviceScope) {
        setDeviceSaveState('saving');
        setDeviceSaveState(await persistCurrentPhotoStage(
          photo, serviceId, deviceScope, 'uploading', INTERRUPTED_UPLOAD_MESSAGE,
        ));
      } else {
        setDeviceSaveState('unavailable');
      }
      // Login can change while IndexedDB is writing. Fence again immediately
      // before reading the bearer token so an old technician's recovered File
      // is never sent under the next login.
      ensureCurrentDeviceIdentity(deviceScope);
      const data = await postServicePhoto(photo, serviceId, deviceIdentity.token);
      // Record the acknowledgement before clearing the recovery row. If the
      // app dies between those operations, restore silently clears the
      // confirmed row instead of presenting a duplicate Retry action.
      await confirmPhotoDraft(photo, serviceId, deviceScope);
      setStatusMsg(data.photo?.staged
        ? 'Photo saved — it will attach when the visit is completed'
        : 'Photo uploaded');
      pendingPhotoRef.current = null;
      setPendingPhoto(null);
      setDeviceSaveState('idle');
      setCaption('');
      void load();
    } catch (err) {
      const savedState = await retainFailedPhoto(
        photo, serviceId, deviceScope, err, uploadFailureMessage(err, { saved: true }),
      );
      const message = uploadFailureMessage(err, {
        saved: savedState === 'saved' || deviceSaveState === 'saved',
      });
      if (pendingPhotoRef.current?.draftId === photo.draftId) setErrorMsg(message);
      if (savedState && pendingPhotoRef.current?.draftId === photo.draftId) setDeviceSaveState(savedState);
    }
    uploadInFlight.current = false;
    setUploading(false);
  };

  const handleFileSelected = (event) => {
    const file = event.target.files?.[0];
    if (!file || uploadInFlight.current || pendingPhoto || !visitReadReady) return;
    const photo = {
      draftId: newDraftId(),
      draftStored: false,
      file,
      photoType,
      caption: caption.trim(),
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
      expectedVisit: visitSnapshot,
    };
    pendingPhotoRef.current = photo;
    setPendingPhoto(photo);
    void uploadPhoto(photo);
  };

  const discardPendingPhoto = async () => {
    if (!pendingPhoto || uploadInFlight.current || discarding) return;
    setDiscarding(true);
    if (deviceScope && deviceSaveState === 'saved') {
      const removed = await deleteServicePhotoDraftIfCurrent(serviceId, deviceScope, pendingPhoto.draftId);
      if (!removed) {
        setErrorMsg('Could not remove the saved photo from this device. Try Discard again.');
        setDeviceSaveState('saved');
        setDiscarding(false);
        return;
      }
    }
    pendingPhotoRef.current = null;
    setPendingPhoto(null);
    setDeviceSaveState('idle');
    setRestoredPending(false);
    setErrorMsg('');
    setDiscarding(false);
  };

  useLockBodyScroll(true);
  const dialogRef = useModalFocus(true, close);
  const titleId = useId();
  const locked = uploading || !!pendingPhoto || restoring;
  // DVH is 'dvh' where the engine supports it, 'vh' on pre-15.4 WebKit — see
  // lib/viewportUnits.js. Bridged in as a single CSS custom property so the
  // desktop height cap stays expressed in tech-workflow.css rather than an
  // inline layout object.
  return createPortal(
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay', isMobile && 'tech-visit-overlay--fullscreen', fieldPortalClass)}
      style={{ '--tech-vh': `1${DVH}` }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('tech-visit-dialog', isMobile ? 'tech-visit-dialog--fullscreen' : 'tech-visit-dialog--photo-cap')}
        aria-hidden={markTarget ? true : undefined}
        inert={markTarget ? '' : undefined}
      >
        <header className="tech-visit-header">
          <div><h2 id={titleId} className="tech-visit-title">Service Photos</h2>{customerName && <p className="tech-visit-muted">{customerName}</p>}</div>
          <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={close} disabled={uploading} aria-label="Close service photos">×</Button>
        </header>
        <div className="tech-visit-body">
          <div className="tech-visit-card">
            <h3 className="tech-visit-section-title">Type</h3>
            <div className="tech-visit-photo-types" role="group" aria-label="Photo type">
              {PHOTO_TYPES.map((type) => <Button key={type} variant="secondary" className="tech-visit-action" aria-pressed={photoType === type} onClick={() => setPhotoType(type)} disabled={locked}>{type}</Button>)}
            </div>
            <Field label="Caption (optional)" className="tech-visit-field">
              <Input className="tech-visit-control" value={caption} onChange={(event) => setCaption(event.target.value)}
                placeholder="e.g., Front yard before treatment" disabled={locked} />
            </Field>
            <Button className="tech-visit-action tech-visit-primary tech-visit-wide" onClick={handlePickFile} loading={uploading} disabled={!!pendingPhoto || restoring || !visitReadReady}><Camera size={18} aria-hidden="true" /> Add Photo</Button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelected} disabled={!visitReadReady} className="tech-visit-file-input" aria-label="Choose service photo" />
          </div>
          <PendingPhotoRecovery
            photo={pendingPhoto}
            uploading={uploading}
            deviceSaveState={deviceSaveState}
            restored={restoredPending}
            discarding={discarding}
            onRetry={() => uploadPhoto(pendingPhoto, { verifyFresh: true })}
            onDiscard={discardPendingPhoto}
          />
          {errorMsg && <ActionFeedback error className="tech-visit-feedback">{errorMsg}</ActionFeedback>}
          {statusMsg && !errorMsg && <ActionFeedback className="tech-visit-feedback">{statusMsg}</ActionFeedback>}
          <h3 className="tech-visit-section-title">Attached{!loading && !loadError ? ` (${photos.length})` : ''}</h3>
          {loading ? <ActionFeedback className="tech-visit-feedback">Loading…</ActionFeedback> : loadError ? <>
            <ActionFeedback error className="tech-visit-feedback">{loadError}</ActionFeedback>
            <Button variant="secondary" className="tech-visit-action" onClick={load}>Retry photos</Button>
          </> : photos.length === 0 ? <p className="tech-visit-muted">No photos yet.</p> : (
            <div className="tech-visit-photo-grid">
              {photos.map((photo) => <article key={photo.id} className="tech-visit-photo">
                <a href={photo.url} target="_blank" rel="noopener noreferrer" className="tech-visit-photo-link">
                  <img src={photo.url} alt={photo.caption || photo.photo_type} className="tech-visit-photo-image" />
                  <p className="tech-visit-photo-label">{photo.photo_type}{photo.staged ? ' · staged' : ''}</p>
                  {photo.caption && <p className="tech-visit-photo-label">{photo.caption}</p>}
                </a>
                {/* Existing marking gate and eligible photo types stay authoritative. */}
                {marksSupported && MARKABLE_PHOTO_TYPES.has(photo.photo_type) && <Button variant="secondary" className="tech-visit-action" onClick={(event) => { event.currentTarget.focus(); setMarkTarget(photo); }}>Mark spots</Button>}
              </article>)}
            </div>
          )}
        </div>
      </section>
      {markTarget && <TechPhotoMarksModal serviceId={serviceId} photo={markTarget} onClose={() => setMarkTarget(null)} />}
    </UiSurface>, document.body,
  );
}
