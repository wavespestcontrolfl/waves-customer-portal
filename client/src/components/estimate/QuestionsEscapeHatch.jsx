/**
 * Single-button escape hatch for customers who have questions before
 * accepting. SMS link on mobile, mailto fallback for desktop.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1',
};

const BUSINESS_LINE = '+19413187612';
const BUSINESS_EMAIL = 'contact@wavespestcontrol.com';

function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent || '');
}

export default function QuestionsEscapeHatch({ estimateSlug }) {
  const slugStr = estimateSlug ? `%23${estimateSlug}` : 'my%20estimate';
  const smsBody = `Hi, I have a question about quote ${slugStr}`;
  const href = isLikelyMobile()
    ? `sms:${BUSINESS_LINE}?&body=${smsBody}`
    : `mailto:${BUSINESS_EMAIL}?subject=Question about my Waves estimate&body=Hi, I have a question about quote ${decodeURIComponent(slugStr)}`;

  return (
    <div style={{ textAlign: 'center', marginTop: 24, marginBottom: 8 }}>
      <a
        href={href}
        style={{
          display: 'inline-block', padding: '12px 20px',
          background: 'transparent', color: W.blue,
          border: `1px solid ${W.border}`, borderRadius: 12,
          textDecoration: 'none', fontSize: 14, fontWeight: 600,
        }}
      >
        Text us about this quote
      </a>
    </div>
  );
}
