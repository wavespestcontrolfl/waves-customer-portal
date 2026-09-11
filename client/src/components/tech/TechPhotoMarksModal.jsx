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
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { DVH } from '../../lib/viewportUnits';
// The SHARED palette (codex P1). A local copy made the comment below a lie:
// a correction to markColor would have updated the live card and the PDF and
// left the capture UI showing the technician different colours from the ones
// the customer sees.
import { markColor } from '../report/markedPhotoCopy';
import { UiSurface, Button, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const API = import.meta.env.VITE_API_URL || '';
const LONG_PRESS_MS = 500;

export default function TechPhotoMarksModal({ serviceId, photo, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const [kinds, setKinds] = useState([]);
  const [activeKind, setActiveKind] = useState(null);
  const [marks, setMarks] = useState([]);
  const [maxMarks, setMaxMarks] = useState(60);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // A broken <img> can keep a nonzero rect, so clicks would still normalize
  // against a frame the technician cannot see — persisting customer-facing
  // treatment coordinates blind. The live card and the PDF already fail closed
  // on this; the capture surface is the third of that trio (codex P2).
  const [imageFailed, setImageFailed] = useState(false);
  const imgRef = useRef(null);
  const pressRef = useRef(null);
  const removedRef = useRef(false);
  const dialogRef = useModalFocus(true, () => { if (!saving) onClose(); });
  useLockBodyScroll(true);

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
    // Swallow exactly one click after a long-press removal.
    if (removedRef.current) { removedRef.current = false; return; }
    if (!activeKind || imageFailed) return;
    const point = pointToNormalized(event);
    if (!point) return;
    setMarks((prev) => (prev.length >= maxMarks
      ? prev
      : [...prev, { x: point.x, y: point.y, kind: activeKind }]));
  }, [activeKind, maxMarks, pointToNormalized, imageFailed]);

  // Long-press a mark to remove it. Held on the mark itself so a stray press
  // on open photo area can never delete a point the tech placed.
  //
  // removedRef suppresses the click that follows the removal (codex P2): once
  // the timer deletes the mark, the pointer-up is hit-tested against the photo
  // container underneath, whose onClick would immediately add a NEW mark at
  // the same spot — so holding a pin to delete it silently replaced it, and
  // with whichever kind happened to be selected.
  const startPress = (index) => {
    clearTimeout(pressRef.current);
    pressRef.current = setTimeout(() => {
      removedRef.current = true;
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

  // DVH is 'dvh' where the engine supports it, 'vh' on pre-15.4 WebKit — see
  // lib/viewportUnits.js. Bridged in as a single CSS custom property so the
  // desktop height cap stays expressed in tech-workflow.css.
  return createPortal(
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay tech-visit-overlay--stacked', isMobile && 'tech-visit-overlay--fullscreen')}
      style={{ '--tech-vh': `1${DVH}` }}
      // This modal mounts INSIDE the photo manager's React tree (only the DOM
      // node is portaled), whose backdrop closes it on click. React bubbles
      // synthetic events along the component tree, not the real DOM, so
      // without stopping propagation here the very first tap — the one
      // placing a mark — would bubble out and unmount the whole workflow
      // before anything could be saved (codex P1). Stopped at the root so
      // every descendant is covered, including the photo and the chips.
      onClick={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Mark treated spots"
        className={cn('tech-visit-dialog', isMobile ? 'tech-visit-dialog--fullscreen' : 'tech-visit-dialog--marks-cap')}
      >
        <header className="tech-visit-header">
          <span className="tech-visit-title">Mark treated spots</span>
          <span className="tech-visit-muted">{marks.length} {marks.length === 1 ? 'mark' : 'marks'}</span>
        </header>
        <div className="tech-visit-body">
          {loading && <ActionFeedback className="tech-visit-feedback">Loading…</ActionFeedback>}

          {!loading && !kinds.length && (
            <p className="tech-visit-muted">This service does not use treated-point marks.</p>
          )}

          {!loading && kinds.length > 0 && (
            <>
              <div className="tech-visit-mark-frame" onClick={addMark}>
                <img
                  ref={imgRef}
                  src={photo?.url}
                  alt="Treated area"
                  onError={() => setImageFailed(true)}
                  className="tech-visit-mark-image"
                  draggable={false}
                />
                {marks.map((mark, i) => (
                  <div
                    key={`${mark.x}-${mark.y}-${i}`}
                    className="tech-visit-mark-pin"
                    style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
                    onPointerDown={(e) => { e.stopPropagation(); startPress(i); }}
                    onPointerUp={cancelPress}
                    onPointerLeave={cancelPress}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="tech-visit-mark-dot" />
                    {/* Same edge handling as the customer card (codex P2): the
                        frame clips overflow, so a mark near the top edge lost
                        its badge — and the tech saved it without ever seeing
                        the final pin. The dot stays on the exact point. */}
                    <span
                      className={cn('tech-visit-mark-badge', mark.y < 0.08 ? 'tech-visit-mark-badge--below' : 'tech-visit-mark-badge--above')}
                      style={{
                        background: markColor(mark.kind),
                        transform: `translateX(${mark.x < 0.04 ? '-10%' : (mark.x > 0.96 ? '-90%' : '-50%')})`,
                      }}
                    >
                      {i + 1}
                    </span>
                  </div>
                ))}
              </div>

              <div className="tech-visit-products" role="group" aria-label="Mark kind">
                {kinds.map((entry) => (
                  <Button
                    key={entry.kind}
                    variant="secondary"
                    className="tech-visit-action tech-visit-product"
                    aria-pressed={activeKind === entry.kind}
                    onClick={() => setActiveKind(entry.kind)}
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>

              {imageFailed && (
                <ActionFeedback error className="tech-visit-feedback">
                  This photo could not be loaded, so marks can&apos;t be placed on it.
                  Close and reopen to try again.
                </ActionFeedback>
              )}
              <p className="tech-visit-muted">
                Tap to add · hold a mark to remove
                {marks.length >= maxMarks ? ` · limit ${maxMarks} reached` : ''}
              </p>
            </>
          )}

          {errorMsg && <ActionFeedback error className="tech-visit-feedback">{errorMsg}</ActionFeedback>}
        </div>
        <footer className="tech-visit-footer">
          <div className="tech-visit-actions">
            {/* Skip carries equal visual weight: marks are optional, and a nag
                would contradict the ruling. */}
            <Button variant="secondary" className="tech-visit-action" onClick={onClose} disabled={saving}>Skip</Button>
            <Button
              className="tech-visit-action tech-visit-primary"
              onClick={save}
              loading={saving}
              disabled={saving || loading || !kinds.length || imageFailed}
            >
              Save marks
            </Button>
          </div>
        </footer>
      </section>
    </UiSurface>,
    document.body,
  );
}
