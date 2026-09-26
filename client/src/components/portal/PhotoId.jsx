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

// v2 result card (GATE_PHOTO_ID_V2, server side) — rendered only when the
// response carries a `data.v2` object (see V2-CONTRACT.md). Every string a
// customer sees below is either payload text verbatim (headline, subhead,
// verdict_label, safety_line, evidence, candidate names, referral text,
// next_photo ask/why, entry facts) or one of these two fixed tier labels —
// never composed species facts.
const V2_TIER_LABEL = {
  ai_suggestion: 'AI suggestion',
  needs_more_evidence: 'Needs more evidence',
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

// tone: 'default' | 'alert' | 'accent' plus the four v2 verdict tones —
// ally/harmless/watch/call are deliberately calm and distinct from one
// another; `call` ("Worth a pro look") is NOT alarm-red (that's `alert`,
// reserved for the pest-result safety chips above).
function Chip({ children, tone = 'default' }) {
  const toneColor = tone === 'alert' ? B.red
    : tone === 'accent' ? B.glassNavy
    : tone === 'ally' ? B.green
    : tone === 'harmless' ? B.teal
    : tone === 'watch' ? B.orange
    : tone === 'call' ? B.glassNavy
    : SHELL.text;
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
  const [resultData, setResultData] = useState(null); // { id, type, created_at, result, next_step, photos? }
  // 'live' (just identified, note/location are this session's own inputs) or
  // 'history' (opened from a past item — GET returns saved photo references,
  // but not the original note/location inputs).
  const [resultSource, setResultSource] = useState(null);
  const [unavailableHistoryPhotoIds, setUnavailableHistoryPhotoIds] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistoryId, setLoadingHistoryId] = useState(null);
  // Set by the v2 result's "Take the photo that settles it" button
  // (handleRetakePhoto below) — { ask, full } shown as a banner on the
  // photos step. `full` means the 3-photo limit was already reached, so the
  // banner asks the customer to remove one before the retake photo fits.
  const [retakeBanner, setRetakeBanner] = useState(null);

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
      setUnavailableHistoryPhotoIds([]);
      setHistoryError('');
      setLoadingHistoryId(null);
      setRetakeBanner(null);
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
    setUnavailableHistoryPhotoIds([]);
    setRetakeBanner(null);
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
    setUnavailableHistoryPhotoIds([]);
    // Clear this session's live photos before the history GET starts so a
    // later "Request service" tap can never attach a DIFFERENT
    // identification's pictures to this one. History evidence comes only
    // from the response's signed photo references.
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

  // v2 "Take the photo that settles it" (V2Result's NextPhotoCard). Returns
  // to the photos step, KEEPING the live photos already on the sheet — for
  // a live result those are this session's own uploads; for a history-
  // opened result `photos` is already [] (cleared in openHistoryItem), so
  // the retake starts empty rather than resurrecting the saved photos.
  // Respects the existing 3-photo limit: at the limit, the banner tells the
  // customer to remove one first instead of silently doing nothing.
  //
  // A history-sourced retake also clears note/location: openHistoryItem
  // never touches them, so a note typed on an EARLIER, unrelated photos-step
  // visit (picker -> photos -> Back -> a history item) would otherwise still
  // be sitting in state and ride along into this new submission (Codex
  // round-0 P1). A live retake is the same identification's own note, so it
  // stays.
  const handleRetakePhoto = (nextPhoto) => {
    setSubmitError('');
    if (resultSource === 'history') {
      setNote('');
      setLocation('');
    }
    setRetakeBanner({ ask: nextPhoto?.ask || '', full: photos.length >= PHOTO_LIMIT });
    setStep('photos');
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
    const historyPhotos = isLive
      ? []
      : (Array.isArray(resultData?.photos) ? resultData.photos : [])
        .filter((photo) => photo?.id)
        .slice(0, PHOTO_LIMIT)
        .map((photo, index) => ({
          preview: unavailableHistoryPhotoIds.includes(photo.id) ? null : photo.url,
          photoId: photo.id,
          name: `Photo ID photo ${index + 1}`,
        }));
    onOpenRequest?.({
      category: prefill.category || (isLive ? (TYPE_TO_CATEGORY[selectedType] || '') : ''),
      location: prefill.location || (isLive ? location : ''),
      note: prefill.note || (isLive ? note : ''),
      // Live captures retain their base64 data. History photos carry only
      // their server-owned id and signed preview URL; the request endpoint
      // validates those ids and copies the private bytes itself.
      photos: isLive ? photos : historyPhotos,
      photoIdSource: {
        type: resultData?.type || selectedType,
        id: resultData?.id,
      },
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
            retakeBanner={retakeBanner}
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
            photos={resultSource === 'history'
              ? (Array.isArray(resultData.photos) ? resultData.photos : [])
              : photos.map((photo) => ({ url: photo.preview }))}
            unavailablePhotoIds={resultSource === 'history' ? unavailableHistoryPhotoIds : []}
            onPhotoUnavailable={resultSource === 'history'
              ? (photoId) => setUnavailableHistoryPhotoIds((current) => (
                current.includes(photoId) ? current : [...current, photoId]
              ))
              : undefined}
            onOpenRequestCta={handleNextStepRequest}
            onDone={onClose}
            onRetakePhoto={handleRetakePhoto}
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

function PhotosStep({ type, photos, busyPhotos, note, location, submitError, retakeBanner, fileInputRef, onAddFiles, onCameraTap, onRemovePhoto, onNoteChange, onLocationChange, onSubmit }) {
  const remaining = PHOTO_LIMIT - photos.length;
  const canSubmit = photos.length > 0 && !busyPhotos;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {retakeBanner && (
        <div data-glass="soft" role="status" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {retakeBanner.ask && <div style={{ fontSize: 15, fontWeight: 700, color: SHELL.text, lineHeight: 1.4 }}>{retakeBanner.ask}</div>}
          {retakeBanner.full && (
            <div style={{ fontSize: 14, color: SHELL.muted, lineHeight: 1.4 }}>
              You're at the 3-photo limit — remove one below to add this one.
            </div>
          )}
        </div>
      )}
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
      {/* v2 referral (bee relocation / wildlife trapper / report to FWC or
          FDACS / protected-leave-alone): title + body are the server's own
          fixed template text — this is a routing note, never a request. */}
      {kind === 'referral' && (
        <button type="button" onClick={onDone} style={{
          minHeight: 44, borderRadius: 8, border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface,
          color: SHELL.text, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONTS.body,
        }}>
          Done
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
          <MetricTile label="Overall" value={`${result.scores.overall}/100`} />
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

function ResultPhotos({ photos, unavailablePhotoIds, onPhotoUnavailable }) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return <div role="status" style={{ fontSize: 14, color: SHELL.muted }}>Original photos are unavailable. Add a new photo to your request.</div>;
  }
  const unavailable = new Set(unavailablePhotoIds || []);
  const available = photos.filter((photo) => photo?.url && !unavailable.has(photo.id));
  const unavailableCount = photos.length - available.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {available.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {available.map((photo, index) => (
            <img
              key={photo.id || `${photo.url}-${index}`}
              src={photo.url}
              alt={`Saved photo ${index + 1}`}
              onError={() => { if (photo.id) onPhotoUnavailable?.(photo.id); }}
              style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, border: `1px solid ${SHELL.border}` }}
            />
          ))}
        </div>
      )}
      {unavailableCount > 0 && (
        <div role="status" style={{ fontSize: 14, color: SHELL.muted, lineHeight: 1.45 }}>
          {unavailableCount === 1
            ? 'One saved photo could not be loaded.'
            : `${unavailableCount} saved photos could not be loaded.`}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// v2 result card (server-decided; every string below is payload text) —
// see V2-CONTRACT.md for the response shape.
// =========================================================================

// Waves' own site — the only origin an entry's "Read more" link may point
// at. `entry.site_url` is server data, not a trusted internal link, so it's
// validated before ever reaching an href (Codex-style boundary discipline:
// a same-origin check, not a blind render).
const V2_SITE_URL_PREFIX = 'https://www.wavespestcontrol.com/';

function EvidenceList({ title, icon, items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {title}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((text, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 15, color: SHELL.body, lineHeight: 1.45 }}>
            <Icon name={icon} size={16} strokeWidth={2} style={{ color: SHELL.muted, flexShrink: 0, marginTop: 3 }} />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceSection({ evidence }) {
  const matches = evidence?.matches;
  const stillNeed = evidence?.still_need;
  const hasMatches = Array.isArray(matches) && matches.length > 0;
  const hasStillNeed = Array.isArray(stillNeed) && stillNeed.length > 0;
  if (!hasMatches && !hasStillNeed) return null;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {hasMatches && <EvidenceList title="What matches" icon="check" items={matches} />}
      {hasStillNeed && <EvidenceList title="What we still need to see" icon="eye" items={stillNeed} />}
    </section>
  );
}

// "Take the photo that settles it" — the one decisive next photo the engine
// asks for. Tapping the button hands next_photo back up to the sheet, which
// returns to the photos step with `ask` shown as a banner (PhotoIdSheet's
// handleRetakePhoto).
function NextPhotoCard({ nextPhoto, onRetakePhoto }) {
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: SHELL.text }}>Take the photo that settles it</div>
      {nextPhoto.ask && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.5 }}>{nextPhoto.ask}</div>}
      {nextPhoto.why && <div style={{ fontSize: 14, color: SHELL.muted, lineHeight: 1.45 }}>{nextPhoto.why}</div>}
      <button type="button" data-glass-accent="" onClick={() => onRetakePhoto?.(nextPhoto)} style={{
        minHeight: 48, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: FONTS.body,
      }}>
        Take this photo
      </button>
    </section>
  );
}

function CandidatesSection({ candidates }) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  const others = candidates.slice(1);
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Other possibilities
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {others.map((c, i) => (
          <div key={c.slug || i} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            paddingBottom: i < others.length - 1 ? 10 : 0,
            borderBottom: i < others.length - 1 ? `1px solid ${SHELL.border}` : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: SHELL.text }}>{c.common_name}</span>
              <Chip>{c.strength === 'strong' ? 'Strong match' : 'Possible match'}</Chip>
              {c.local === 'common_here_now' && <Chip tone="ally">Common here now</Chip>}
              {c.local === 'uncommon_here' && <Chip>Uncommon here</Chip>}
            </div>
            {c.difference_from_top && (
              <div style={{ fontSize: 14, color: SHELL.muted, lineHeight: 1.4 }}>{c.difference_from_top}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// "About {common_name}" — collapsed by default (name-to-action detail, not
// the headline answer). `site_url` is only ever rendered when it points at
// Waves' own site — see V2_SITE_URL_PREFIX.
function AboutEntrySection({ entry }) {
  const [open, setOpen] = useState(false);
  if (!entry) return null;
  const siteUrl = typeof entry.site_url === 'string' && entry.site_url.startsWith(V2_SITE_URL_PREFIX)
    ? entry.site_url
    : null;
  const hasBody = entry.what_it_means || entry.fact || (Array.isArray(entry.look_alikes) && entry.look_alikes.length > 0) || siteUrl;
  if (!hasBody) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{
        width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 0', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONTS.body,
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: SHELL.text }}>About {entry.common_name}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} strokeWidth={2} style={{ color: SHELL.muted, flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0 6px' }}>
          {entry.what_it_means && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.55 }}>{entry.what_it_means}</div>}
          {entry.fact && <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.55 }}>{entry.fact}</div>}
          {Array.isArray(entry.look_alikes) && entry.look_alikes.length > 0 && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                Commonly confused with
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entry.look_alikes.map((la, i) => (
                  <div key={la.slug || i} style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.45 }}>
                    <span style={{ fontWeight: 700, color: SHELL.text }}>{la.common_name}</span>
                    {la.difference ? ` — ${la.difference}` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
          {siteUrl && (
            <a href={siteUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 15, fontWeight: 700, color: B.glassNavy, textDecoration: 'underline' }}>
              Read more on our website
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Order (V2-CONTRACT.md "Client"): headline + subhead -> tier line ->
// customer's photos -> verdict chip + safety line -> About (name-to-action
// detail) -> what matches / what we still need to see -> the next-photo
// card -> other possibilities -> referral text. The next-step block sits
// outside this component (ResultStep renders it either way).
function V2Result({ v2, photos, unavailablePhotoIds, onPhotoUnavailable, onRetakePhoto }) {
  const answer = v2.answer || {};
  const entry = v2.entry || null;
  const tierLabel = V2_TIER_LABEL[v2.tier] || null;

  return (
    <>
      <section data-glass="card" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          {answer.headline && <div style={{ fontSize: 20, fontWeight: 700, color: SHELL.text, lineHeight: 1.25 }}>{answer.headline}</div>}
          {answer.subhead && <div style={{ fontSize: 15, fontStyle: 'italic', color: SHELL.muted, marginTop: 2 }}>{answer.subhead}</div>}
        </div>
        {tierLabel && (
          <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{tierLabel}</div>
        )}
        <ResultPhotos photos={photos} unavailablePhotoIds={unavailablePhotoIds} onPhotoUnavailable={onPhotoUnavailable} />
        {entry && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entry.verdict_label && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Chip tone={entry.verdict}>{entry.verdict_label}</Chip>
              </div>
            )}
            {entry.safety_line && (
              <div style={{ fontSize: 15, color: B.red, fontWeight: 700, lineHeight: 1.45 }}>{entry.safety_line}</div>
            )}
            <AboutEntrySection entry={entry} />
          </div>
        )}
      </section>

      <EvidenceSection evidence={v2.evidence} />

      {v2.next_photo && <NextPhotoCard nextPhoto={v2.next_photo} onRetakePhoto={onRetakePhoto} />}

      <CandidatesSection candidates={v2.candidates} />

      {v2.referral?.text && (
        <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16 }}>
          <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.5 }}>{v2.referral.text}</div>
        </section>
      )}
    </>
  );
}

function ResultStep({ data, photos, unavailablePhotoIds, onPhotoUnavailable, onOpenRequestCta, onDone, onRetakePhoto }) {
  const result = data.result || {};
  const ResultBody = RESULT_BODY_BY_TYPE[data.type];
  const v2 = data.v2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {v2 ? (
        <V2Result
          v2={v2}
          photos={photos}
          unavailablePhotoIds={unavailablePhotoIds}
          onPhotoUnavailable={onPhotoUnavailable}
          onRetakePhoto={onRetakePhoto}
        />
      ) : (
        <section data-glass="card" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ResultPhotos photos={photos} unavailablePhotoIds={unavailablePhotoIds} onPhotoUnavailable={onPhotoUnavailable} />
          {ResultBody && <ResultBody result={result} />}
        </section>
      )}

      <NextStepBlock nextStep={data.next_step} onOpenRequestCta={onOpenRequestCta} onDone={onDone} />
    </div>
  );
}
