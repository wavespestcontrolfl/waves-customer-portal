import { useRef, useState } from 'react';
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../../constants/business';
import { FS, FW, LH, RADIUS, SP } from '../../theme-doc';

// GATE_REPORT_WEB_ACTIONS (owner 2026-10-20): two customer-started actions at
// the foot of the simple web service report. The server sets
// data.webActions only while the gate is live; each half renders only when its
// own key is present, so an absent key means the page is as it was.
//
//   finding tile: one tile tied to a finding on this visit. Fixed sentences from
//     the server, no price on the page. The tap is the report's existing
//     cross_sell_requested event (the server recomputes the offer, mints the
//     estimate and answers with its URL); we go to that estimate page.
//   photo button: "Seen something since?". The photo is shrunk here, sent to
//     POST /reports/:token/photo-check, and the server answers in fixed
//     sentences. A covered answer links to the signed-in Schedule tab, the same
//     path the report's re-service card uses. This component sends no text or
//     email and books nothing.

const MAX_SIDE = 1600;
// The server refuses a photo over 750 KB decoded; stay under it with room for the data URL prefix.
const TARGET_BYTES = 650 * 1024;
const SERVER_LIMIT_BYTES = 750 * 1024;
const QUALITIES = [0.85, 0.7, 0.55, 0.4];
const MIN_SIDE = 320;
const HEIC_TYPES = { 'image/heic': 'image/heic', 'image/heif': 'image/heif' };

// Prose is 16px (owner D1: body prose is 16 on customer surfaces); fine print is 14px and its selector is
// specific enough to win over the prose rule. Sizes come from theme-doc.
export const REPORT_WEB_ACTIONS_CSS = `
  .web-actions { display: grid; gap: ${SP.sm}px; margin: ${SP.md}px 0 0; }
  .web-actions .web-action-card { padding: ${SP.lg}px; border-radius: ${RADIUS.card}px; background: var(--paper, #fff); border: 1px solid var(--line, rgba(4, 57, 94, 0.12)); }
  .web-actions .web-action-card h2 { margin: 0 0 ${SP.xs}px; font-size: ${FS.sub}px; line-height: ${LH.heading}; font-weight: ${FW.bold}; }
  .web-actions .web-action-card p { margin: 0 0 ${SP.sm}px; font-size: ${FS.bodyLg}px; line-height: ${LH.body}; }
  .web-actions .web-action-card p:last-child { margin-bottom: 0; }
  .web-actions .web-action-card p.web-action-answer { font-weight: ${FW.semibold}; }
  .web-actions .web-action-card p.web-action-fine { font-size: ${FS.body}px; line-height: ${LH.snug}; }
  .web-actions .web-action-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: 48px; max-width: 100%; padding: 0 18px; border-radius: ${RADIUS.button}px; border: 0; font-size: ${FS.body}px; line-height: ${LH.solid}; font-weight: ${FW.bold}; text-decoration: none; cursor: pointer; background: #04395E; color: #fff; }
  .web-actions .web-action-btn[disabled] { opacity: 0.6; cursor: default; }
  .web-actions .web-action-file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; pointer-events: none; }
`;

// Same-origin only, against the browser's actual origin: a legitimate estimate
// link shares this page's origin; anything else never navigates.
function goToEstimate(estimateUrl) {
  if (typeof estimateUrl !== 'string' || !estimateUrl) return;
  try {
    const parsed = new URL(estimateUrl, window.location.origin);
    if (parsed.origin === window.location.origin) window.location.assign(parsed.href);
  } catch { /* unparsable: keep the confirmation */ }
}

function FindingTile({ finding, token, submitEvent, readOnly }) {
  // idle | sending | sent | stale | failed
  const [state, setState] = useState('idle');
  const tap = async () => {
    if (readOnly || state === 'sending' || state === 'sent') return;
    setState('sending');
    const result = await submitEvent(token, 'cross_sell_requested', finding.tap);
    setState(result.ok ? 'sent' : result.status === 409 ? 'stale' : 'failed');
    if (result.ok) goToEstimate(result.body?.estimateUrl);
  };
  return (
    <section data-glass="card" className="web-action-card" data-section="finding-offer">
      <h2>{finding.sentence}</h2>
      <p>{finding.body}</p>
      {state === 'sent' ? (
        <p className="web-action-answer">Request received. We will confirm the details with you before anything is scheduled.</p>
      ) : state === 'stale' ? (
        <button type="button" data-glass-accent="" className="web-action-btn" onClick={() => window.location.reload()}>
          Offer updated. Refresh to see the latest
        </button>
      ) : (
        <button type="button" data-glass-accent="" className="web-action-btn" disabled={readOnly || state === 'sending'} onClick={tap}>
          {state === 'sending' ? 'Sending…' : finding.button}
        </button>
      )}
      {state === 'failed' && (
        <p className="web-action-fine">That did not go through. Please try again, or call {WAVES_SUPPORT_PHONE_DISPLAY}.</p>
      )}
    </section>
  );
}

// Shrinks the picked photo to a JPEG data URL the server will take (750 KB or less). It lowers the quality,
// then keeps reducing the dimensions, until the result fits, and never returns an oversized image: when
// nothing fits it says so ({ reason: 'too_large' }). A photo the browser cannot decode (HEIC on a browser
// without HEIC support) resolves { reason: 'unreadable' } so the caller can send the original if it is small.
function shrinkPhoto(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement('canvas');
        let scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        for (;;) {
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          for (const quality of QUALITIES) {
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length * 0.75 <= TARGET_BYTES) { resolve({ dataUrl }); return; }
          }
          if (Math.max(canvas.width, canvas.height) <= MIN_SIDE) { resolve({ reason: 'too_large' }); return; }
          scale *= 0.8;
        }
      } catch { resolve({ reason: 'unreadable' }); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ reason: 'unreadable' }); };
    img.src = url;
  });
}

// The original file as a data URL, for a HEIC/HEIF photo the browser cannot decode: the server converts it,
// as the portal photo flow does. Only when it is within the byte limit; null otherwise.
function readOriginal(file) {
  const name = String(file.name || '').toLowerCase();
  const type = HEIC_TYPES[String(file.type || '').toLowerCase()] || (/\.hei[cf]$/.test(name) ? (name.endsWith('f') ? 'image/heif' : 'image/heic') : null);
  if (!type || file.size > SERVER_LIMIT_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma < 0 ? null : `data:${type};base64,${result.slice(comma + 1)}`);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function PhotoCheck({ token, apiBase, readOnly }) {
  // idle | checking | answered | failed
  const [state, setState] = useState('idle');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const fail = (message) => {
    setError(message || `We could not check this photo. Call ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
    setState('failed');
  };
  const onPick = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || readOnly) return;
    setState('checking');
    const shrunk = await shrinkPhoto(file);
    const dataUrl = shrunk.dataUrl || (shrunk.reason === 'unreadable' ? await readOriginal(file) : null);
    if (!dataUrl) {
      fail(shrunk.reason === 'too_large'
        ? `That photo is too large. Try another one or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`
        : `We could not read that photo. Try another one or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
      return;
    }
    try {
      const response = await fetch(`${apiBase}/reports/${token}/photo-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: [dataUrl] }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) { fail(body && typeof body.error === 'string' ? body.error : ''); return; }
      setAnswer(body);
      setState('answered');
    } catch { fail(''); }
  };
  const callLine = `Questions? Call ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
  return (
    <section data-glass="card" className="web-action-card" data-section="photo-check">
      <h2>Seen something since?</h2>
      <p>Add a photo and we will tell you what we can see.</p>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="web-action-file"
        aria-label="Add a photo"
        tabIndex={-1}
        onChange={onPick}
      />
      <button
        type="button"
        data-glass-accent=""
        className="web-action-btn"
        disabled={readOnly || state === 'checking'}
        onClick={() => fileRef.current && fileRef.current.click()}
      >
        {readOnly ? 'Staff preview' : state === 'checking' ? 'Checking your photo…' : state === 'answered' ? 'Add another photo' : 'Add a photo'}
      </button>
      {state === 'answered' && answer && (
        <div role="status" style={{ marginTop: 12 }}>
          {answer.headline ? <p className="web-action-answer">{answer.headline}</p> : null}
          <p>{answer.message}</p>
          {answer.canRebook ? (
            <p><a data-glass-accent="" className="web-action-btn" href="/?tab=schedule">Book my free re-service</a></p>
          ) : null}
          {!String(answer.message || '').includes(WAVES_SUPPORT_PHONE_DISPLAY) ? <p className="web-action-fine">{callLine}</p> : null}
        </div>
      )}
      {state === 'failed' && <p role="status" className="web-action-fine" style={{ marginTop: 12 }}>{error}</p>}
    </section>
  );
}

export default function ReportWebActions({ actions, token, apiBase, submitEvent, readOnly = false }) {
  if (!actions || (!actions.finding && !actions.photo)) return null;
  return (
    <div className="web-actions">
      <style>{REPORT_WEB_ACTIONS_CSS}</style>
      {actions.finding ? <FindingTile finding={actions.finding} token={token} submitEvent={submitEvent} readOnly={readOnly} /> : null}
      {actions.photo ? <PhotoCheck token={token} apiBase={apiBase} readOnly={readOnly} /> : null}
    </div>
  );
}
