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
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { DVH } from '../../lib/viewportUnits';
import TechPhotoMarksModal from './TechPhotoMarksModal';
import { UiSurface, Button, Field, Input, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const API = import.meta.env.VITE_API_URL || '';
const PHOTO_TYPES = ['before', 'after', 'progress', 'issue'];
// Mirrors MARKABLE_PHOTO_TYPES in tech-track.js. 'before' is definitionally
// pre-treatment, so it can never carry treated-point marks.
const MARKABLE_PHOTO_TYPES = new Set(['after', 'progress', 'issue']);

export default function TechServicePhotosModal({ serviceId, customerName, onClose }) {
  const isMobile = useIsMobile();
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [photoType, setPhotoType] = useState('after');
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadError, setLoadError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const uploadInFlight = useRef(false);
  const loadSequence = useRef(0);
  // Treated-point marking (GATE_PHOTO_MARKS, dark). The probe 404s when the
  // gate is off, which leaves marksSupported false and the affordance absent —
  // no separate client-side flag to keep in sync.
  const [marksSupported, setMarksSupported] = useState(false);
  const [markTarget, setMarkTarget] = useState(null);
  const fileInputRef = useRef(null);

  const close = () => {
    if (uploadInFlight.current) return;
    if (pendingPhoto && !window.confirm('This photo has not uploaded. Close and discard the selected photo?')) return;
    onClose?.();
  };
  useEffect(() => {
    if (!pendingPhoto) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingPhoto]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const token = getAdminAuthToken();
      const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (sequence === loadSequence.current) setPhotos(data.photos || []);
    } catch (err) {
      if (sequence === loadSequence.current) setLoadError(err.message || 'Failed to load photos');
    }
    if (sequence === loadSequence.current) setLoading(false);
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
    if (uploadInFlight.current || pendingPhoto) return;
    setErrorMsg('');
    setStatusMsg('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const uploadPhoto = async (photo) => {
    if (!photo || uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const fd = new FormData();
      fd.append('photo', photo.file);
      fd.append('photoType', photo.photoType);
      fd.append('capturedAt', photo.capturedAt);
      if (photo.caption) fd.append('caption', photo.caption);
      const token = getAdminAuthToken();
      const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatusMsg(data.photo?.staged
        ? 'Photo saved — it will attach when the visit is completed'
        : 'Photo uploaded');
      setPendingPhoto(null);
      setCaption('');
      void load();
    } catch (err) {
      setErrorMsg(err.message || 'Upload failed');
    }
    uploadInFlight.current = false;
    setUploading(false);
  };

  const handleFileSelected = (event) => {
    const file = event.target.files?.[0];
    if (!file || uploadInFlight.current || pendingPhoto) return;
    const photo = { file, photoType, caption: caption.trim(), capturedAt: new Date(file.lastModified || Date.now()).toISOString() };
    setPendingPhoto(photo);
    void uploadPhoto(photo);
  };

  useLockBodyScroll(true);
  const dialogRef = useModalFocus(true, close);
  const titleId = useId();
  const locked = uploading || !!pendingPhoto;
  // DVH is 'dvh' where the engine supports it, 'vh' on pre-15.4 WebKit — see
  // lib/viewportUnits.js. Bridged in as a single CSS custom property so the
  // desktop height cap stays expressed in tech-workflow.css rather than an
  // inline layout object.
  return createPortal(
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay', isMobile && 'tech-visit-overlay--fullscreen')}
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
            <Button className="tech-visit-action tech-visit-primary tech-visit-wide" onClick={handlePickFile} loading={uploading} disabled={!!pendingPhoto}>📷 Add Photo</Button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelected} className="tech-visit-file-input" aria-label="Choose service photo" />
          </div>
          {pendingPhoto && <div className="tech-visit-card">
            <ActionFeedback className="tech-visit-feedback">{uploading ? 'Uploading photo…' : 'Photo not uploaded. Keep this visit open to retry.'}</ActionFeedback>
            <p className="tech-visit-muted">{pendingPhoto.file.name}</p>
            {!uploading && <div className="tech-visit-actions">
              <Button className="tech-visit-action tech-visit-primary" onClick={() => uploadPhoto(pendingPhoto)}>Retry upload</Button>
              <Button variant="secondary" className="tech-visit-action" onClick={() => { setPendingPhoto(null); setErrorMsg(''); }}>Discard selected photo</Button>
            </div>}
          </div>}
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
