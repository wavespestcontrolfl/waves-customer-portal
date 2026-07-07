/**
 * Questions escape hatch for customers who aren't ready to accept — a
 * single "Text us" button (owner 2026-07-07: the call button is gone from
 * customer surfaces). It sends an SMS on mobile and falls back to email
 * on desktop.
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
  // Plain text here; encode only at URL construction — a raw "#" in a
  // mailto/sms URL starts the fragment and truncates the body before the
  // quote number.
  const bodyText = isReport
    ? 'Hi, I have a question about my Waves lawn report'
    : `Hi, I have a question about quote ${estimateSlug ? `#${estimateSlug}` : 'my estimate'}`;
  const mailSubject = isReport ? 'Question about my Waves lawn report' : 'Question about my Waves estimate';
  const textHref = isLikelyMobile()
    ? `sms:${BUSINESS_LINE}?&body=${encodeURIComponent(bodyText)}`
    : `mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(bodyText)}`;

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12,
      marginTop: 24, marginBottom: 8,
    }}>
      {/* Under glass the button renders as the standard gold section-CTA
          pill (owner 2026-07-06: "render like the rest"); the legacy warm
          styling only survives on non-glass renders. */}
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
