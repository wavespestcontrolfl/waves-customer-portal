// Booked sheet for "Book at the Table" (GATE_IN_PERSON_CARD, owner 2026-11-02).
//
// Shown by CreateAppointmentModal after a booking saved with "Customer saves
// it here, now". On open it asks POST /admin/schedule/:id/card-request/in-person
// for the secure card page, then offers: hand the phone to the customer (only
// when the Waves Admin app can open the hand-off), show a QR code of the page,
// text the link, or skip. Nothing is charged and no text goes out unless staff
// tap "Text the link". The booking stays whatever happens here.
//
// Hand-off: the app shows the secure page to the customer in a separate,
// isolated web view and covers this page; this tab never navigates. While the
// card step is open the sheet answers one relay for that view (see
// window.wavesAdminInPersonTerms below).
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import useModalFocus from '../../hooks/useModalFocus';
import { describeCardRequestResult } from './cardLinkStatus';
import { HANDOFF_OPEN, getAdminCapabilities, openHandoff } from '../../lib/wavesAdminHandoff';

// Same zinc admin palette as CreateAppointmentModal's D.
const D = {
  bg: '#FAFAFA', card: '#FFFFFF', border: '#E4E4E7', text: '#18181B',
  muted: '#71717A', red: '#DC2626', white: '#fff',
};
const ROBOTO_STACK = "'Roboto', Arial, sans-serif";
export const POLL_INTERVAL_MS = 4000;

const buttonBase = {
  width: '100%', minHeight: 48, padding: '12px 16px', borderRadius: 8, fontSize: 15,
  fontWeight: 500, fontFamily: ROBOTO_STACK, cursor: 'pointer', boxSizing: 'border-box',
};
const primaryButton = { ...buttonBase, background: D.text, color: D.white, border: 'none' };
const secondaryButton = { ...buttonBase, background: D.card, color: D.text, border: `1px solid ${D.border}` };

// "Tue, Nov 3" from a YYYY-MM-DD (noon-anchored so the weekday cannot slip).
export function formatBookedDate(date) {
  const day = String(date || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function absoluteHref(url) {
  if (!url) return '';
  try { return new URL(url, window.location.origin).href; } catch { return url; }
}

// Plain-English line for an endpoint outcome that is not a link.
export function describeInPersonOutcome(result, firstName) {
  const who = firstName || 'the customer';
  if (result?.action === 'auto_secured') return { tone: 'good', text: `Auto Pay is already on for ${who}.` };
  const reason = String(result?.reason || '');
  if (reason === 'payer_billed' || reason === 'payer_check_uncertain') {
    return { tone: 'muted', text: 'This visit bills a third-party payer, so no card is asked for.' };
  }
  if (reason === 'request_exists') return { tone: 'muted', text: 'A card request already exists for this visit.' };
  if (reason === 'gate_off' || reason === 'template_inactive') {
    return { tone: 'muted', text: 'The card page is not available right now.' };
  }
  if (reason === 'unpriced_visit' || reason === 'zero_price_visit') {
    return { tone: 'muted', text: 'This visit has no price yet, so no card is asked for.' };
  }
  return describeCardRequestResult(result);
}

// Outcome of the existing text route. It still holds the first-time-customers-
// only rule, so a customer with past visits is not texted: say so plainly.
export function describeTextOutcome(result) {
  if (String(result?.reason || '') === 'existing_customer') {
    return { tone: 'muted', text: 'Not texted: this customer has past visits, and the text rule skips them. Use the QR code.' };
  }
  return describeCardRequestResult(result);
}

function Row({ children }) {
  return <div style={{ fontSize: 14, color: D.text, padding: '4px 0' }}>{children}</div>;
}

function QrPanel({ url, firstName, saved }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 240 })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setSrc(''); });
    return () => { cancelled = true; };
  }, [url]);
  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      {src && <img src={src} alt="QR code for the card page" width={240} height={240} style={{ background: D.white, borderRadius: 8 }} />}
      <div role="status" style={{ fontSize: 14, marginTop: 8, color: saved ? D.text : D.muted, fontWeight: saved ? 500 : 400 }}>
        {saved ? 'Saved. Auto Pay is on.' : `Waiting for ${firstName || 'the customer'}'s phone…`}
      </div>
    </div>
  );
}

const cardSaved = (state) => state?.request?.status === 'completed' || !!state?.autopayActive;

// Poll the visit's card state every 4 s while `active` (the QR code is on
// screen) and stop for good once the card is saved.
function useSavedPolling({ active, adminFetch, visitId }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!active || saved) return undefined;
    let stopped = false;
    const tick = () => {
      adminFetch(`/admin/schedule/${visitId}/card-request`)
        .then((state) => {
          if (stopped) return;
          if (cardSaved(state)) setSaved(true);
        })
        .catch(() => {});
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, saved, adminFetch, visitId]);
  return saved;
}

const toneColor = (t) => (t === 'good' ? D.text : t === 'bad' ? D.red : D.muted);
const sectionLabel = { fontSize: 14, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500, marginBottom: 4 };

// The secure token is the last segment of the secure page path (/secure/:token).
function secureTokenOf(secureUrl) {
  try { return new URL(secureUrl, window.location.origin).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
}

// The secure page in hand-off mode, as an absolute link for the app.
function handoffHref(secureUrl) {
  const url = new URL(secureUrl, window.location.origin);
  url.searchParams.set('handoff', '1');
  return url.href;
}

// While the card step is open, the app's customer view can ask this signed-in page
// to record the terms the customer ticked (the view itself holds no sign-in).
// Answers only for this visit's own secure token and goes away with the sheet.
// Same shape as window.wavesAdminConnectionToken in lib/tapToPay.js.
function useInPersonTermsRelay({ adminFetch, visitId, secureToken }) {
  useEffect(() => {
    const relay = async ({ secureToken: askedToken, termsVersion, termsScope, consumerNoticeShown } = {}) => {
      if (!secureToken || askedToken !== secureToken) return { ok: false };
      try {
        const r = await adminFetch(`/admin/schedule/${visitId}/in-person-terms`, {
          method: 'POST',
          body: JSON.stringify({ terms_version: termsVersion, terms_scope: termsScope, consumer_notice_shown: consumerNoticeShown === true }),
        });
        return { ok: r?.success === true };
      } catch (err) {
        return { ok: false, message: err?.message || null, code: err?.body?.code || null };
      }
    };
    window.wavesAdminInPersonTerms = relay;
    return () => { if (window.wavesAdminInPersonTerms === relay) delete window.wavesAdminInPersonTerms; };
  }, [adminFetch, visitId, secureToken]);
}

// "Hand the phone to {first}": shown only when the app answers the capabilities
// ask with 'handoffOpen'. Taps open the isolated customer view; when it ends the
// card state is read again and the result is said plainly.
function useHandoff({ secureUrl, firstName, adminFetch, visitId, mountedRef }) {
  const [canHandoff, setCanHandoff] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | with
  const [result, setResult] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getAdminCapabilities().then((caps) => { if (!cancelled) setCanHandoff(caps.includes(HANDOFF_OPEN)); });
    return () => { cancelled = true; };
  }, []);
  const start = async () => {
    if (phase === 'with') return;
    setPhase('with');
    setResult(null);
    const outcome = await openHandoff({ url: handoffHref(secureUrl), firstName });
    if (!mountedRef.current) return;
    if (outcome.status === 'failed') {
      setPhase('idle');
      setResult({ tone: 'bad', text: outcome.message || 'The hand-off did not start. Use the QR code instead.' });
      return;
    }
    let state = null;
    try { state = await adminFetch(`/admin/schedule/${visitId}/card-request`); } catch { /* said below */ }
    if (!mountedRef.current) return;
    setPhase('idle');
    if (cardSaved(state)) setResult({ tone: 'good', text: 'Saved. Auto Pay is on.' });
    else if (state) setResult({ tone: 'muted', text: 'Not saved yet. Hand the phone over again or use the QR code.' });
    else setResult({ tone: 'bad', text: 'Could not check whether the card was saved.' });
  };
  return { canHandoff, phase, result, start };
}

// The four choices once the card page exists: hand over the phone, QR code,
// text the link, or not now.
function CardActions({ secureUrl, firstName, adminFetch, visitId, onClose }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [textState, setTextState] = useState(null); // null | 'sending' | { tone, text }
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const saved = useSavedPolling({ active: qrOpen, adminFetch, visitId });
  const first = firstName || 'the customer';
  useInPersonTermsRelay({ adminFetch, visitId, secureToken: secureTokenOf(secureUrl) });
  const handoff = useHandoff({ secureUrl, firstName, adminFetch, visitId, mountedRef });
  const textTheLink = () => {
    setTextState('sending');
    adminFetch(`/admin/schedule/${visitId}/card-request`, { method: 'POST' })
      .then((r) => { if (mountedRef.current) setTextState(describeTextOutcome(r)); })
      .catch(() => { if (mountedRef.current) setTextState({ tone: 'bad', text: 'Send failed — try again' }); });
  };

  return (
    <div>
      <div style={sectionLabel}>Card for Auto Pay</div>
      <p style={{ fontSize: 14, margin: '0 0 12px' }}>
        {handoff.canHandoff
          ? `${first} can save a card now: hand them your phone, show the QR code for their own phone, or text the link.`
          : `${first} can save a card now on their own phone: show the QR code, or text the link.`}
        {' '}Nothing is charged today. Auto Pay charges after each completed service.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {handoff.canHandoff && (
          <button type="button" style={primaryButton} disabled={handoff.phase === 'with'} onClick={handoff.start}>
            {handoff.phase === 'with' ? `With ${first}…` : `Hand the phone to ${first}`}
          </button>
        )}
        {handoff.result && (
          <div role="status" style={{ fontSize: 14, color: toneColor(handoff.result.tone) }}>{handoff.result.text}</div>
        )}
        <button type="button" style={secondaryButton} aria-expanded={qrOpen} onClick={() => setQrOpen((open) => !open)}>
          {qrOpen ? 'Hide the QR code' : 'Show a QR code'}
        </button>
        {qrOpen && <QrPanel url={absoluteHref(secureUrl)} firstName={firstName} saved={saved} />}
        <button type="button" style={secondaryButton} disabled={textState === 'sending'} onClick={textTheLink}>
          {textState === 'sending' ? 'Sending…' : 'Text the link'}
        </button>
        {textState && textState !== 'sending' && (
          <div role="status" style={{ fontSize: 14, color: toneColor(textState.tone) }}>{textState.text}</div>
        )}
        <button type="button" style={secondaryButton} onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

function SheetBody({
  visitId, date, time, serviceName, estimateAccepted, estimateRef, confirmationText,
  firstName, adminFetch, onClose,
}) {
  const dialogRef = useModalFocus(true, onClose);
  const [phase, setPhase] = useState('loading'); // loading | error | result
  const [result, setResult] = useState(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(() => {
    setPhase('loading');
    adminFetch(`/admin/schedule/${visitId}/card-request/in-person`, { method: 'POST' })
      .then((r) => {
        if (!mountedRef.current) return;
        setResult(r || null);
        setPhase('result');
      })
      .catch(() => { if (mountedRef.current) setPhase('error'); });
  }, [adminFetch, visitId]);

  useEffect(() => { load(); }, [load]);

  const secureUrl = result?.action === 'link_created' && result.secureUrl ? result.secureUrl : null;

  const outcome = phase === 'result' && !secureUrl ? describeInPersonOutcome(result, firstName) : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: ROBOTO_STACK }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="in-person-card-title"
        style={{ background: D.bg, color: D.text, borderRadius: 12, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', padding: 20, boxSizing: 'border-box' }}
      >
        <h2 id="in-person-card-title" style={{ fontSize: 20, fontWeight: 500, margin: '0 0 8px' }}>Booked</h2>
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <Row>{formatBookedDate(date)}{time ? `, ${time}` : ''}</Row>
          {serviceName && <Row>{serviceName}</Row>}
          {estimateAccepted && <Row>{estimateRef ? `Estimate ${estimateRef} marked accepted` : 'Estimate marked accepted'}</Row>}
          {confirmationText && <Row>Confirmation text going out</Row>}
        </div>

        {phase === 'loading' && (
          <div role="status" style={{ fontSize: 14, color: D.muted, padding: '8px 0' }}>Getting the card page ready…</div>
        )}

        {phase === 'error' && (
          <div style={{ marginBottom: 12 }}>
            <div role="alert" style={{ fontSize: 14, color: D.red, marginBottom: 8 }}>
              The card page did not load. The booking is saved.
            </div>
            <button type="button" style={{ ...secondaryButton, marginBottom: 8 }} onClick={load}>Try again</button>
            <button type="button" style={secondaryButton} onClick={onClose}>Not now</button>
          </div>
        )}

        {outcome && (
          <div style={{ marginBottom: 12 }}>
            <div style={sectionLabel}>Card for Auto Pay</div>
            <div role="status" style={{ fontSize: 14, color: toneColor(outcome.tone), marginBottom: 12 }}>{outcome.text}</div>
            <button type="button" style={primaryButton} onClick={onClose}>Done</button>
          </div>
        )}

        {phase === 'result' && secureUrl && (
          <CardActions secureUrl={secureUrl} firstName={firstName} adminFetch={adminFetch} visitId={visitId} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

export default function InPersonCardSheet(props) {
  return createPortal(<SheetBody {...props} />, document.body);
}
