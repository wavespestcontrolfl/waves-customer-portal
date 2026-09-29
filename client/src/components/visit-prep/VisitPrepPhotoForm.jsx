/**
 * "Anything you want your technician to look at?" — the customer photo +
 * note form for a specific upcoming visit (customer-visit-photos-scope-
 * 20260928.md §4/§5.5, server foundation `server/services/visit-prep.js` /
 * `POST /:token/photos`, `docs/public-route-contracts.md`).
 *
 * Transport-agnostic on purpose: the caller supplies `onSubmit(formData)`,
 * which does the actual POST (today: the public tokened appointment-page
 * route with no auth; PR 4 reuses this same component from the app's
 * authenticated "Add photos for this visit" sheet with a different
 * onSubmit). This file owns only the form itself — note, camera/library pickers,
 * send, and the success/error/gone states — never an outer card/sheet
 * chrome, so either caller can wrap it in its own container.
 *
 * Not built on ReportIssueOverlay's or PhotoId's photo pickers (both encode
 * files as base64 data URLs for an authenticated JSON API): this route is
 * multipart/form-data and unauthenticated, a different enough transport
 * that lifting either picker would mean threading a base64-vs-File branch
 * through a shared component for a single caller today — scope §6 calls
 * for extracting a picker only where doing so doesn't change an existing
 * caller's behavior; see the PR 2 report for the full reasoning.
 *
 * The DOWNSCALE step, though, reuses `client/src/utils/imageCompression.js`
 * (`encodeJpegFile`) rather than a second decode/canvas pipeline — that is
 * the repo's one designated canvas encoder (AGENTS.md: extend the existing
 * mechanism, don't build a parallel one) and, critically, the reason it
 * exists at all: a picked file is decoded and drawn to canvas ONE AT A TIME
 * here (see `handleFiles` below), never with `Promise.all`, because a
 * single 4032x3024 phone photo is already a ~46 MiB raster and decoding a
 * multi-file pick concurrently can crash a mobile browser before anything
 * uploads.
 */
import { useEffect, useRef, useState } from 'react';
import { COLORS, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as S } from '../../theme-customer';
import Icon from '../Icon';
import { encodeJpegFile } from '../../utils/imageCompression';

// Mirrors server/utils/request-photo-validation.js (MAX_PHOTOS,
// MAX_PHOTO_BYTES — shared by visit-prep.js's VISIT_PREP_LIMITS) so an
// obviously-invalid pick never reaches the network.
const MAX_PHOTOS_PER_SUBMISSION = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const NOTE_MAX_CHARS = 500;
const ALLOWED_TYPE_RE = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const RESIZE_MAX_EDGE = 1600;
const RESIZE_QUALITY = 0.85;
const REJECTED_MESSAGE = 'Photos must be JPEG, PNG, WebP, or HEIC, 5 MB or smaller.';

// Some browsers report an empty (or generic application/octet-stream)
// `file.type` for HEIC/HEIF — recovered from the filename extension so the
// multipart part still declares a real image type (a blank/generic type
// would otherwise upload as application/octet-stream and fail the
// server's declared-type allowlist). Small and single-use: PhotoId.jsx
// keeps its own private copy of the same EXT_MIME/mimeFromName pair for
// its own (unrelated, base64-JSON) picker — see the file header on why
// this component isn't built on that one.
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
};
function mimeFromName(name) {
  return EXT_MIME[String(name || '').split('.').pop().toLowerCase()] || null;
}

const photoWord = (n) => (n === 1 ? 'photo' : 'photos');

const GENERIC_ERROR = "We couldn't send that just now. Please try again, or text or call us.";
const BUSY_ERROR = 'Please try again in a moment.';
const FULL_MESSAGE = 'This visit already has the most photos it can take.';
const DUPLICATE_MESSAGE = 'Those photos are already attached to this visit.';

// Maps the server's error codes (server/services/visit-prep.js `prepError`,
// docs/public-route-contracts.md) to a short, truthful customer line — no
// price, no response-time promise, no "our team reviews" (scope §7). A 409
// (PREP_CAP_REACHED) is handled separately, before this is ever called —
// see `send()` — because it's a terminal state (the visit really is full),
// not a retryable form error. PREP_INVALID_FIELD / PREP_INVALID_PHOTO / a
// multer 400 all carry the server's own plain message already safe to
// echo verbatim.
function messageForSubmitError(err) {
  const status = err?.status;
  if (status === 503) return BUSY_ERROR;
  if (status === 400 || status === 413) return err.message || GENERIC_ERROR;
  return GENERIC_ERROR;
}

// FileReader, not URL.createObjectURL — the same convention PhotoId.jsx's
// fileToDataUrl uses, and it works without extra cleanup bookkeeping.
function fileToPreview(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(String(ev.target?.result || '') || null);
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// One picked file -> `{ file, preview }` (accepted) or `null` (rejected:
// unsupported type, or still over 5 MB after the resize/fallback attempt).
// Pulled out of handleFiles's loop so the decision — type recovery,
// downscale, decode-failure fallback, the final size check — reads as one
// function with one job, called once per file from that loop.
async function processPickedFile(file) {
  let declaredMime = file.type;
  if (!declaredMime || !ALLOWED_TYPE_RE.test(declaredMime)) {
    declaredMime = mimeFromName(file.name) || declaredMime || '';
  }
  if (!declaredMime || !ALLOWED_TYPE_RE.test(declaredMime)) return null;

  const encoded = await encodeJpegFile(file, { maxEdge: RESIZE_MAX_EDGE, quality: RESIZE_QUALITY });
  let outFile = encoded;
  // The preview is only ever built from bytes we know decode — the
  // fallback below keeps a file the BROWSER couldn't render (that's why
  // it fell back), so a data-URL preview of it would just be a broken
  // image. null renders the placeholder tile instead.
  let preview = null;
  if (outFile) {
    preview = await fileToPreview(outFile);
  } else if (file.size > MAX_PHOTO_BYTES) {
    // Couldn't decode at all (e.g. HEIC outside Safari), and the original
    // is too large to fall back to untouched.
    return null;
  } else {
    // Falls back to the original bytes, re-typed, since they already
    // fit — the server converts HEIC itself either way.
    outFile = new File([file], file.name, { type: declaredMime });
  }
  if (outFile.size > MAX_PHOTO_BYTES) return null;

  return { file: outFile, preview };
}

function PickerButton({ icon, label, onClick, disabled }) {
  return (
    <button
      type="button"
      data-glass="soft"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minHeight: 48,
        padding: '0 12px',
        borderRadius: 8,
        // Same soft-glass secondary treatment as the page's own
        // "Add to calendar" action.
        border: `1px solid ${S.softBorder}`,
        background: S.soft,
        color: S.text,
        fontSize: 16,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
}

/**
 * @param {number} photosRemaining - from the page payload's
 *   `prepPhotos.photosRemaining`; caps how many photos this submission can
 *   pick (min(3, remaining) — scope §9 decision 7/§4).
 * @param {(formData: FormData) => Promise<{ prepPhotos?: object }>} onSubmit
 *   Must throw an Error with `.status` (and, for a validation/cap/busy
 *   response, `.message` set to the server's own plain text) on failure.
 *   `.status === 404` switches this form to its "gone" state.
 */
export default function VisitPrepPhotoForm({ photosRemaining, onSubmit }) {
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState([]); // [{ file, preview }]
  const [phase, setPhase] = useState('form'); // 'form' | 'sending' | 'sent' | 'gone' | 'full'
  const [error, setError] = useState(null);
  const [sentCount, setSentCount] = useState(0);
  // True for the whole duration of a pick's decode/resize loop (see
  // handleFiles) — Send is disabled while this is true so a tap can never
  // submit the OLD `photos` state and silently omit a photo still being
  // processed.
  const [pickingPhotos, setPickingPhotos] = useState(false);
  // Two pickers, same handler: the camera input opens the phone camera
  // directly (`capture`), the library input opens photos/files — the
  // take-or-upload choice the Photo ID flow offers, owner 2026-09-28.
  const cameraInputRef = useRef(null);
  const libraryInputRef = useRef(null);
  const mountedRef = useRef(true);
  const ackHeadingRef = useRef(null);
  // Explicitly set true on run, not just false on cleanup — React 18
  // StrictMode's dev-only mount/cleanup/remount cycle runs this cleanup
  // once immediately after the first mount, and a cleanup-only effect
  // would leave the ref permanently false from then on with no genuine
  // unmount ever happening (caught mocking this page for the PR screenshots).
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // The Send button (and the rest of the form) unmounts the instant the
  // acknowledgment replaces it, so `role="status"` alone isn't guaranteed
  // to be read by every screen reader — moving focus to the heading makes
  // the confirmation impossible to miss.
  useEffect(() => {
    if (phase === 'sent') ackHeadingRef.current?.focus();
  }, [phase]);

  const maxPickable = Math.max(
    0,
    Math.min(MAX_PHOTOS_PER_SUBMISSION, photosRemaining == null ? MAX_PHOTOS_PER_SUBMISSION : photosRemaining),
  );

  // Every picked file is downscaled to a <=1600px JPEG at 0.85 quality
  // before it ever reaches FormData, through the shared `encodeJpegFile`
  // (see the file header) — ONE AT A TIME, in a plain sequential loop,
  // never `Promise.all`: decoding and canvasing several full-resolution
  // phone photos concurrently can crash a mobile browser before anything
  // uploads. `pickingPhotos` tracks the whole loop so Send stays disabled
  // (and "Add photos" shows it's working) until every picked file has
  // actually finished — otherwise a tap on Send while a pick is still
  // resolving would submit the OLD `photos` state and silently omit the
  // new one. An empty/generic `file.type` (some browsers report this, or
  // report `application/octet-stream`, for HEIC/HEIF) is corrected from
  // the filename extension so the multipart part still declares the right
  // Content-Type — the server checks the DECLARED type against its
  // allowlist, and a blank/generic type goes out as application/octet-
  // stream. A pick this loop drops for ANY reason (unsupported type,
  // still over 5 MB after the resize/fallback attempt, or beyond the
  // remaining photo count) shows one short line rather than silently
  // vanishing.
  const handleFiles = async (fileList) => {
    const all = Array.from(fileList || []);
    if (!all.length) return;
    const room = maxPickable - photos.length;
    if (room <= 0) return;

    const picked = all.slice(0, room);
    const overflowCount = all.length - picked.length;
    let rejectedForTypeOrSize = false;

    setPickingPhotos(true);
    try {
      const accepted = [];
      for (const file of picked) {
        // One decode/canvas in flight at a time — see the block comment
        // above.
        const result = await processPickedFile(file);
        if (result) accepted.push(result);
        else rejectedForTypeOrSize = true;
      }

      // Both reasons can apply to one pick; name each so no dropped file
      // goes unexplained.
      const messages = [];
      if (rejectedForTypeOrSize) messages.push(REJECTED_MESSAGE);
      if (overflowCount > 0) messages.push(`You can add up to ${maxPickable} ${photoWord(maxPickable)}.`);
      setError(messages.length ? messages.join(' ') : null);
      if (accepted.length) setPhotos((prev) => [...prev, ...accepted].slice(0, maxPickable));
    } finally {
      setPickingPhotos(false);
    }
  };

  const removePhoto = (index) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const send = async () => {
    if (phase === 'sending' || !photos.length) return;
    setPhase('sending');
    setError(null);
    const formData = new FormData();
    photos.forEach((p) => formData.append('photos', p.file, p.file.name || 'photo.jpg'));
    const trimmedNote = note.trim();
    if (trimmedNote) formData.append('note', trimmedNote);
    try {
      const response = await onSubmit(formData);
      if (!mountedRef.current) return;
      // The server dedupes (the same image picked twice, or one already
      // on the visit from an earlier send) — the response's own
      // photosRemaining is the source of truth for how many of THIS
      // pick actually landed, never `photos.length` (what was merely
      // attempted).
      // The server's count of NEW photos stored by THIS request (Codex
      // #5243 r3 P2): it dedupes a repeated or already-attached image, and
      // a stop-wide remaining count would also absorb another tab's upload.
      const added = response?.prepPhotos?.photosAdded;
      setSentCount(typeof added === 'number' ? added : null);
      setPhotos([]);
      setPhase('sent');
    } catch (err) {
      if (!mountedRef.current) return;
      if (err?.status === 404) {
        setPhase('gone');
        return;
      }
      if (err?.status === 409) {
        // The visit is genuinely full (PREP_CAP_REACHED) — a terminal
        // state like "gone", not a retryable form error: Send would just
        // 409 again.
        setPhase('full');
        return;
      }
      setError(messageForSubmitError(err));
      setPhase('form');
    }
  };

  // A 404 on submit (the visit is no longer eligible — cancelled, en
  // route, etc. between page load and send) gets its own one-line
  // treatment: nothing left to do here, no dead-end form (scope §7: no
  // price, no promise, no dead end).
  if (phase === 'gone') {
    return (
      <div data-testid="visit-prep-gone" style={{ fontSize: 16, color: S.muted, lineHeight: 1.5 }}>
        Photos can no longer be added to this visit.
      </div>
    );
  }
  // Full is the SAME terminal treatment for two different reasons a
  // customer can never send more from here: `maxPickable` resolves to 0
  // before any submit (visitPrepEligibility doesn't itself check the
  // photo/submission caps, so `eligible: true` with no room left is a
  // real payload shape), or a submit 409s with PREP_CAP_REACHED (the visit
  // filled between page load and send — see `send()`'s catch). Either
  // way: no editable form with a Send button that would just 409 again.
  if (phase === 'full' || maxPickable <= 0) {
    return (
      <div data-testid="visit-prep-full" style={{ fontSize: 16, color: S.muted, lineHeight: 1.5 }}>
        {FULL_MESSAGE}
      </div>
    );
  }

  if (phase === 'sent') {
    return (
      <div data-testid="visit-prep-sent" role="status">
        <div
          ref={ackHeadingRef}
          tabIndex={-1}
          style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS.heading, color: S.text, marginBottom: 8, outline: 'none' }}
        >
          Got it.
        </div>
        <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
          This is attached to your visit so your technician sees it before starting.
        </div>
        {/* sentCount is the server's count of NEW photos this request
            stored (see send()), so this never overclaims; no count at all
            when the response carried none. */}
        {sentCount == null ? null : (
          <div style={{ fontSize: 16, color: S.muted, marginTop: 8, fontWeight: 600 }}>
            {sentCount > 0 ? `${sentCount} ${photoWord(sentCount)} sent` : DUPLICATE_MESSAGE}
          </div>
        )}
      </div>
    );
  }

  // While the submit is in flight, every control that could change what's
  // about to be (or was just) sent freezes — the FormData is already
  // built and posted, so nothing on screen may diverge from it.
  const formFrozen = phase === 'sending';
  const frozenOpacity = formFrozen ? 0.6 : 1;
  // Photos still being processed, or a submit in flight: no new picks.
  const pickerDisabled = pickingPhotos || formFrozen;
  const sendDisabled = !photos.length || pickerDisabled;

  return (
    <div data-testid="visit-prep-form">
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FONTS.heading, color: S.text, marginBottom: 8 }}>
        Anything you want your technician to look at?
      </div>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.5, marginBottom: 14 }}>
        Add up to {maxPickable} {photoWord(maxPickable)} and a short note.
      </div>

      <label htmlFor="visit-prep-note" style={{ fontSize: 16, fontWeight: 600, color: S.text, display: 'block', marginBottom: 6 }}>
        A short note (optional)
      </label>
      <textarea
        id="visit-prep-note"
        value={note}
        maxLength={NOTE_MAX_CHARS}
        onChange={(e) => setNote(e.target.value)}
        disabled={formFrozen}
        rows={3}
        placeholder="What should we know before we arrive?"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          border: `1px solid ${S.borderStrong}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 16,
          fontFamily: 'inherit',
          color: S.text,
          resize: 'vertical',
          marginBottom: 14,
          opacity: frozenOpacity,
        }}
      />

      <input
        ref={cameraInputRef}
        data-testid="visit-prep-camera-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
      <input
        ref={libraryInputRef}
        data-testid="visit-prep-library-input"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        multiple
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        style={{ display: 'none' }}
      />

      {photos.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 8, marginBottom: 12 }}>
          {photos.map((p, i) => (
            <div key={`${p.file.name}-${i}`} style={{ position: 'relative', aspectRatio: '1 / 1' }}>
              {p.preview ? (
                <img
                  src={p.preview}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, border: `1px solid ${S.border}`, display: 'block' }}
                />
              ) : (
                <div data-testid="photo-placeholder" style={{ height: '100%', border: `1px solid ${S.border}`, borderRadius: 8, background: S.soft }} />
              )}
              <button
                type="button"
                onClick={() => removePhoto(i)}
                disabled={formFrozen}
                aria-label={`Remove photo ${i + 1}`}
                style={{
                  // 48x48 hit area (customer-surface spec: 48px+ touch
                  // targets) around a visually small 24px chip, same
                  // pattern PortalPage's own photo picker uses — the
                  // button itself is transparent so the larger box
                  // never visually swallows the thumbnail.
                  position: 'absolute',
                  top: -12,
                  right: -12,
                  width: 48,
                  height: 48,
                  background: 'transparent',
                  border: 'none',
                  cursor: formFrozen ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: `1px solid ${S.border}`,
                    background: '#FFFFFF',
                    color: S.text,
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: frozenOpacity,
                  }}
                >
                  ×
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {photos.length < maxPickable ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          <PickerButton
            icon="camera"
            label="Take a photo"
            onClick={() => cameraInputRef.current?.click()}
            disabled={pickerDisabled}
          />
          <PickerButton
            icon="upload"
            label="Upload a photo"
            onClick={() => libraryInputRef.current?.click()}
            disabled={pickerDisabled}
          />
        </div>
      ) : null}
      {pickingPhotos ? (
        <div role="status" style={{ fontSize: 16, color: S.muted, marginTop: -6, marginBottom: 14 }}>
          Adding photos…
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
            padding: '10px 12px', fontSize: 16, color: '#9A3412', marginBottom: 14, lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      ) : null}

      <button
        type="button"
        data-glass-accent=""
        // Without the size tag the glass theme's accent rule pins buttons
        // at 44px !important; primary keeps the 48px customer touch target
        // (same tag PhotoId's submit uses).
        data-glass-size="primary"
        onClick={send}
        disabled={sendDisabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minHeight: 48,
          padding: '0 20px',
          background: COLORS.glassNavy,
          color: COLORS.white,
          border: `1px solid ${COLORS.glassNavy}`,
          borderRadius: 8,
          fontFamily: FONTS.ui,
          fontWeight: 700,
          fontSize: 16,
          cursor: sendDisabled ? 'default' : 'pointer',
          opacity: sendDisabled ? 0.5 : 1,
        }}
      >
        {phase === 'sending' ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
