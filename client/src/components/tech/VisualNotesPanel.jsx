import { useRef, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  green: '#22c55e',
  red: '#ef4444',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const QUICK_TAGS = [
  { tagCode: 'bugs_seen', label: 'Bugs Seen' },
  { tagCode: 'weeds', label: 'Weeds' },
  { tagCode: 'moisture_issue', label: 'Moisture Issue' },
  { tagCode: 'treatment_applied', label: 'Treatment Applied' },
  { tagCode: 'access_issue', label: 'Access Issue' },
  { tagCode: 'recommendation', label: 'Recommendation' },
  { tagCode: 'before', label: 'Before' },
  { tagCode: 'after', label: 'After' },
  { tagCode: 'no_major_activity', label: 'No Major Activity' },
];

const LOCATION_AREAS = [
  'Front Yard',
  'Backyard',
  'Left Side',
  'Right Side',
  'Garage Side',
  'Driveway Edge',
  'Lanai',
  'Perimeter',
  'Interior',
  'Other',
];

function getCurrentGps() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || {});
    };
    const timer = window.setTimeout(() => done({}), 1400);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        window.clearTimeout(timer);
        done({
          gpsLatitude: pos.coords.latitude,
          gpsLongitude: pos.coords.longitude,
        });
      },
      () => {
        window.clearTimeout(timer);
        done({});
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 1200 },
    );
  });
}

export default function VisualNotesPanel({ service }) {
  const [selectedTag, setSelectedTag] = useState(null);
  const [locationArea, setLocationArea] = useState('');
  const [note, setNote] = useState('');
  const [media, setMedia] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const photoInputRef = useRef(null);
  const videoInputRef = useRef(null);

  const resetForm = () => {
    setSelectedTag(null);
    setLocationArea('');
    setNote('');
    setMedia(null);
  };

  const saveMoment = async () => {
    if (!selectedTag || !service?.id || saving) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const gps = await getCurrentGps();
      const fd = new FormData();
      fd.append('tagCode', selectedTag.tagCode);
      if (locationArea) fd.append('locationArea', locationArea);
      if (note.trim()) fd.append('note', note.trim());
      if (gps.gpsLatitude != null) fd.append('gpsLatitude', String(gps.gpsLatitude));
      if (gps.gpsLongitude != null) fd.append('gpsLongitude', String(gps.gpsLongitude));
      if (media) fd.append('media', media);
      const res = await fetch(`${API}/api/jobs/${service.id}/visual-moments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessage(data.message || 'Visual note saved.');
      resetForm();
      window.setTimeout(() => setMessage((current) => current === 'Visual note saved.' ? '' : current), 3500);
    } catch (err) {
      setError(err.message || 'Could not save visual note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${DARK.border}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 10,
        marginBottom: 8,
      }}>
        <div>
          <div style={{
            fontSize: 13,
            fontWeight: 800,
            color: DARK.text,
            fontFamily: "'Montserrat', sans-serif",
          }}>
            Visual Notes
          </div>
          <div style={{ fontSize: 11, color: DARK.muted, marginTop: 2 }}>
            Optional proof moments for this service.
          </div>
        </div>
      </div>

      {!selectedTag ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {QUICK_TAGS.map((tag) => (
            <button
              key={tag.tagCode}
              type="button"
              onClick={() => {
                setSelectedTag(tag);
                setMessage('');
                setError('');
              }}
              style={{
                minHeight: 38,
                borderRadius: 8,
                border: `1px solid ${DARK.border}`,
                background: DARK.bg,
                color: DARK.text,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                padding: '8px 10px',
              }}
            >
              {tag.label}
            </button>
          ))}
        </div>
      ) : (
        <div style={{
          background: DARK.bg,
          border: `1px solid ${DARK.border}`,
          borderRadius: 10,
          padding: 12,
        }}>
          <div style={{ fontSize: 12, color: DARK.muted, marginBottom: 8 }}>
            Selected: <span style={{ color: DARK.text, fontWeight: 700 }}>{selectedTag.label}</span>
          </div>
          <label style={{ display: 'block', fontSize: 11, color: DARK.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Location area
          </label>
          <select
            value={locationArea}
            onChange={(e) => setLocationArea(e.target.value)}
            disabled={saving}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '9px 10px',
              borderRadius: 6,
              border: `1px solid ${DARK.border}`,
              background: DARK.card,
              color: DARK.text,
              fontSize: 13,
              marginBottom: 10,
            }}
          >
            <option value="">Select area...</option>
            {LOCATION_AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
          </select>
          <label style={{ display: 'block', fontSize: 11, color: DARK.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            Note
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
            rows={3}
            placeholder="Optional note"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '9px 10px',
              borderRadius: 6,
              border: `1px solid ${DARK.border}`,
              background: DARK.card,
              color: DARK.text,
              fontSize: 13,
              resize: 'vertical',
              marginBottom: 10,
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={saving}
              style={{
                flex: 1,
                minHeight: 38,
                borderRadius: 8,
                border: `1px solid ${DARK.border}`,
                background: DARK.card,
                color: DARK.text,
                fontSize: 12,
                fontWeight: 700,
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              Add photo
            </button>
            <button
              type="button"
              onClick={() => videoInputRef.current?.click()}
              disabled={saving}
              style={{
                flex: 1,
                minHeight: 38,
                borderRadius: 8,
                border: `1px solid ${DARK.border}`,
                background: DARK.card,
                color: DARK.text,
                fontSize: 12,
                fontWeight: 700,
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              Add short clip
            </button>
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => setMedia(e.target.files?.[0] || null)}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => setMedia(e.target.files?.[0] || null)}
          />
          {media && (
            <div style={{ fontSize: 11, color: DARK.muted, marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {media.name}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={saveMoment}
              disabled={saving}
              style={{
                flex: 1,
                minHeight: 40,
                border: 'none',
                borderRadius: 8,
                background: saving ? DARK.border : DARK.teal,
                color: '#fff',
                fontSize: 13,
                fontWeight: 800,
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              {saving ? 'Saving...' : 'Save moment'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              disabled={saving}
              style={{
                minHeight: 40,
                border: `1px solid ${DARK.border}`,
                borderRadius: 8,
                background: 'transparent',
                color: DARK.muted,
                fontSize: 13,
                fontWeight: 700,
                padding: '0 14px',
                cursor: saving ? 'wait' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(message || error) && (
        <div style={{
          marginTop: 10,
          fontSize: 12,
          padding: '7px 10px',
          borderRadius: 6,
          background: error ? `${DARK.red}22` : `${DARK.green}22`,
          border: `1px solid ${error ? DARK.red : DARK.green}`,
          color: error ? DARK.red : DARK.green,
        }}>
          {error || message}
        </div>
      )}
    </div>
  );
}
