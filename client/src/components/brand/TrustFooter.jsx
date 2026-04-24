import React from 'react';

const YEAR = new Date().getFullYear();
const LEGAL_LINE = `© ${YEAR} Waves Pest Control, LLC · Licensed & insured · FL License #JB351547 · Backed by the Waves Guarantee`;

export default function TrustFooter({ tone = 'dark', align = 'center', variant = 'customer' }) {
  // Admin variant swaps the guarantee line for the internal-system line per spec §7.2.
  const text =
    variant === 'admin'
      ? 'Internal system · Waves Pest Control, LLC'
      : LEGAL_LINE;
  const color =
    tone === 'light' ? 'rgba(255, 255, 255, 0.6)' : 'var(--text-subtle)';

  return (
    <footer
      role="contentinfo"
      style={{
        width: '100%',
        padding: '24px 16px',
        textAlign: align,
        color,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 'var(--text-xs)',
        fontWeight: 400,
        lineHeight: 1.5,
      }}
    >
      {text}
    </footer>
  );
}
