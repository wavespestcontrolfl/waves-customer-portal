import { useEffect, useRef, useState } from 'react';
import { COLORS } from '../../theme-brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../../constants/business';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export const SIGN_AGREEMENT_LABEL = 'Review and sign your service agreement';

/**
 * The residential service agreement(s) on the ACCEPTED estimate page
 * (GATE_ESTIMATE_SERVICE_AGREEMENT). `serviceAgreements` is /data's
 * cta.serviceAgreements: [{ lane: 'pest' | 'lawn', title, state: 'none' | 'awaiting' | 'signed', canSign, reason? }],
 * absent unless the server offers it, so this renders nothing otherwise.
 *
 * Each tap POSTs /:token/service-agreement with its lane, which issues (or re-opens) that lane's agreement and
 * returns its signing URL; this page then hands the customer to that existing signing page in the same tab. The
 * booking is already made: signing changes nothing about the visit, the price or the payment.
 */
export default function ServiceAgreementSign({ token, serviceAgreements }) {
  const inFlight = useRef(null);
  const [busyLane, setBusyLane] = useState(null);
  const [error, setError] = useState('');
  // A tap leaves its button busy while the signing page loads. Back on this page from the browser's cache (the
  // customer left without signing), it works again.
  useEffect(() => {
    const onPageShow = (event) => {
      if (!event.persisted) return;
      inFlight.current = null;
      setBusyLane(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  if (!Array.isArray(serviceAgreements) || serviceAgreements.length === 0) return null;

  const start = async (lane) => {
    if (inFlight.current) return;
    inFlight.current = lane;
    setBusyLane(lane);
    setError('');
    // Only the server's own 409 wording (already signed, no account, unavailable) is shown as is.
    let serverMessage = '';
    try {
      const response = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/service-agreement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lane }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.signingUrl) {
        if (response.status === 409 && body.error) serverMessage = body.error;
        throw new Error('request_failed');
      }
      window.location.assign(body.signingUrl);
    } catch {
      setError(serverMessage || `We couldn’t open your agreement. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
      setBusyLane(null);
      inFlight.current = null;
    }
  };

  const heading = { fontSize: 20, lineHeight: 1.35, fontWeight: 600, color: W.navy, marginBottom: 8 };
  const body = { fontSize: 16, lineHeight: 1.5, color: W.textBody };
  const callLink = (
    <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: W.blueDeeper, fontWeight: 600 }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>
  );
  const allSigned = serviceAgreements.every((agreement) => agreement.state === 'signed');
  const cannotSign = serviceAgreements.every((agreement) => !agreement.canSign && agreement.state !== 'signed');

  if (allSigned) {
    return (
      <div data-glass="card" data-testid="service-agreement-signed" style={estimateCard()}>
        <div style={heading}>{serviceAgreements.length > 1 ? 'Service agreements signed' : 'Service agreement signed'}</div>
        <div style={body}>Thank you for signing. Your signed copy is in your Waves account under Documents.</div>
      </div>
    );
  }

  if (cannotSign) {
    return (
      <div data-glass="card" data-testid="service-agreement-call" style={estimateCard()}>
        <div style={heading}>Your service agreement</div>
        <div style={body}>Call us at {callLink} and we will set up your account and finish your agreement with you.</div>
      </div>
    );
  }

  return (
    <div data-glass="card" data-testid="service-agreement-sign" style={estimateCard()}>
      <div style={heading}>{serviceAgreements.length > 1 ? 'Your service agreements' : 'Your service agreement'}</div>
      <div style={body}>
        Review and sign online. Nothing about your visit, price or payment changes when you sign, and your signed copy is kept in your Waves account.
      </div>
      {serviceAgreements.map((agreement) => {
        const busy = busyLane === agreement.lane;
        if (agreement.state === 'signed') {
          return (
            <p key={agreement.lane} data-testid={`service-agreement-${agreement.lane}-signed`} style={{ ...body, margin: '16px 0 0' }}>
              {agreement.title}: signed.
            </p>
          );
        }
        return (
          <button
            key={agreement.lane}
            type="button"
            data-testid={`service-agreement-${agreement.lane}`}
            onClick={() => start(agreement.lane)}
            disabled={busyLane !== null || !agreement.canSign}
            style={{
              marginTop: 16, padding: '16px 20px', background: COLORS.glassNavy, color: COLORS.white,
              border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              opacity: busyLane !== null ? 0.7 : 1, width: '100%',
            }}
          >
            {busy
              ? 'Opening your agreement…'
              : serviceAgreements.length > 1
                ? `${agreement.state === 'awaiting' ? 'Finish signing' : 'Review and sign'}: ${agreement.title}`
                : agreement.state === 'awaiting' ? 'Finish signing your service agreement' : SIGN_AGREEMENT_LABEL}
          </button>
        );
      })}
      {error ? (
        <p role="alert" style={{ ...body, fontSize: 14, color: W.red, margin: '10px 0 0' }}>{error}</p>
      ) : null}
    </div>
  );
}
