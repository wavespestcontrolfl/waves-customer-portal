import { quoteRequiredReasonText } from '../../lib/quoteDisplay';
import { estimateCard, estimateInnerBox } from './cardStyles';
import { W } from './tokens';

/**
 * Rendered in place of the slider / picker / CTAs when the estimate is
 * in a terminal state (accepted / declined / expired). Polite,
 * actionable — gives the customer a next step (call us, view invoice
 * if applicable) rather than a dead end. An accepted estimate with a
 * booked upcoming visit shows the visit date instead of "we'll follow
 * up" — they booked; we'll see them at the appointment.
 */

const WAVES_PHONE = '(941) 297-5749';
const WAVES_TEL = '+19412975749';

export default function TerminalStateCard({ state, customerFirstName, address, quoteReason, isProposal = false, proposalPdfEmailed = false, appointmentLabel = null, appointmentServiceType = null }) {
  const who = customerFirstName || 'there';
  // A commercial risk-type hold is an internal classification step (the account
  // manager sets the business type that drives the service cadence), NOT a
  // customer inspection — so it gets account-manager copy, like a proposal.
  const isRiskTypeReview = !isProposal && quoteReason === 'commercial_risk_type_review';
  // A commercial low-confidence hold (the ±20% range is too wide to show) is a
  // site-confirmation step, not a customer inspection — also account-manager copy.
  const isLowConfidence = !isProposal && quoteReason === 'commercial_low_confidence_site_confirmation';
  const isAccountManagerFinalize = isRiskTypeReview || isLowConfidence;
  // A commercial proposal is quote-required by design, but its copy is a formal
  // proposal + account-manager follow-up — not the generic "inspection required"
  // field-review state. Suppress the humanized reason badge for it (and the
  // account-manager holds, whose custom copy already explains the state).
  const quoteReasonText = isProposal || isAccountManagerFinalize || !quoteReason
    ? ''
    : quoteRequiredReasonText({ reason: quoteReason }, '');

  if (state === 'accepted') {
    return (
      <div style={{ ...estimateCard(), borderTop: `4px solid ${W.green}` }}>
        <div style={{ fontSize: 22, lineHeight: 1.3, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          Thanks, {who} — you're booked.
        </div>
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
          Your estimate for {address || 'your property'} is accepted.
        </div>
        {appointmentLabel ? (
          <div style={estimateInnerBox({ marginTop: 16, padding: '16px 16px' })}>
            <div style={{ fontSize: 12, fontWeight: 700, color: W.textCaption, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Your visit
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: W.blueDeeper, marginTop: 4, lineHeight: 1.3 }}>
              {appointmentLabel}
            </div>
            {appointmentServiceType ? (
              <div style={{ fontSize: 14, color: W.textBody, marginTop: 2 }}>{appointmentServiceType}</div>
            ) : null}
            <div style={{ fontSize: 14, color: W.green, fontWeight: 700, marginTop: 8 }}>
              See you then — nothing else to do.
            </div>
          </div>
        ) : null}
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55, marginTop: appointmentLabel ? 12 : 4 }}>
          {appointmentLabel
            ? <>Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.</>
            : <>Our team will follow up with the next steps. Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.</>}
        </div>
      </div>
    );
  }

  if (state === 'declined') {
    return (
      <div style={{ ...estimateCard(), borderTop: `4px solid ${W.red}` }}>
        <div style={{ fontSize: 20, lineHeight: 1.3, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          This estimate was declined.
        </div>
        <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
          Changed your mind, {who}? Give us a call and we'll put together a fresh quote.
        </div>
        <a href={`tel:${WAVES_TEL}`} style={{
          display: 'inline-block', marginTop: 16, padding: '12px 20px',
          background: W.blueBright, color: W.white, textDecoration: 'none',
          borderRadius: 12, fontWeight: 600, fontSize: 15,
        }}>Call {WAVES_PHONE}</a>
      </div>
    );
  }

  if (state === 'quote_required') {
    return (
      <div style={{ ...estimateCard(), borderTop: '4px solid #F97316' }}>
        <div style={{ fontSize: 20, lineHeight: 1.3, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
          {isProposal
            ? 'Your formal proposal is ready.'
            : isAccountManagerFinalize
            ? 'Your account manager will finalize this.'
            : 'This treatment needs an inspection.'}
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
          ) : isLowConfidence ? (
            <>
              Hi {who} — we just need a quick site confirmation to finalize this commercial estimate. Your Waves
              account manager will confirm the price with you directly, so there's no online checkout for this one.
              Questions? Call <a href={`tel:${WAVES_TEL}`} style={{ color: W.blue }}>{WAVES_PHONE}</a>.
            </>
          ) : isRiskTypeReview ? (
            <>
              Hi {who} — this is a commercial service plan. Your Waves account manager will confirm the details
              with you and finalize it directly, so there's no online checkout for this one.
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
            padding: '12px 12px',
            border: '1px solid #FED7AA',
            borderRadius: 10,
            background: '#FFF7ED',
            color: W.noticeText,
            fontSize: 15,
            fontWeight: 700,
            lineHeight: 1.45,
          }}>
            {quoteReasonText}
          </div>
        ) : null}
        <a href={`tel:${WAVES_TEL}`} style={{
          display: 'inline-block', marginTop: 16, padding: '12px 20px',
          background: W.blueBright, color: W.white, textDecoration: 'none',
          borderRadius: 12, fontWeight: 600, fontSize: 15,
        }}>Call {WAVES_PHONE}</a>
      </div>
    );
  }

  // expired (or anything else)
  return (
    <div style={{ ...estimateCard(), borderTop: `4px solid ${W.textCaption}` }}>
      <div style={{ fontSize: 20, lineHeight: 1.3, fontWeight: 600, color: W.navy, marginBottom: 8 }}>
        This estimate has expired.
      </div>
      <div style={{ fontSize: 15, color: W.textBody, lineHeight: 1.55 }}>
        Hi {who} — prices for {address || 'your property'} have shifted since we wrote this quote.
        Give us a minute on the phone and we'll refresh the numbers.
      </div>
      <a href={`tel:${WAVES_TEL}`} style={{
        display: 'inline-block', marginTop: 16, padding: '12px 20px',
        background: W.blueBright, color: W.white, textDecoration: 'none',
        borderRadius: 12, fontWeight: 600, fontSize: 15,
      }}>Call {WAVES_PHONE}</a>
    </div>
  );
}
