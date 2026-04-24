import React from 'react';
import { Phone } from 'lucide-react';

const HELP_NUMBER = '(941) 297-5749';
const HELP_TEL = 'tel:+19412975749';

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

  return (
    <a
      href={HELP_TEL}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 'var(--text-md)',
        fontWeight: 500,
        textDecoration: 'none',
        lineHeight: 1,
      }}
    >
      <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="help-phone-full" style={compact ? { display: 'none' } : {}}>
        {HELP_NUMBER}
      </span>
      {compact && <span className="help-phone-compact">Need help?</span>}
    </a>
  );
}
