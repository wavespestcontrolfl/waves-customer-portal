/**
 * Rendered in place of the slider / picker / CTAs when the estimate is
 * in a terminal state (accepted / declined / expired). Polite,
 * actionable — gives the customer a next step (call us, view invoice
 * if applicable) rather than a dead end.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  green: '#16A34A', red: '#C8102E',
  yellow: '#FFD700', navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1',
};

const WAVES_PHONE = '(941) 318-7612';
const WAVES_TEL = '+19413187612';

export default function TerminalStateCard({ state, customerFirstName, address }) {
  const who = customerFirstName || 'there';

  if (state === 'accepted') {
    return (
      <div style={{
        background: W.white, borderRadius: 16, padding: 24,
        borderTop: `4px solid ${W.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          Thanks, {who} — you're booked.
        </div>
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
          Your estimate for {address || 'your property'} is accepted. Check your phone for the onboarding link
          we just sent. Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.
        </div>
      </div>
    );
  }

  if (state === 'declined') {
    return (
      <div style={{
        background: W.white, borderRadius: 16, padding: 24,
        borderTop: `4px solid ${W.red}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          This estimate was declined.
        </div>
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
          Changed your mind, {who}? Give us a call and we'll put together a fresh quote.
        </div>
        <a href={`tel:${WAVES_TEL}`} style={{
          display: 'inline-block', marginTop: 14, padding: '12px 20px',
          background: W.blueBright, color: W.white, textDecoration: 'none',
          borderRadius: 12, fontWeight: 600, fontSize: 15,
        }}>Call {WAVES_PHONE}</a>
      </div>
    );
  }

  // expired (or anything else)
  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      borderTop: `4px solid ${W.textCaption}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
        This estimate has expired.
      </div>
      <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
        Hi {who} — prices for {address || 'your property'} have shifted since we wrote this quote.
        Give us a minute on the phone and we'll refresh the numbers.
      </div>
      <a href={`tel:${WAVES_TEL}`} style={{
        display: 'inline-block', marginTop: 14, padding: '12px 20px',
        background: W.blueBright, color: W.white, textDecoration: 'none',
        borderRadius: 12, fontWeight: 600, fontSize: 15,
      }}>Call {WAVES_PHONE}</a>
    </div>
  );
}
