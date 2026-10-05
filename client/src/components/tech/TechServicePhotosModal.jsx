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
import useServicePhotoRecovery, { createServicePhotoDeviceIdentity } from '../../hooks/useServicePhotoRecovery';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { ensureCurrentDeviceIdentity, getServicePhotos } from '../../lib/service-photo-recovery';
import { DVH } from '../../lib/viewportUnits';
import TechPhotoMarksModal from './TechPhotoMarksModal';
import { UiSurface, Button, Field, Input, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const API = import.meta.env.VITE_API_URL || '';
const PHOTO_TYPES = ['before', 'after', 'progress', 'issue'];
// Mirrors MARKABLE_PHOTO_TYPES in tech-track.js. 'before' is definitionally
// pre-treatment, so it can never carry treated-point marks.
const MARKABLE_PHOTO_TYPES = new Set(['after', 'progress', 'issue']);
const hasUploadReceipt = photo => Boolean(photo?.uploadReceipt?.photo?.id);
const closeConfirmationMessage = photo => (hasUploadReceipt(photo)
  ? 'The photo is attached, but the pending report update notice is not saved on this device. Close anyway?'
  : 'This photo is not saved on this device. Close and discard the selected photo?');
const unavailableRecoveryMessage = (photo) => {
  if (photo.stage === 'reconciliation_handed_off') {
    return 'This handed-off notice could not be saved on this device. The photo remains attached and the office owns the remaining report updates.';
  }
  if (hasUploadReceipt(photo)) {
    return 'The photo is attached, but this pending report update notice is not saved on this device. Keep the app open until it is resolved.';
  }
  return 'This photo is not saved on this device. Keep the app open until upload finishes, or the selected photo may be lost.';
};

function PendingPhotoRecovery({ photo, serviceId, uploading, deviceSaveState, restored, discarding, onRetry, onDiscard }) {
  if (!photo) return null;
  const handedOff = photo.stage === 'reconciliation_handed_off';
  if (photo.serviceId !== String(serviceId)) return <div className="tech-visit-card">
    <p role="status" className="tech-visit-muted">{handedOff
      ? 'This report-update notice belongs to another visit. Return to that visit to dismiss it.'
      : 'This pending photo belongs to another visit. Return to that visit to retry or discard it.'}</p>
    <p className="tech-visit-muted">{photo.file.name}</p>
  </div>;
  let progress = 'Photo upload is pending.';
  if (handedOff) progress = 'Photo attached. Report updates were handed to the office.';
  else if (uploading) progress = deviceSaveState === 'saving' ? 'Saving photo on this device…' : 'Uploading photo…';
  else if (restored) progress = 'Recovered a photo saved on this device.';
  return <>
    <div className="tech-visit-card">
      <p role="status" className="tech-visit-muted">{progress}</p>
      <p className="tech-visit-muted">{photo.file.name}</p>
      {!uploading && <div className="tech-visit-actions">
        {!handedOff && <Button className="tech-visit-action tech-visit-primary" onClick={onRetry} disabled={discarding}>Retry upload</Button>}
        {(handedOff || !hasUploadReceipt(photo)) && <Button variant="secondary" className="tech-visit-action" onClick={onDiscard} loading={discarding}>{handedOff ? 'Dismiss saved notice' : deviceSaveState === 'saved' ? 'Discard saved photo' : 'Discard selected photo'}</Button>}
      </div>}
    </div>
    {handedOff && <p role="status" className="tech-visit-muted">The photo remains attached to this visit. The office owns the remaining report updates. Dismiss removes only this saved notice from this device.</p>}
    {!handedOff && deviceSaveState === 'saved' && <p role="status" className="tech-visit-muted">Saved on this device for this visit. If the app closes, return to Retry or Discard.</p>}
    {deviceSaveState === 'unavailable' && <ActionFeedback error className="tech-visit-feedback">{unavailableRecoveryMessage(photo)}</ActionFeedback>}
  </>;
}

export default function TechServicePhotosModal({ serviceId, customerName, onClose }) {
  const fieldPortalClass = useFieldPortalClass();
  const isMobile = useIsMobile();
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [photoType, setPhotoType] = useState('after');
  const [caption, setCaption] = useState('');
  const [loadError, setLoadError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [visitSnapshot, setVisitSnapshot] = useState(null);
  const [visitReadReady, setVisitReadReady] = useState(false);
  const [deviceIdentity] = useState(createServicePhotoDeviceIdentity);
  const loadSequence = useRef(0);
  // Treated-point marking (GATE_PHOTO_MARKS, dark). The probe 404s when the
  // gate is off, which leaves marksSupported false and the affordance absent —
  // no separate client-side flag to keep in sync.
  const [marksSupported, setMarksSupported] = useState(false);
  const [markTarget, setMarkTarget] = useState(null);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      ensureCurrentDeviceIdentity(deviceIdentity.staffId);
      const data = await getServicePhotos(serviceId, deviceIdentity.token);
      if (sequence === loadSequence.current) {
        setPhotos(data.photos || []);
        setVisitSnapshot(data.visit || null);
        setVisitReadReady(true);
      }
    } catch (err) {
      if (sequence === loadSequence.current) {
        setVisitReadReady(false);
        setLoadError(err.message || 'Failed to load photos');
      }
    }
    if (sequence === loadSequence.current) setLoading(false);
  }, [deviceIdentity.staffId, deviceIdentity.token, serviceId]);

  useEffect(() => {
    setVisitReadReady(false);
    setVisitSnapshot(null);
  }, [serviceId]);
  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, [load]);

  const applyFreshPhotos = useCallback((data) => {
    setPhotos(data.photos || []);
    setVisitSnapshot(data.visit || null);
    setVisitReadReady(true);
  }, []);
  const uploadSucceeded = useCallback((data) => {
    setStatusMsg(data.photo?.staged
      ? 'Photo saved — it will attach when the visit is completed'
      : 'Photo uploaded');
    setCaption('');
  }, []);
  const uploadFailed = useCallback(() => setVisitReadReady(false), []);
  const {
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
    closeNeedsConfirmation,
  } = useServicePhotoRecovery({
    serviceId,
    deviceIdentity,
    visitSnapshot,
    visitReadReady,
    onFreshPhotos: applyFreshPhotos,
    onUploadFailed: uploadFailed,
    onUploaded: uploadSucceeded,
    refreshPhotos: load,
  });
  useEffect(() => {
    if (!restoredPending || !pendingPhoto) return;
    setPhotoType(pendingPhoto.photoType);
    setCaption(pendingPhoto.caption);
    setStatusMsg('');
  }, [pendingPhoto, restoredPending]);

  const close = () => {
    if (uploadInFlight.current) return;
    if (closeNeedsConfirmation
      && !window.confirm(closeConfirmationMessage(pendingPhoto))) return;
    onClose?.();
  };

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

  const handleFileSelected = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatusMsg('');
    selectPhoto(file, { photoType, caption });
  };

  useLockBodyScroll(true);
  const dialogRef = useModalFocus(true, close);
  const titleId = useId();
  const locked = [uploading, discarding, pendingPhoto, restoring].some(Boolean);
  const photoListLoading = [loading, restoring].some(Boolean);
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
            <Button className="tech-visit-action tech-visit-primary tech-visit-wide" onClick={handlePickFile} loading={uploading} disabled={locked || !visitReadReady}><Camera size={18} aria-hidden="true" /> Add Photo</Button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelected} disabled={locked || !visitReadReady} className="tech-visit-file-input" aria-label="Choose service photo" />
          </div>
          <PendingPhotoRecovery
            serviceId={serviceId}
            photo={pendingPhoto}
            uploading={uploading}
            deviceSaveState={deviceSaveState}
            restored={restoredPending}
            discarding={discarding}
            onRetry={retry}
            onDiscard={async () => {
              if (await discard()) {
                setCaption('');
                setPhotoType('after');
                setStatusMsg('');
              }
            }}
          />
          {errorMsg && <ActionFeedback error className="tech-visit-feedback">{errorMsg}</ActionFeedback>}
          {statusMsg && !errorMsg && <p role="status" className="tech-visit-muted">{statusMsg}</p>}
          <h3 className="tech-visit-section-title">Attached{!photoListLoading && !loadError ? ` (${photos.length})` : ''}</h3>
          {photoListLoading ? <ActionFeedback className="tech-visit-feedback">Loading…</ActionFeedback> : loadError ? <>
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
