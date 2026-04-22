import React from 'react';
import { Phone } from 'lucide-react';

const HELP_NUMBER = '(941) 297-5749';
const HELP_TEL = 'tel:+19412975749';

export default function HelpPhoneLink({ tone = 'dark', compact }) {
  const color =
    tone === 'light' ? 'rgba(255, 255, 255, 0.9)' : 'var(--text)';

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
