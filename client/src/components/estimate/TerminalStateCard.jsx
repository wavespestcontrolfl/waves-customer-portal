import { quoteRequiredReasonText } from '../../lib/quoteDisplay';

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

const WAVES_PHONE = '(941) 297-5749';
const WAVES_TEL = '+19412975749';

export default function TerminalStateCard({ state, customerFirstName, address, quoteReason, isProposal = false, proposalPdfEmailed = false }) {
  const who = customerFirstName || 'there';
  // A commercial proposal is quote-required by design, but its copy is a formal
  // proposal + account-manager follow-up — not the generic "inspection required"
  // field-review state. Suppress the humanized reason badge for it.
  const quoteReasonText = isProposal || !quoteReason ? '' : quoteRequiredReasonText({ reason: quoteReason }, '');

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
          Your estimate for {address || 'your property'} is accepted. Our team will follow up with the next steps.
          Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.
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

  if (state === 'quote_required') {
    return (
      <div style={{
        background: W.white, borderRadius: 16, padding: 24,
        borderTop: '#F97316 4px solid', boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          {isProposal ? 'Your formal proposal is ready.' : 'This treatment needs an inspection.'}
        </div>
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
          {isProposal ? (
            <>
              Hi {who} — {proposalPdfEmailed
                ? 'your formal proposal is attached as a PDF to the email we sent.'
                : 'your Waves account manager has your formal proposal and will share the PDF with you directly.'}{' '}
              There's no online checkout for a commercial bid — your account manager will follow up to finalize.
              Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.
            </>
          ) : (
            <>
              Hi {who} — this estimate includes a treatment that needs a custom quote before it can be accepted online.
              Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a> and we'll finish it with you.
            </>
          )}
        </div>
        {quoteReasonText ? (
          <div style={{
            marginTop: 12,
            padding: '10px 12px',
            border: '1px solid #FED7AA',
            borderRadius: 10,
            background: '#FFF7ED',
            color: '#92400E',
            fontSize: 15,
            fontWeight: 700,
            lineHeight: 1.45,
          }}>
            {quoteReasonText}
          </div>
        ) : null}
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
