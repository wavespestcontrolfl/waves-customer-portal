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
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { DVH } from '../../lib/viewportUnits';
import TechPhotoMarksModal from './TechPhotoMarksModal';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  red: '#ef4444',
  green: '#22c55e',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

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
    setErrorMsg('');
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
      if (sequence === loadSequence.current) setErrorMsg(err.message || 'Failed to load photos');
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

  return createPortal(
    <div
      onClick={close}
      style={{
        position: 'fixed', inset: 0, fontFamily: "'DM Sans', sans-serif", background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: DARK.bg, width: '100%', maxWidth: isMobile ? 'none' : 480,
          borderTopLeftRadius: isMobile ? 0 : 16, borderTopRightRadius: isMobile ? 0 : 16,
          boxSizing: 'border-box', height: isMobile ? '100%' : undefined, maxHeight: isMobile ? '100%' : `90${DVH}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
          paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
          border: `1px solid ${DARK.border}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexShrink: 0 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700, color: DARK.text,
            fontFamily: "'Montserrat', sans-serif",
          }}>
            Service Photos
          </h2>
          <button type="button" aria-label="Close service photos" onClick={close} disabled={uploading} style={{
            background: 'transparent', border: 'none', color: DARK.muted,
            fontSize: 24, cursor: 'pointer', padding: '0 4px', lineHeight: 1, minWidth: 44, minHeight: 44,
          }}>×</button>
        </div>
        <div style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {customerName && (
          <p style={{ margin: '0 0 14px', fontSize: 13, color: DARK.muted }}>{customerName}</p>
        )}

        {/* Upload controls */}
        <div style={{
          background: DARK.card, border: `1px solid ${DARK.border}`,
          borderRadius: 10, padding: 12, marginBottom: 14,
        }}>
          <label style={{ display: 'block', fontSize: 11, color: DARK.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Type
          </label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {PHOTO_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setPhotoType(t)}
                disabled={uploading || !!pendingPhoto}
                style={{
                  padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                  border: `1px solid ${photoType === t ? DARK.teal : DARK.border}`,
                  background: photoType === t ? `${DARK.teal}22` : 'transparent',
                  color: photoType === t ? DARK.teal : DARK.text,
                  cursor: uploading ? 'wait' : 'pointer', textTransform: 'capitalize',
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <label style={{ display: 'block', fontSize: 11, color: DARK.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Caption (optional)
          </label>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="e.g., Front yard before treatment"
            disabled={uploading || !!pendingPhoto}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${DARK.border}`, background: DARK.bg,
              color: DARK.text, fontSize: 13, marginBottom: 10, boxSizing: 'border-box',
            }}
          />
          <button
            onClick={handlePickFile}
            disabled={uploading || !!pendingPhoto}
            style={{
              width: '100%', padding: '10px', borderRadius: 8,
              border: 'none', background: uploading ? DARK.border : DARK.teal,
              color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: uploading ? 'wait' : 'pointer',
            }}
          >
            {uploading ? 'Uploading…' : '📷 Add Photo'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
        </div>

        {pendingPhoto && <div role="status" style={{ color: DARK.text, marginBottom: 12 }}>
          <p>{uploading ? 'Uploading photo…' : 'Photo not uploaded. Keep this visit open to retry.'}</p>
          <p>{pendingPhoto.file.name}</p>
          {!uploading && <>
            <button type="button" onClick={() => uploadPhoto(pendingPhoto)}>Retry upload</button>{' '}
            <button type="button" onClick={() => { setPendingPhoto(null); setErrorMsg(''); }}>Discard selected photo</button>
          </>}
        </div>}

        {errorMsg && (
          <div style={{
            background: `${DARK.red}22`, border: `1px solid ${DARK.red}`, color: DARK.red,
            padding: '8px 10px', borderRadius: 6, fontSize: 13, marginBottom: 12,
          }}>
            {errorMsg}
          </div>
        )}
        {statusMsg && !errorMsg && (
          <div style={{
            background: `${DARK.green}22`, border: `1px solid ${DARK.green}`, color: DARK.green,
            padding: '8px 10px', borderRadius: 6, fontSize: 13, marginBottom: 12,
          }}>
            {statusMsg}
          </div>
        )}

        {/* Existing photos */}
        <h3 style={{
          margin: '0 0 8px', fontSize: 12, color: DARK.muted, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 1,
        }}>
          Attached ({photos.length})
        </h3>
        {loading ? (
          <p style={{ color: DARK.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>
            Loading…
          </p>
        ) : photos.length === 0 ? (
          <p style={{ color: DARK.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>
            No photos yet.
          </p>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          }}>
            {photos.map((p) => (
              <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"
                style={{
                  position: 'relative', display: 'block',
                  background: DARK.card, border: `1px solid ${DARK.border}`,
                  borderRadius: 8, overflow: 'hidden', textDecoration: 'none',
                }}>
                <img src={p.url} alt={p.caption || p.photo_type}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                <div style={{
                  position: 'absolute', top: 4, left: 4,
                  background: 'rgba(0,0,0,0.65)', color: '#fff',
                  fontSize: 10, fontWeight: 700, padding: '2px 6px',
                  borderRadius: 4, textTransform: 'capitalize',
                }}>
                  {p.photo_type}{p.staged ? ' · staged' : ''}
                </div>
                {p.caption && (
                  <div style={{
                    padding: '4px 6px', fontSize: 11, color: DARK.muted,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {p.caption}
                  </div>
                )}
                {/* Treated-point marking (GATE_PHOTO_MARKS). Only offered on
                    lanes that support marks — markLanes is empty otherwise, so
                    this affordance is absent rather than disabled.
                    'before' photos are excluded: they document the state
                    BEFORE treatment, so marks on one would publish a
                    pre-treatment image as the treated area (codex P1). The
                    PUT route rejects them too — this only saves the tech a
                    pointless round trip. */}
                {marksSupported && MARKABLE_PHOTO_TYPES.has(p.photo_type) && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setMarkTarget(p); }}
                    style={{
                      position: 'absolute', right: 4, bottom: 4,
                      background: 'rgba(0,0,0,0.72)', color: '#fff',
                      border: `1px solid ${DARK.border}`, borderRadius: 6,
                      fontSize: 10.5, fontWeight: 600, padding: '4px 8px', cursor: 'pointer',
                    }}
                  >
                    Mark spots
                  </button>
                )}
              </a>
            ))}
          </div>
        )}
        </div>
      </div>
      {markTarget && (
        <TechPhotoMarksModal
          serviceId={serviceId}
          photo={markTarget}
          onClose={() => setMarkTarget(null)}
        />
      )}
    </div>,
    document.body
  );
}
