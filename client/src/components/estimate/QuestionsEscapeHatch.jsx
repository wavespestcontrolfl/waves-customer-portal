/**
 * Questions escape hatch for customers who aren't ready to accept —
 * mirrors the SSR estimate's q-bar pair: a solid navy "Questions? Call
 * Waves" button and a warm-light "Questions? Text Waves!" button. The
 * text button sends an SMS on mobile and falls back to email on desktop.
 */
import { glassCopyActive, GLASS_COPY } from '../../lib/estimate-glass-copy';
import { W } from './tokens';


const BUSINESS_LINE = '+19412975749';
const BUSINESS_EMAIL = 'contact@wavespestcontrol.com';

function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent || '');
}

const BTN_BASE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  minHeight: 48, padding: '12px 16px', borderRadius: 10,
  fontSize: 14, fontWeight: 600, textDecoration: 'none', lineHeight: 1.2,
};

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export default function QuestionsEscapeHatch({ estimateSlug, context = 'estimate' }) {
  // Glass copy pack (PR B) — person-first button labels.
  const glass = glassCopyActive();
  // context 'lawn_report': the lawn-diagnostic page reuses this component,
  // and the estimate copy composed "question about quote #<report token>" —
  // a report token isn't a quote number.
  const isReport = context === 'lawn_report';
  const slugStr = estimateSlug ? `%23${estimateSlug}` : 'my%20estimate';
  const smsBody = isReport
    ? 'Hi, I have a question about my Waves lawn report'
    : `Hi, I have a question about quote ${slugStr}`;
  const mailSubject = isReport ? 'Question about my Waves lawn report' : 'Question about my Waves estimate';
  const mailBody = isReport
    ? 'Hi, I have a question about my Waves lawn report'
    : `Hi, I have a question about quote ${decodeURIComponent(slugStr)}`;
  const textHref = isLikelyMobile()
    ? `sms:${BUSINESS_LINE}?&body=${smsBody}`
    : `mailto:${BUSINESS_EMAIL}?subject=${mailSubject}&body=${mailBody}`;

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12,
      marginTop: 24, marginBottom: 8,
    }}>
      {/* Under glass both buttons render as the standard gold section-CTA
          pill (owner 2026-07-06: "render like the rest"); the legacy
          navy/warm pair only survives on non-glass renders. */}
      <a
        href={`tel:${BUSINESS_LINE}`}
        aria-label="Call Waves at (941) 297-5749"
        className={glass ? 'gc-section-cta' : undefined}
        style={glass ? { ...BTN_BASE, background: undefined } : { ...BTN_BASE, background: W.blueDeeper, color: W.white }}
      >
        <PhoneIcon />
        {glass ? GLASS_COPY.callButton : 'Questions? Call Waves'}
      </a>
      <a
        href={textHref}
        aria-label="Text Waves at (941) 297-5749"
        className={glass ? 'gc-section-cta' : undefined}
        style={glass ? { ...BTN_BASE, background: undefined } : { ...BTN_BASE, background: W.warmBg, color: W.blueDeeper, border: `1px solid ${W.warmBorder}` }}
      >
        <ChatIcon />
        {glass ? GLASS_COPY.textButton : 'Questions? Text Waves!'}
      </a>
    </div>
  );
}
