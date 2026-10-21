import { useRef, useState } from 'react';
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../../constants/business';

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
const TARGET_BYTES = 650 * 1024;

export const REPORT_WEB_ACTIONS_CSS = `
  .web-actions { display: grid; gap: 12px; margin: 16px 0 0; }
  .web-action-card { padding: 20px; border-radius: 12px; background: var(--paper, #fff); border: 1px solid var(--line, rgba(4, 57, 94, 0.12)); }
  .web-action-card h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; }
  .web-action-card p { margin: 0 0 12px; font-size: 15px; line-height: 1.5; }
  .web-action-card p:last-child { margin-bottom: 0; }
  .web-action-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: 44px; max-width: 100%; padding: 0 18px; border-radius: 10px; border: 0; font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; background: #04395E; color: #fff; }
  .web-action-btn[disabled] { opacity: 0.6; cursor: default; }
  .web-action-answer { font-weight: 600; }
  .web-action-fine { font-size: 14px; }
  .web-action-file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; pointer-events: none; }
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

// Shrinks the picked photo to a JPEG data URL small enough for the report API's
// JSON limit. Resolves null when the browser cannot read the file.
function shrinkPhoto(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let quality = 0.85;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length * 0.75 > TARGET_BYTES && quality > 0.4) {
          quality -= 0.15;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      } catch { resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
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
    const dataUrl = await shrinkPhoto(file);
    if (!dataUrl) { fail('We could not read that photo. Try another one.'); return; }
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
