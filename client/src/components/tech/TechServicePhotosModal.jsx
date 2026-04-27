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
// Schema constraint: service_photos.service_record_id is NOT NULL.
// The completion route (POST /api/admin/dispatch/:serviceId/complete)
// must have run first. Server replies 409 with a clear message if
// not — surfaced inline here as "Complete the service first."
//
// PhotoType options come from VALID_PHOTO_TYPES in tech-track.js
// (before / after / issue / progress). Keep this set in sync if the
// server set ever changes — the UI lets users pick one before each
// upload so photos categorize correctly for the missed_photo
// detector / customer-track view downstream.
import { useCallback, useEffect, useRef, useState } from 'react';

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

export default function TechServicePhotosModal({ serviceId, customerName, onClose }) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [photoType, setPhotoType] = useState('after');
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const token = localStorage.getItem('adminToken');
      const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setPhotos(data.photos || []);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load photos');
    }
    setLoading(false);
  }, [serviceId]);

  useEffect(() => { load(); }, [load]);

  const handlePickFile = () => {
    if (uploading) return;
    setErrorMsg('');
    setStatusMsg('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const fd = new FormData();
      fd.append('photo', file);
      fd.append('photoType', photoType);
      if (caption.trim()) fd.append('caption', caption.trim());
      const token = localStorage.getItem('adminToken');
      const res = await fetch(`${API}/api/tech/services/${serviceId}/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // 409 = service not yet completed. Server message is already
        // user-friendly ("Service must be completed before attaching
        // photos") — surface verbatim so the tech knows what to do.
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatusMsg('Photo uploaded');
      setCaption('');
      await load();
    } catch (err) {
      setErrorMsg(err.message || 'Upload failed');
    }
    setUploading(false);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: DARK.bg, width: '100%', maxWidth: 480,
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: 16, maxHeight: '90vh', overflowY: 'auto',
          border: `1px solid ${DARK.border}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700, color: DARK.text,
            fontFamily: "'Montserrat', sans-serif",
          }}>
            Service Photos
          </h2>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: DARK.muted,
            fontSize: 24, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
          }}>×</button>
        </div>
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
                disabled={uploading}
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
            disabled={uploading}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${DARK.border}`, background: DARK.bg,
              color: DARK.text, fontSize: 13, marginBottom: 10, boxSizing: 'border-box',
            }}
          />
          <button
            onClick={handlePickFile}
            disabled={uploading}
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
            capture="environment"
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
        </div>

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
                  {p.photo_type}
                </div>
                {p.caption && (
                  <div style={{
                    padding: '4px 6px', fontSize: 11, color: DARK.muted,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {p.caption}
                  </div>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
