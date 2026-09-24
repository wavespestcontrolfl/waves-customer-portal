import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import Icon from '../Icon';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useModalFocus from '../../hooks/useModalFocus';
import { captureCameraPhoto } from '../../native/camera';
import { formatETDateTime } from '../../lib/timezone';

// =========================================================================
// Photo ID — customer-facing photo identifier (GATE_CUSTOMER_PHOTO_ID).
//
// A customer photographs a bug, a lawn spot, or a tree/shrub issue and gets
// an instant identification + a server-decided next step (book a covered
// re-service, file a request, ask for an inspection, or a plain
// reassurance). The server owns every fact in the result — this file only
// lays it out. See the API contract in the PR description / task brief.
//
// Three pieces:
//   usePhotoIdGate()  — one GET /api/photo-id at mount. 404 means the
//                       feature is dark for this account: both the floating
//                       button and the More-sheet row must disappear
//                       entirely, so this hook is the single source of
//                       truth both entry points read.
//   PhotoIdFab        — the floating "Photo ID" pill (bottom-right, above
//                       the bottom nav on the mobile shell).
//   PhotoIdSheet      — the whole flow: pick a type -> add photos -> "your
//                       photo id" analyzing state -> result card -> history.
//
// PortalPage owns the open/closed boolean and the gate hook so the FAB and
// the More-sheet row can never disagree about whether the feature is live.
// =========================================================================

export const PHOTO_ID_TYPES = [
  { value: 'pest', label: 'Bug or pest', icon: 'bug', description: 'Something crawling, flying, or nesting.' },
  { value: 'lawn', label: 'Lawn spot', icon: 'leaf', description: 'Brown patches, thinning, or discoloration.' },
  { value: 'tree_shrub', label: 'Tree or shrub', icon: 'tree', description: 'Leaves, branches, or plant health.' },
];

// Same options the New Request form offers for "Where on the property" —
// kept in step with ReportIssueOverlay's locationOptions in PortalPage.jsx
// (not exported there, so mirrored here; both feed the same server field).
export const PHOTO_ID_LOCATION_OPTIONS = [
  { value: 'front_yard', label: 'Front Yard' },
  { value: 'back_yard', label: 'Back Yard' },
  { value: 'side_yard', label: 'Side Yard' },
  { value: 'inside_home', label: 'Inside Home' },
  { value: 'garage_lanai', label: 'Garage / Lanai' },
  { value: 'garden_beds', label: 'Garden Beds' },
  { value: 'other', label: 'Other' },
];

const PHOTO_LIMIT = 3;
const NOTE_LIMIT = 500;
const NETWORK_ERROR_MESSAGE = "Couldn't reach Waves. Try again.";

const CONFIDENCE_LABEL = { low: 'Unsure', moderate: 'Likely', high: 'High' };

// Not server copy — these are ours, written to explain the raw urgency enum
// the server returns. Never used in place of next_step.title/body.
const URGENCY_COPY = {
  low: 'No rush — keep an eye on it.',
  moderate: 'Worth mentioning at your next visit.',
  high: "We'd suggest having this looked at soon.",
};

const SAFETY_LABELS = {
  stinging: 'Stings',
  venomous: 'Venomous',
  disease_vector: 'Can carry disease',
  structural_threat: 'Structural risk',
};

const NEXT_STEP_CTA_LABEL = {
  reservice: 'Book free re-service',
  request: 'Request service',
  inspection: 'Request service',
  unclear: 'Send to the team',
};

// Fallback category for a LIVE result's request handoff when the server
// omits request_prefill.category (request_prefill is optional on every
// kind) — matches ReportIssueOverlay's fixed category enum. tree_shrub has
// no matching category there, so it's left unmapped (blank / customer
// picks) rather than mis-categorizing.
const TYPE_TO_CATEGORY = { pest: 'pest_issue', lawn: 'lawn_concern' };

function levelWord(level) {
  const s = String(level || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

function errorMessageFor(err, fallback) {
  if (!err) return fallback;
  // request() in utils/api.js stamps .status from the response; a plain
  // fetch rejection (offline, DNS, CORS) has none — that's the network case.
  if (err.status === 429 || err.status === 400) return err.message || fallback;
  if (typeof err.status !== 'number') return NETWORK_ERROR_MESSAGE;
  return err.message || fallback;
}

// ---- shared photo pipeline (mirrors the public-funnel client contract:
// downscale to <=1600px JPEG before upload — see PhotoAssessmentsPage.jsx /
// TechLawnDiagnosticPage.jsx) --------------------------------------------

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
function mimeFromName(name) {
  return EXT_MIME[String(name || '').split('.').pop().toLowerCase()] || null;
}

// Mirror the server's photo rules HERE too (request-photo-validation.js:
// jpeg/png/webp/heic + 5MB decoded) — same list ReportIssueOverlay's own
// picker uses. The file input accepts any `image/*`, and resizeImage's
// "already small enough" shortcut passes an untouched original straight
// through when its dimensions are under the resize threshold, so without
// this a GIF/SVG or an oversized-but-small-dimension file would reach the
// API unchanged and only fail once the customer taps Identify.
const PHOTO_TYPE_RE = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      let dataUrl = String(ev.target.result || '');
      // Some browsers report an empty type for HEIC/HEIF — rebuild the data
      // URL's mime prefix from the extension so it isn't sent as data:;base64.
      if (dataUrl.startsWith('data:;base64,')) {
        const mime = file.type || mimeFromName(file.name);
        if (!mime) { resolve(null); return; }
        dataUrl = `data:${mime};base64,${dataUrl.slice('data:;base64,'.length)}`;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Downscale to <=1600px JPEG. Falls through with the original data URL on
// decode failure (e.g. HEIC in a browser that can't paint it to a canvas) so
// capture never hard-fails — the server re-validates the mime either way.
function resizeImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) { resolve(dataUrl); return; }
      const scale = maxEdge / longEdge;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// =========================================================================
// Gate hook — single GET /api/photo-id, shared by the FAB and the More sheet.
//
// `sessionKey` should be something that changes whenever the authorized
// account does — PortalPage passes its `sessionEpoch` from useAuth (already
// bumped on login, refresh-family rotation, AND a saved-property switch,
// since a property can belong to a different customerId). PortalPage itself
// never remounts on those changes, so without this the gate would otherwise
// keep serving the PREVIOUS account's availability/history (Codex r5 P1).
//
// `enabled` (default true) skips the read entirely — PortalPage passes
// `!cancelledAccount`: `/api/photo-id` isn't one of the reads a cancelled
// customer's restricted session is allowed, so asking anyway would just
// 401 and burn a refresh-retry on every mount for a feature that's already
// hidden for that account (Codex r7 P2).
// =========================================================================
export function usePhotoIdGate(sessionKey, enabled = true) {
  // 'loading' | 'available' | 'unavailable'
  const [status, setStatus] = useState(enabled ? 'loading' : 'unavailable');
  const [items, setItems] = useState([]);
  // Bumped every time sessionKey/enabled changes so a response still in
  // flight from the PREVIOUS account/session — including one kicked off by
  // an external refresh() call — is discarded instead of being applied here.
  const genRef = useRef(0);
  const prevKeyRef = useRef(sessionKey);
  const prevEnabledRef = useRef(enabled);

  // Reset SYNCHRONOUSLY during render, not only in the effect below, so the
  // very next paint already shows the new session's closed/loading state.
  // An effect-only reset commits AFTER paint, so the keyed portal subtree
  // could paint the PREVIOUS account's availability/history for one frame
  // before the effect clears it — the gate must read closed the instant
  // sessionKey changes, not after the refetch resolves (Codex r7 P1). This
  // is React's documented "adjust state during render" pattern: guarded by
  // the ref comparison so it runs at most once per actual change.
  if (prevKeyRef.current !== sessionKey || prevEnabledRef.current !== enabled) {
    prevKeyRef.current = sessionKey;
    prevEnabledRef.current = enabled;
    genRef.current += 1;
    setStatus(enabled ? 'loading' : 'unavailable');
    setItems([]);
  }

  const refresh = useCallback(() => {
    const myGen = genRef.current;
    return api.getPhotoIds()
      .then((d) => {
        if (genRef.current !== myGen) return;
        setItems(Array.isArray(d?.items) ? d.items : []);
        setStatus('available');
      })
      .catch((err) => {
        if (genRef.current !== myGen) return;
        if (err?.status === 404) {
          setStatus('unavailable');
          setItems([]);
          return;
        }
        // Fail closed (feature flags never fail open): a network hiccup or
        // 5xx on the FIRST read is not evidence the account has access, so
        // it stays hidden same as a 404. Once a read has actually proven
        // 'available' this session, a later background-refresh blip doesn't
        // retract it — that would flicker a working feature off.
        setStatus((prev) => (prev === 'available' ? prev : 'unavailable'));
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [refresh, sessionKey, enabled]);

  return { status, items, refresh };
}

// =========================================================================
// Floating button
// =========================================================================
export function PhotoIdFab({ onOpen, hasBottomNav }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Photo ID — identify a bug, lawn spot, tree or shrub"
      data-glass-accent=""
      style={{
        position: 'fixed',
        right: 14,
        bottom: hasBottomNav ? 82 : 20,
        zIndex: 97,
        minHeight: 48,
        padding: '0 18px 0 14px',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        border: 'none',
        cursor: 'pointer',
        fontFamily: FONTS.body,
        fontSize: 15,
        fontWeight: 700,
        boxShadow: '0 12px 30px rgba(15,23,42,0.24)',
      }}
    >
      <Icon name="camera" size={19} strokeWidth={2.25} />
      Photo ID
    </button>
  );
}

// =========================================================================
// Small shared bits
// =========================================================================
function CloseButton({ onClick, label = 'Close' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} style={{
      width: 40, height: 40, minWidth: 44, minHeight: 44, borderRadius: 999,
      border: `1px solid ${SHELL.border}`, background: SHELL.surface, color: SHELL.text,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      flexShrink: 0,
    }}>
      <Icon name="x" size={18} strokeWidth={2} />
    </button>
  );
}

function BackButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} aria-label="Back" style={{
      width: 40, height: 40, minWidth: 44, minHeight: 44, borderRadius: 999,
      border: `1px solid ${SHELL.border}`, background: SHELL.surface, color: SHELL.text,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      flexShrink: 0, transform: 'rotate(180deg)',
    }}>
      <Icon name="chevronRight" size={18} strokeWidth={2} />
    </button>
  );
}

function Chip({ children, tone = 'default' }) {
  const toneColor = tone === 'alert' ? B.red : tone === 'accent' ? B.glassNavy : SHELL.text;
  return (
    <span data-glass="chip" style={{
      display: 'inline-flex', alignItems: 'center', padding: '5px 12px', borderRadius: 999,
      fontSize: 14, fontWeight: 700, color: toneColor,
    }}>{children}</span>
  );
}

// =========================================================================
// The sheet: picker -> photos -> analyzing -> result, + history.
// =========================================================================
export function PhotoIdSheet({ open, onClose, items = [], onRefreshHistory, onOpenRequest, onGateUnavailable }) {
  useLockBodyScroll(open);
  const dialogRef = useModalFocus(open, onClose);
  const fileInputRef = useRef(null);

  const [step, setStep] = useState('picker'); // picker | photos | analyzing | result
  const [selectedType, setSelectedType] = useState(null);
  const [photos, setPhotos] = useState([]); // [{ preview, data, name }]
  const [busyPhotos, setBusyPhotos] = useState(false);
  const [note, setNote] = useState('');
  const [location, setLocation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [resultData, setResultData] = useState(null); // { id, type, created_at, result, next_step }
  // 'live' (just identified, note/location are this session's own inputs) or
  // 'history' (opened from a past item — GET never returns photos/note/
  // location, so there is nothing of the customer's to fall back to).
  const [resultSource, setResultSource] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistoryId, setLoadingHistoryId] = useState(null);

  // Every async op (photo add, identify, history load) captures the current
  // generation and checks it again before touching state. Closing the sheet
  // — or starting a newer op — bumps it, so a slow response from an
  // abandoned flow can never overwrite what the customer is looking at now
  // (Codex r1 P1).
  const genRef = useRef(0);

  // Reset the whole flow whenever the sheet is closed, so reopening it
  // (from the FAB or the More sheet) always starts at the type picker.
  useEffect(() => {
    if (!open) {
      genRef.current += 1;
      setStep('picker');
      setSelectedType(null);
      setPhotos([]);
      setNote('');
      setLocation('');
      setSubmitError('');
      setSubmitting(false);
      setBusyPhotos(false);
      setResultData(null);
      setResultSource(null);
      setHistoryError('');
      setLoadingHistoryId(null);
    }
  }, [open]);

  if (!open) return null;

  const pickType = (value) => {
    genRef.current += 1;
    setSelectedType(value);
    setPhotos([]);
    // Bumping genRef alone leaves a mid-flight photo read/resize's own
    // `finally` unable to clear this (its generation no longer matches) —
    // reset it here so Add/Identify don't stay stuck disabled after
    // switching type mid-capture (Codex r2 P1).
    setBusyPhotos(false);
    setNote('');
    setLocation('');
    setSubmitError('');
    setStep('photos');
  };

  const addFiles = async (fileList) => {
    const remaining = PHOTO_LIMIT - photos.length;
    if (remaining <= 0) return;
    const all = Array.from(fileList || []);
    if (!all.length) return;
    // Filter BEFORE processing — an empty file.type (some browsers on HEIC)
    // is accepted only when the extension resolves to a recognized mime, so
    // fileToDataUrl can still rebuild the data URL's mime prefix.
    const usable = all
      .filter((f) => (f.type ? PHOTO_TYPE_RE.test(f.type) : !!mimeFromName(f.name)) && f.size <= MAX_PHOTO_BYTES)
      .slice(0, remaining);
    const rejectedCount = all.length - usable.length;
    setSubmitError(rejectedCount > 0
      ? `${rejectedCount === 1 ? 'One photo was' : `${rejectedCount} photos were`} skipped — photos must be JPG, PNG, WebP, or HEIC and under 5 MB each.`
      : '');
    if (!usable.length) return;
    const myGen = genRef.current;
    setBusyPhotos(true);
    try {
      const added = [];
      for (const file of usable) {
        const original = await fileToDataUrl(file);
        if (!original) continue;
        const resized = await resizeImage(original, 1600, 0.85);
        added.push({ preview: resized, data: resized, name: file.name });
      }
      if (genRef.current !== myGen) return; // sheet closed / type changed mid-read
      setPhotos((prev) => [...prev, ...added].slice(0, PHOTO_LIMIT));
    } finally {
      if (genRef.current === myGen) setBusyPhotos(false);
    }
  };

  const handleCameraTap = async () => {
    if (photos.length >= PHOTO_LIMIT) return;
    const myGen = genRef.current;
    setBusyPhotos(true);
    try {
      const result = await captureCameraPhoto();
      if (genRef.current !== myGen) return; // sheet closed / type changed mid-capture
      if (result.photo) {
        const resized = await resizeImage(result.photo.data, 1600, 0.85);
        if (genRef.current !== myGen) return;
        setPhotos((prev) => [...prev, { preview: resized, data: resized, name: result.photo.name }].slice(0, PHOTO_LIMIT));
      } else if (result.unavailable) {
        fileInputRef.current?.click();
      }
    } finally {
      if (genRef.current === myGen) setBusyPhotos(false);
    }
  };

  const removePhoto = (idx) => setPhotos((prev) => prev.filter((_, i) => i !== idx));

  const handleIdentify = async () => {
    if (!photos.length || submitting || busyPhotos) return;
    const myGen = genRef.current;
    setSubmitting(true);
    setSubmitError('');
    setStep('analyzing');
    try {
      const payload = { photos: photos.map((p) => p.data) };
      if (note.trim()) payload.note = note.trim().slice(0, NOTE_LIMIT);
      if (location) payload.location = location;
      const result = await api.createPhotoId(selectedType, payload);
      if (genRef.current !== myGen) return; // sheet closed / reset mid-request
      setResultData(result);
      setResultSource('live');
      setStep('result');
      // Best-effort: the history list refreshing in the background must
      // never turn a successful identify into a failure screen.
      try { onRefreshHistory?.(); } catch { /* ignore */ }
    } catch (err) {
      if (genRef.current !== myGen) return;
      setStep('photos');
      if (err?.status === 404) {
        onGateUnavailable?.();
        onClose();
        return;
      }
      setSubmitError(errorMessageFor(err, 'Could not identify this photo. Please try again.'));
    } finally {
      if (genRef.current === myGen) setSubmitting(false);
    }
  };

  const openHistoryItem = async (item) => {
    genRef.current += 1;
    const myGen = genRef.current;
    setHistoryError('');
    setLoadingHistoryId(item.id);
    // A history item's photos were never returned by GET (contract has no
    // photo data) — clear the live flow's photos so a later "Request
    // service" tap can't attach a DIFFERENT identification's pictures to
    // this one (Codex r1 P1).
    setPhotos([]);
    try {
      const result = await api.getPhotoId(item.type, item.id);
      if (genRef.current !== myGen) return; // sheet closed / another item opened meanwhile
      setResultData(result);
      setResultSource('history');
      setSelectedType(item.type);
      setStep('result');
    } catch (err) {
      if (genRef.current !== myGen) return;
      if (err?.status === 404) {
        onGateUnavailable?.();
        onClose();
        return;
      }
      setHistoryError(errorMessageFor(err, 'Could not load this report.'));
    } finally {
      if (genRef.current === myGen) setLoadingHistoryId(null);
    }
  };

  const handleNextStepRequest = () => {
    const nextStep = resultData?.next_step;
    const prefill = nextStep?.request_prefill || {};
    // request_prefill is optional on every kind — for a LIVE result (this
    // session's own identify) missing it, fall back to what the customer
    // already typed on the photos step rather than blanking the New Request
    // form out from under them. A HISTORY result has none of that to fall
    // back to (GET never returns it), so it stays limited to whatever the
    // server actually sent (Codex r7 P2).
    const isLive = resultSource === 'live';
    onOpenRequest?.({
      category: prefill.category || (isLive ? (TYPE_TO_CATEGORY[selectedType] || '') : ''),
      location: prefill.location || (isLive ? location : ''),
      note: prefill.note || (isLive ? note : ''),
      // Same shape as ReportIssueOverlay's own `photos` state ({ preview,
      // data, name }) — the New Request form seeds it directly, so the
      // customer never has to re-attach what they just took. Already empty
      // for a history result (openHistoryItem clears it on open).
      photos,
    });
  };

  const title = step === 'picker' ? 'What are you looking at?'
    : step === 'analyzing' ? 'Analyzing'
    : step === 'result' ? 'Your Photo ID'
    : PHOTO_ID_TYPES.find((t) => t.value === selectedType)?.label || 'Add photos';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-glass-scrim=""
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(15,23,42,0.42)',
        backdropFilter: 'blur(5px)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
    >
      <style>{`
        @keyframes photoIdSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes photoIdSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          [data-photo-id-sheet] { animation: none !important; }
          [data-photo-id-spinner] { animation: none !important; }
        }
      `}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Photo ID"
        data-photo-id-sheet=""
        data-glass="modal"
        style={{
          background: SHELL.page,
          borderRadius: '8px 8px 0 0',
          position: 'relative',
          padding: '12px 16px max(18px, env(safe-area-inset-bottom))',
          boxShadow: '0 -8px 40px rgba(15,23,42,0.18)',
          animation: 'photoIdSheetUp 0.25s ease',
          borderTop: `1px solid ${SHELL.border}`,
          maxHeight: 'calc(100dvh - 16px)',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          fontFamily: FONTS.body,
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 999, background: '#D8D0C0', margin: '0 auto 12px' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          {step !== 'picker' && step !== 'analyzing' && (
            <BackButton onClick={() => {
              if (step === 'photos') { setStep('picker'); setSubmitError(''); }
              else if (step === 'result') { setStep('picker'); setResultData(null); }
            }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: SHELL.text, lineHeight: 1.2 }}>{title}</div>
          </div>
          <CloseButton onClick={onClose} label="Close Photo ID" />
        </div>

        {step === 'picker' && (
          <PickerStep items={items} historyError={historyError} loadingHistoryId={loadingHistoryId}
            onPick={pickType} onOpenHistoryItem={openHistoryItem} onClose={onClose} />
        )}

        {step === 'photos' && (
          <PhotosStep
            type={selectedType}
            photos={photos}
            busyPhotos={busyPhotos}
            note={note}
            location={location}
            submitError={submitError}
            fileInputRef={fileInputRef}
            onAddFiles={addFiles}
            onCameraTap={handleCameraTap}
            onRemovePhoto={removePhoto}
            onNoteChange={setNote}
            onLocationChange={setLocation}
            onSubmit={handleIdentify}
          />
        )}

        {step === 'analyzing' && <AnalyzingStep />}

        {step === 'result' && resultData && (
          <ResultStep
            data={resultData}
            onOpenRequestCta={handleNextStepRequest}
            onDone={onClose}
          />
        )}
      </div>
    </div>
  );
}

function PickerStep({ items, historyError, loadingHistoryId, onPick, onOpenHistoryItem, onClose }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section data-glass="soft" style={{
        borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 8,
      }}>
        {PHOTO_ID_TYPES.map((t) => (
          <button key={t.value} type="button" onClick={() => onPick(t.value)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 10px', minHeight: 48, border: 'none', background: 'transparent',
            borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: FONTS.body,
          }}>
            <span style={{
              width: 38, height: 38, borderRadius: 8, background: SHELL.soft, color: SHELL.text,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Icon name={t.icon} size={18} strokeWidth={2} />
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 700, color: SHELL.text }}>{t.label}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 15, color: SHELL.muted, lineHeight: 1.35 }}>{t.description}</span>
            </span>
            <Icon name="chevronRight" size={17} strokeWidth={2} style={{ color: SHELL.muted }} />
          </button>
        ))}
      </section>

      <div style={{ fontSize: 15, color: SHELL.muted, lineHeight: 1.5, padding: '0 2px' }}>
        Covered problems go straight to a free re-service. Nothing is sent until you tap.
      </div>

      <button type="button" data-glass="chip" onClick={onClose} style={{
        alignSelf: 'flex-start', border: 'none', cursor: 'pointer', minHeight: 44,
        padding: '9px 16px', borderRadius: 999, fontSize: 15, fontWeight: 700, color: SHELL.text,
        fontFamily: FONTS.body,
      }}>
        Not now
      </button>

      <section style={{ marginTop: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          My Photo IDs
        </div>
        {historyError && (
          <div role="alert" style={{ fontSize: 15, color: B.red, marginBottom: 8 }}>{historyError}</div>
        )}
        {items.length === 0 ? (
          <div style={{ fontSize: 15, color: SHELL.muted }}>Nothing identified yet.</div>
        ) : (
          <div data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 4 }}>
            {items.map((item) => {
              const typeInfo = PHOTO_ID_TYPES.find((t) => t.value === item.type);
              const loading = loadingHistoryId === item.id;
              return (
                <button key={item.id} type="button" disabled={loading}
                  onClick={() => onOpenHistoryItem(item)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 8px', minHeight: 48, border: 'none', background: 'transparent',
                    borderRadius: 8, cursor: loading ? 'default' : 'pointer', textAlign: 'left',
                    opacity: loading ? 0.6 : 1, fontFamily: FONTS.body,
                  }}>
                  <span style={{
                    width: 32, height: 32, borderRadius: 8, background: SHELL.surface, color: SHELL.text,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Icon name={typeInfo?.icon || 'camera'} size={16} strokeWidth={2} />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: SHELL.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.headline || typeInfo?.label || 'Photo ID'}
                    </span>
                    <span style={{ display: 'block', marginTop: 2, fontSize: 14, color: SHELL.muted }}>
                      {formatETDateTime(item.created_at, { month: 'short', day: 'numeric' })}
                    </span>
                  </span>
                  <Icon name="chevronRight" size={16} strokeWidth={2} style={{ color: SHELL.muted }} />
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function PhotosStep({ type, photos, busyPhotos, note, location, submitError, fileInputRef, onAddFiles, onCameraTap, onRemovePhoto, onNoteChange, onLocationChange, onSubmit }) {
  const remaining = PHOTO_LIMIT - photos.length;
  const canSubmit = photos.length > 0 && !busyPhotos;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => { onAddFiles(e.target.files); e.target.value = ''; }}
        style={{ display: 'none' }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {photos.map((p, idx) => (
          <div key={idx} style={{ position: 'relative', width: 84, height: 84, borderRadius: 8, overflow: 'hidden', border: `1px solid ${SHELL.border}` }}>
            <img src={p.preview} alt={`Photo ${idx + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <button type="button" onClick={() => onRemovePhoto(idx)} aria-label={`Remove photo ${idx + 1}`} style={{
              position: 'absolute', top: 3, right: 3, width: 24, height: 24, minWidth: 24, minHeight: 24,
              borderRadius: 999, border: 'none', background: 'rgba(15,23,42,0.65)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}>
              <Icon name="x" size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        {remaining > 0 && (
          <button type="button" onClick={onCameraTap} disabled={busyPhotos} aria-label="Add a photo" style={{
            width: 84, height: 84, borderRadius: 8, border: `1px dashed ${SHELL.borderStrong}`,
            background: SHELL.soft, color: SHELL.text, display: 'inline-flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 4, cursor: busyPhotos ? 'default' : 'pointer',
            opacity: busyPhotos ? 0.6 : 1,
          }}>
            <Icon name="camera" size={20} strokeWidth={2} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>{busyPhotos ? 'Adding…' : 'Add'}</span>
          </button>
        )}
      </div>
      <div style={{ fontSize: 14, color: SHELL.muted }}>Up to {PHOTO_LIMIT} photos. {remaining} remaining.</div>

      <label style={{ display: 'block' }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: SHELL.text, marginBottom: 6 }}>Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value.slice(0, NOTE_LIMIT))}
          placeholder="Anything else worth mentioning?"
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8,
            border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface, color: SHELL.text,
            fontSize: 15, fontFamily: FONTS.body, resize: 'vertical', minHeight: 44,
          }}
        />
      </label>

      <label style={{ display: 'block' }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: SHELL.text, marginBottom: 6 }}>Where on the property (optional)</span>
        <select
          value={location}
          onChange={(e) => onLocationChange(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 12px', borderRadius: 8,
            border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface, color: SHELL.text,
            fontSize: 15, fontFamily: FONTS.body,
          }}
        >
          <option value="">Not sure</option>
          {PHOTO_ID_LOCATION_OPTIONS.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </label>

      {submitError && <div role="alert" style={{ fontSize: 15, color: B.red }}>{submitError}</div>}

      <button type="button" data-glass-accent="" onClick={onSubmit} disabled={!canSubmit} style={{
        minHeight: 48, borderRadius: 8, border: 'none', fontSize: 16, fontWeight: 700,
        cursor: canSubmit ? 'pointer' : 'not-allowed', fontFamily: FONTS.body,
      }}>
        Identify
      </button>
    </div>
  );
}

function AnalyzingStep() {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '32px 8px' }}>
      <div data-photo-id-spinner="" style={{
        width: 40, height: 40, borderRadius: '50%',
        border: `4px solid ${SHELL.border}`, borderTopColor: B.yellow,
        animation: 'photoIdSpin 0.9s linear infinite',
      }} />
      <div style={{ fontSize: 16, fontWeight: 700, color: SHELL.text, textAlign: 'center' }}>
        Comparing against our Florida library…
      </div>
    </div>
  );
}

function MetricTile({ label, value }) {
  return (
    <div data-glass="chip" style={{ flex: 1, minWidth: 92, padding: '10px 12px', borderRadius: 8, textAlign: 'center' }}>
      <div data-gt="metric" style={{ fontSize: 22, fontWeight: 700, color: SHELL.text }}>{value}</div>
      <div style={{ fontSize: 14, color: SHELL.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SignalRow({ label, level }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${SHELL.border}`, fontSize: 15 }}>
      <span style={{ color: SHELL.text }}>{label}</span>
      <span style={{ color: SHELL.muted, fontWeight: 700 }}>{levelWord(level)}</span>
    </div>
  );
}

function NextStepBlock({ nextStep, onOpenRequestCta, onDone }) {
  if (!nextStep) return null;
  const kind = nextStep.kind;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {nextStep.title && <div style={{ fontSize: 17, fontWeight: 700, color: SHELL.text }}>{nextStep.title}</div>}
      {nextStep.body && <div style={{ fontSize: 15, color: SHELL.muted, lineHeight: 1.5 }}>{nextStep.body}</div>}
      {kind === 'reservice' && nextStep.url && (
        <a href={nextStep.url} data-glass-accent="" style={{
          minHeight: 48, borderRadius: 8, textDecoration: 'none', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, fontFamily: FONTS.body,
        }}>
          {NEXT_STEP_CTA_LABEL.reservice}
        </a>
      )}
      {(kind === 'request' || kind === 'inspection' || kind === 'unclear') && (
        <button type="button" data-glass-accent="" onClick={onOpenRequestCta} style={{
          minHeight: 48, borderRadius: 8, border: 'none', cursor: 'pointer',
          fontSize: 16, fontWeight: 700, fontFamily: FONTS.body,
        }}>
          {NEXT_STEP_CTA_LABEL[kind]}
        </button>
      )}
      {kind === 'none' && (
        <button type="button" onClick={onDone} style={{
          minHeight: 44, borderRadius: 8, border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface,
          color: SHELL.text, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONTS.body,
        }}>
          Got it
        </button>
      )}
    </section>
  );
}

function PestResult({ result }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: SHELL.text }}>{result.label}</div>
        {result.confidence && <Chip>{CONFIDENCE_LABEL[result.confidence] || result.confidence}</Chip>}
      </div>
      {result.safety && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(SAFETY_LABELS).map(([key, label]) => (
            result.safety[key] ? <Chip key={key} tone="alert">{label}</Chip> : null
          ))}
        </div>
      )}
      {result.about && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.55 }}>{result.about}</div>}
      {result.urgency && (
        <div style={{ fontSize: 15, color: SHELL.muted, fontWeight: 700 }}>{URGENCY_COPY[result.urgency] || levelWord(result.urgency)}</div>
      )}
    </>
  );
}

function LawnResult({ result }) {
  return (
    <>
      {result.grass_type && <div style={{ fontSize: 20, fontWeight: 700, color: SHELL.text }}>{result.grass_type}</div>}
      {result.scores && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <MetricTile label="Density" value={`${result.scores.turf_density}%`} />
          <MetricTile label="Weeds" value={`${result.scores.weed_coverage}%`} />
          <MetricTile label="Color" value={`${result.scores.color_health}/10`} />
        </div>
      )}
      {Array.isArray(result.signals) && result.signals.length > 0 && (
        <div>{result.signals.map((s) => <SignalRow key={s.key} label={s.label} level={s.level} />)}</div>
      )}
      {result.observations && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.55 }}>{result.observations}</div>}
    </>
  );
}

function TreeShrubResult({ result }) {
  return (
    <>
      {Array.isArray(result.plant_groups) && result.plant_groups.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {result.plant_groups.map((g, i) => <Chip key={i}>{g.label}</Chip>)}
        </div>
      )}
      {result.scores && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <MetricTile label="Foliage" value={`${result.scores.foliage_fullness}%`} />
          <MetricTile label="Color" value={`${result.scores.leaf_color_vigor}%`} />
          <MetricTile label="Overall" value={`${result.scores.overall}/10`} />
        </div>
      )}
      {Array.isArray(result.signals) && result.signals.length > 0 && (
        <div>{result.signals.map((s) => <SignalRow key={s.key} label={s.label} level={s.level} />)}</div>
      )}
      {result.summary && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.55 }}>{result.summary}</div>}
    </>
  );
}

const RESULT_BODY_BY_TYPE = { pest: PestResult, lawn: LawnResult, tree_shrub: TreeShrubResult };

function ResultStep({ data, onOpenRequestCta, onDone }) {
  const result = data.result || {};
  const ResultBody = RESULT_BODY_BY_TYPE[data.type];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section data-glass="card" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {ResultBody && <ResultBody result={result} />}
      </section>

      <NextStepBlock nextStep={data.next_step} onOpenRequestCta={onOpenRequestCta} onDone={onDone} />
    </div>
  );
}
