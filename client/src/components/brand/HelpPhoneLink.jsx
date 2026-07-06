import React from 'react';
import { Phone } from 'lucide-react';

const HELP_NUMBER = '(941) 297-5749';
const HELP_TEL = 'tel:+19412975749';
const HELP_MAILTO = 'mailto:contact@wavespestcontrol.com';

// Filled envelope (lucide has no filled Mail variant; the flap is cut out
// so it reads as an envelope at 16px).
function MailFilledIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v.34l-10 6.25L2 6.34V6z" />
      <path d="M2 8.7V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8.7l-9.47 5.92a1 1 0 0 1-1.06 0L2 8.7z" />
    </svg>
  );
}

/**
 * Help phone link.
 *
 * Default ("prominent") variant: its own font-size + color + weight + a
 * leading phone icon. Right for header/chrome slots (WavesShell).
 *
 * `inline` variant: inherits font-family, size, color, weight, and
 * line-height from the surrounding paragraph so the phone number blends
 * into body copy ("Questions about this invoice? (941) 297-5749 or reply
 * to the text or email."). Drops the icon since it would throw off the
 * baseline inside running text.
 */
export default function HelpPhoneLink({ tone = 'dark', compact, inline = false }) {
  const color =
    tone === 'light' ? 'rgba(255, 255, 255, 0.9)' : 'var(--text)';

  if (inline) {
    return (
      <a
        href={HELP_TEL}
        style={{
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          lineHeight: 'inherit',
          textDecoration: 'underline',
          textUnderlineOffset: '2px',
          whiteSpace: 'nowrap',
        }}
      >
        {HELP_NUMBER}
      </a>
    );
  }

  // Prominent header slot: phone link (icon + number; the number hides at
  // compact widths via .help-phone-full) plus an icon-only email link. No
  // text fallback — icons carry the compact layout (owner spec 2026-07-06).
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
      <a
        href={HELP_TEL}
        aria-label={`Call Waves ${HELP_NUMBER}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color,
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 'var(--text-md)',
          fontWeight: 700,
          textDecoration: 'none',
          lineHeight: 1,
        }}
      >
        <Phone size={16} fill="currentColor" strokeWidth={0} aria-hidden="true" />
        <span className="help-phone-full" style={compact ? { display: 'none' } : {}}>
          {HELP_NUMBER}
        </span>
      </a>
      <a
        href={HELP_MAILTO}
        aria-label="Email Waves"
        style={{ display: 'inline-flex', alignItems: 'center', color, lineHeight: 1 }}
      >
        <MailFilledIcon />
      </a>
    </span>
  );
}
