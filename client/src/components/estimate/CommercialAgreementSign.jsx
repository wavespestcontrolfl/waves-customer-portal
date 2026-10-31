import { useEffect, useRef, useState } from 'react';
import { COLORS } from '../../theme-brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../../constants/business';
import { estimateCard } from './cardStyles';
import CommercialFirstVisitPicker, { firstVisitLabel } from './CommercialFirstVisitPicker';
import { W } from './tokens';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export const SIGN_BUTTON_LABEL = 'Accept & sign agreement';

/**
 * "Accept & sign agreement" for an authored commercial proposal
 * (GATE_COMMERCIAL_PROPOSAL_SIGN). `commercialAgreement` is /data's
 * cta.commercialAgreement: { canSign, state: 'none' | 'awaiting' | 'signed' },
 * absent unless the server offers it, so this renders nothing otherwise.
 *
 * The tap POSTs /:token/commercial-agreement, which issues (or re-opens) the
 * Commercial Pest Service Agreement and returns its signing URL; this page
 * then hands the customer to that existing signing page. Signing is not
 * acceptance: the copy says Waves follows up to schedule, and promises no
 * payment, visit or start date. With GATE_COMMERCIAL_FIRST_VISIT on and an
 * eligible proposal, the customer picks the first visit after signing
 * instead (CommercialFirstVisitPicker); booking it is the acceptance.
 */
// `firstVisit` is /data's cta.commercialFirstVisit (GATE_COMMERCIAL_FIRST_VISIT), absent with the gate off: 'pick' turns
// the signed state into the first-visit picker, 'booked' shows the booked visit, and 'after_signing' tells an unsigned
// customer they pick the visit next.
export default function CommercialAgreementSign({ token, commercialAgreement, firstVisit = null, onFirstVisitBooked = null }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Back from the signing page through the browser's history: a bfcache restore keeps the busy state set before the
  // page left, so the button works again.
  useEffect(() => {
    const onPageShow = (event) => {
      if (!event.persisted) return;
      inFlight.current = false;
      setBusy(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  if (!commercialAgreement) return null;
  const { canSign, state, reason } = commercialAgreement;

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    // Only the server's own 409 wording (already signed, no account) is shown as is.
    let serverMessage = '';
    try {
      const response = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/commercial-agreement`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.signingUrl) {
        if (response.status === 409 && body.error) serverMessage = body.error;
        throw new Error('request_failed');
      }
      window.location.assign(body.signingUrl);
    } catch {
      setError(serverMessage || `We couldn’t open the agreement. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
      setBusy(false);
      inFlight.current = false;
    }
  };

  const heading = { fontSize: 20, lineHeight: 1.35, fontWeight: 600, color: W.navy, marginBottom: 8 };
  const body = { fontSize: 16, lineHeight: 1.5, color: W.textBody };
  const callLink = (
    <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: W.blueDeeper, fontWeight: 600 }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>
  );

  if (state === 'signed') {
    if (firstVisit?.state === 'pick') {
      return <CommercialFirstVisitPicker token={token} durationMinutes={firstVisit.durationMinutes} onBooked={onFirstVisitBooked} />;
    }
    const bookedLabel = firstVisit?.state === 'booked' ? firstVisitLabel(firstVisit.visit) : null;
    return (
      <div data-glass="card" data-testid="commercial-agreement-signed" style={estimateCard()}>
        <div style={heading}>Service agreement signed</div>
        <div style={body}>
          {bookedLabel
            ? <>Thank you for signing. Your first visit is booked for {bookedLabel}.</>
            : 'Thank you for signing. Our team will follow up to schedule your first visit.'}
        </div>
      </div>
    );
  }

  if (!canSign) {
    return (
      <div data-glass="card" data-testid="commercial-agreement-call" style={estimateCard()}>
        <div style={heading}>Ready to go ahead?</div>
        <div style={body}>
          {reason === 'terms_conflict'
            ? <>Call us at {callLink} and we will finish your agreement with you.</>
            : <>Call us at {callLink} and we will set up your account and finish your agreement with you.</>}
        </div>
      </div>
    );
  }

  return (
    <div data-glass="card" data-testid="commercial-agreement-sign" style={estimateCard()}>
      <div style={heading}>Ready to go ahead?</div>
      <div style={body}>
        {state === 'awaiting'
          ? 'Your service agreement is ready for your signature. Pick up where you left off.'
          : (firstVisit?.state === 'after_signing'
            ? 'Review and sign the Commercial Pest Service Agreement online. No payment is due when you sign. Then you pick the day and time of your first visit.'
            : 'Review and sign the Commercial Pest Service Agreement online. No payment is due when you sign, and our team will follow up to schedule your first visit.')}
      </div>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        style={{
          marginTop: 16, padding: '16px 20px', background: COLORS.glassNavy, color: COLORS.white,
          border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.7 : 1, width: '100%',
        }}
      >
        {busy ? 'Opening your agreement…' : SIGN_BUTTON_LABEL}
      </button>
      {error ? (
        <p role="alert" style={{ ...body, fontSize: 14, color: W.red, margin: '10px 0 0' }}>{error}</p>
      ) : null}
    </div>
  );
}
