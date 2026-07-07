import React from 'react';
import { Phone, Globe, CircleUserRound } from 'lucide-react';

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

  // Prominent header slot: icon-only row — phone, email, website, portal
  // (owner spec 2026-07-06: no phone-number text in the header). aria-labels
  // + titles carry the accessible names.
  // 12px padding + compensating margin = ~40px hit areas without changing
  // the visual rhythm (touch-target audit 2026-07-06).
  const iconLink = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color, lineHeight: 1, textDecoration: 'none', padding: 12, margin: -12 };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
      <a href={HELP_TEL} aria-label={`Call Waves ${HELP_NUMBER}`} title={HELP_NUMBER} style={iconLink}>
        <Phone size={16} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      </a>
      <a href={HELP_MAILTO} aria-label="Email Waves" title="Email us" style={iconLink}>
        <MailFilledIcon />
      </a>
      <a href="https://www.wavespestcontrol.com" target="_blank" rel="noopener noreferrer" aria-label="Visit wavespestcontrol.com" title="wavespestcontrol.com" style={iconLink}>
        <Globe size={16} strokeWidth={2.25} aria-hidden="true" />
      </a>
      <a href="/" aria-label="Customer portal" title="Customer portal" style={iconLink}>
        <CircleUserRound size={17} strokeWidth={2.25} aria-hidden="true" />
      </a>
    </span>
  );
}
