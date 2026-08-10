// client/src/components/tech/TechPhotoMarksModal.jsx
//
// Tech-side treated-point marking (GATE_PHOTO_MARKS, dark).
// Scope + rulings: docs/design/treatment-animation-scope.md.
//
// The tech photographs the area they actually treated, then taps the treated
// points on that photo. No map, no GPS, no alignment — the photo is the
// canvas, which is why this is a fraction of the treatment-zone tracer.
//
// Endpoints (tech-track.js):
//   GET /api/tech/services/:id/photo-marks  -> { supported, kinds, defaultKind, marksByS3Key }
//   PUT /api/tech/services/:id/photo-marks  -> { s3Key, marks: [{x,y,kind}] }
//
// Coordinates are normalized 0..1 against the displayed image, which is
// rendered at its natural aspect (width:100%, height:auto) so the element rect
// maps 1:1 onto the photo — no object-fit correction, and the same numbers the
// customer report positions pins with.
//
// Marks are OPTIONAL by owner ruling: "Skip" is a first-class action, not a
// nag, and saving an empty set is how a tech clears marks they previously
// placed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  red: '#ef4444',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

// Mirrors MarkedPhotoCard's palette so the tech sees what the customer will.
// Never alert red — a treated point is a record of work, not a warning.
const KIND_COLOR = {
  foam_injection: '#0A7EC2',
  spot_treatment: '#157A5B',
  wood_treatment: '#A9690C',
};
const DEFAULT_COLOR = '#0A7EC2';
const API = import.meta.env.VITE_API_URL || '';
const LONG_PRESS_MS = 500;

export default function TechPhotoMarksModal({ serviceId, photo, onClose, onSaved }) {
  const [kinds, setKinds] = useState([]);
  const [activeKind, setActiveKind] = useState(null);
  const [marks, setMarks] = useState([]);
  const [maxMarks, setMaxMarks] = useState(60);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const imgRef = useRef(null);
  const pressRef = useRef(null);

  const authHeaders = () => {
    const token = getAdminAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg('');
      try {
        const res = await fetch(`${API}/api/tech/services/${serviceId}/photo-marks`, {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error('Could not load marks');
        const data = await res.json();
        if (cancelled) return;
        setKinds(data.kinds || []);
        setActiveKind(data.defaultKind || (data.kinds?.[0]?.kind ?? null));
        setMaxMarks(data.maxMarks || 60);
        const existing = (data.marksByS3Key || {})[photo?.s3_key] || [];
        setMarks(existing.map((m) => ({ x: Number(m.x), y: Number(m.y), kind: m.kind })));
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message || 'Could not load marks');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [serviceId, photo?.s3_key]);

  // Normalized position of a pointer event within the photo.
  const pointToNormalized = useCallback((event) => {
    const el = imgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, []);

  const addMark = useCallback((event) => {
    if (!activeKind) return;
    const point = pointToNormalized(event);
    if (!point) return;
    setMarks((prev) => (prev.length >= maxMarks
      ? prev
      : [...prev, { x: point.x, y: point.y, kind: activeKind }]));
  }, [activeKind, maxMarks, pointToNormalized]);

  // Long-press a mark to remove it. Held on the mark itself so a stray press
  // on open photo area can never delete a point the tech placed.
  const startPress = (index) => {
    clearTimeout(pressRef.current);
    pressRef.current = setTimeout(() => {
      setMarks((prev) => prev.filter((_, i) => i !== index));
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => clearTimeout(pressRef.current);
  useEffect(() => () => clearTimeout(pressRef.current), []);

  const save = async () => {
    setSaving(true);
    setErrorMsg('');
    try {
      const res = await fetch(`${API}/api/tech/services/${serviceId}/photo-marks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ s3Key: photo?.s3_key, marks }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save marks');
      if (onSaved) onSaved(data.marks || []);
      onClose();
    } catch (err) {
      setErrorMsg(err.message || 'Could not save marks');
    } finally {
      setSaving(false);
    }
  };

  const chipStyle = (on) => ({
    fontSize: 13, padding: '7px 11px', borderRadius: 999,
    border: `1px solid ${on ? DARK.teal : DARK.border}`,
    background: on ? DARK.teal : DARK.card,
    color: on ? '#04222f' : DARK.text,
    cursor: 'pointer', fontWeight: on ? 600 : 500,
  });

  return (
    <div
      // This modal mounts INSIDE the photo manager, whose backdrop closes it
      // on click. Without stopping propagation here the very first tap — the
      // one placing a mark — would bubble out and unmount the whole workflow
      // before anything could be saved (codex P1). Stopped at the root so
      // every descendant is covered, including the photo and the chips.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(4,10,16,.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Mark treated spots"
    >
      <div style={{
        background: DARK.bg, border: `1px solid ${DARK.border}`, borderRadius: 14,
        padding: 14, width: '100%', maxWidth: 420, maxHeight: '92vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 11 }}>
          <span style={{ color: DARK.text, fontWeight: 650, fontSize: 15 }}>Mark treated spots</span>
          <span style={{ color: DARK.muted, fontSize: 12 }}>
            {marks.length} {marks.length === 1 ? 'mark' : 'marks'}
          </span>
        </div>

        {loading && <p style={{ color: DARK.muted, fontSize: 13 }}>Loading…</p>}

        {!loading && !kinds.length && (
          <p style={{ color: DARK.muted, fontSize: 13 }}>
            This service does not use treated-point marks.
          </p>
        )}

        {!loading && kinds.length > 0 && (
          <>
            <div
              style={{ position: 'relative', borderRadius: 9, overflow: 'hidden', lineHeight: 0 }}
              onClick={addMark}
            >
              <img
                ref={imgRef}
                src={photo?.url}
                alt="Treated area"
                style={{ width: '100%', display: 'block', touchAction: 'manipulation' }}
                draggable={false}
              />
              {marks.map((mark, i) => (
                <div
                  key={`${mark.x}-${mark.y}-${i}`}
                  onPointerDown={(e) => { e.stopPropagation(); startPress(i); }}
                  onPointerUp={cancelPress}
                  onPointerLeave={cancelPress}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    left: `${mark.x * 100}%`,
                    top: `${mark.y * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{
                    position: 'absolute', left: '50%', top: '50%',
                    width: 7, height: 7, margin: '-3.5px 0 0 -3.5px',
                    borderRadius: '50%', background: '#fff',
                    boxShadow: '0 0 0 2px rgba(8,20,28,.55)',
                  }}
                  />
                  <span style={{
                    position: 'absolute', left: '50%', bottom: 13,
                    transform: 'translateX(-50%)',
                    minWidth: 25, height: 25, padding: '0 6px', borderRadius: 999,
                    border: '2px solid rgba(255,255,255,.94)',
                    background: KIND_COLOR[mark.kind] || DEFAULT_COLOR,
                    color: '#fff', fontSize: 12, fontWeight: 600, lineHeight: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 2px 7px rgba(6,16,24,.5)',
                  }}
                  >
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
              {kinds.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  onClick={() => setActiveKind(entry.kind)}
                  style={chipStyle(activeKind === entry.kind)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <p style={{ color: DARK.muted, fontSize: 12, marginTop: 10 }}>
              Tap to add · hold a mark to remove
              {marks.length >= maxMarks ? ` · limit ${maxMarks} reached` : ''}
            </p>
          </>
        )}

        {errorMsg && (
          <p style={{ color: DARK.red, fontSize: 13, marginTop: 10 }}>{errorMsg}</p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {/* Skip carries equal visual weight: marks are optional, and a nag
              would contradict the ruling. */}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              flex: 1, padding: 10, borderRadius: 8, fontSize: 13.5, fontWeight: 600,
              border: `1px solid ${DARK.border}`, background: 'transparent',
              color: DARK.text, cursor: 'pointer',
            }}
          >
            Skip
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading || !kinds.length}
            style={{
              flex: 1, padding: 10, borderRadius: 8, fontSize: 13.5, fontWeight: 600,
              border: `1px solid ${DARK.teal}`, background: DARK.teal,
              color: '#04222f', cursor: saving ? 'wait' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save marks'}
          </button>
        </div>
      </div>
    </div>
  );
}
