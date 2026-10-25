import { useEffect, useRef, useState } from 'react';
import { COLORS } from '../../theme-brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../../constants/business';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export const NOTICE_BUTTON_LABEL = 'Read and sign the notice';
export const CONSUMER_NOTICE_HINT = 'Sign the Florida consumer notice above to accept.';

/**
 * The hint under which every accept control is held off while the notice is unsigned. `blocked` is the page's one
 * shared flag (cta.consumerNotice present and not signed).
 */
export function ConsumerNoticeHint({ blocked }) {
  if (!blocked) return null;
  return <p data-testid="consumer-notice-hint" style={{ fontSize: 14, lineHeight: 1.5, color: W.textBody, margin: '0 0 12px' }}>{CONSUMER_NOTICE_HINT}</p>;
}

/**
 * The Florida consumer notice (GATE_ESTIMATE_CONSUMER_NOTICE, Rule 5E-14.105(1)). `consumerNotice` is /data's
 * cta.consumerNotice: { state: 'none' | 'awaiting' | 'signed', canSign, reason? }, absent unless the server asks for
 * the notice, so this renders nothing otherwise.
 *
 * The tap POSTs /:token/consumer-notice, which issues (or re-opens) the FDACS-13692 form and returns its signing
 * URL; this page then hands the customer to that existing signing page in the same tab.
 */
export default function ConsumerNoticeSign({ token, consumerNotice }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A tap leaves the button busy while the signing page loads. Back on this page from the browser's cache (the
  // customer left without signing), it works again.
  useEffect(() => {
    const onPageShow = (event) => {
      if (!event.persisted) return;
      inFlight.current = false;
      setBusy(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  if (!consumerNotice) return null;
  const { canSign, state } = consumerNotice;

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    // Only the server's own 409 wording (already signed, no account, no representative) is shown as is.
    let serverMessage = '';
    try {
      const response = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/consumer-notice`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.signingUrl) {
        if (response.status === 409 && body.error) serverMessage = body.error;
        throw new Error('request_failed');
      }
      window.location.assign(body.signingUrl);
    } catch {
      setError(serverMessage || `We couldn’t open the notice. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
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
    return (
      <div data-testid="consumer-notice-signed" style={estimateCard()}>
        <div style={heading}>Consumer notice signed</div>
        <div style={body}>Thank you. You can accept your estimate below.</div>
      </div>
    );
  }

  if (!canSign) {
    return (
      <div data-testid="consumer-notice-call" style={estimateCard()}>
        <div style={heading}>Florida consumer notice</div>
        <div style={body}>Call us at {callLink} and we will finish the notice with you.</div>
      </div>
    );
  }

  return (
    <div data-testid="consumer-notice-sign" style={estimateCard()}>
      <div style={heading}>Florida consumer notice</div>
      <div style={body}>
        {state === 'awaiting'
          ? 'Your consumer notice is ready for your signature. Pick up where you left off.'
          : 'Florida law asks you to read and sign the state’s Consumer Notice Form (FDACS-13692) before you accept a termite treatment. It takes about a minute.'}
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
        {busy ? 'Opening the notice…' : NOTICE_BUTTON_LABEL}
      </button>
      {error ? (
        <p role="alert" style={{ ...body, fontSize: 14, color: W.red, margin: '10px 0 0' }}>{error}</p>
      ) : null}
    </div>
  );
}
