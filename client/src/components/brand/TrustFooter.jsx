import React from 'react';
import { WAVES_FL_LICENSE_LINE } from '../../constants/business';

const YEAR = new Date().getFullYear();
const RIGHTS_LINE = `© ${YEAR} Waves Pest Control, LLC. All rights reserved.`;
const TRUST_LINE = `Licensed & insured · ${WAVES_FL_LICENSE_LINE} · Backed by the Waves Guarantee`;
// Same URLs the quote wizard's consent line links to.
const PRIVACY_URL = 'https://wavespestcontrol.com/privacy-policy/';
const TERMS_URL = 'https://wavespestcontrol.com/terms-of-service/';

export default function TrustFooter({ tone = 'dark', align = 'center', variant = 'customer' }) {
  const color =
    tone === 'light' ? 'rgba(255, 255, 255, 0.6)' : 'var(--text-subtle)';
  const linkColor =
    tone === 'light' ? 'rgba(255, 255, 255, 0.85)' : 'var(--text-body, inherit)';

  const base = {
    width: '100%',
    padding: '24px 16px',
    textAlign: align,
    color,
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 'var(--text-xs)',
    fontWeight: 400,
    lineHeight: 1.5,
  };

  // Admin variant keeps the single internal-system line per spec §7.2.
  if (variant === 'admin') {
    return (
      <footer role="contentinfo" style={base}>
        Internal system · Waves Pest Control, LLC
      </footer>
    );
  }

  const link = { color: linkColor, fontWeight: 500, textDecoration: 'none', whiteSpace: 'nowrap' };

  return (
    <footer role="contentinfo" style={base}>
      <div style={{ marginBottom: 4 }}>
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={link}>Privacy Policy</a>
        <span aria-hidden="true" style={{ margin: '0 6px' }}>·</span>
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={link}>Terms of Service</a>
      </div>
      <div>{RIGHTS_LINE}</div>
      <div>{TRUST_LINE}</div>
    </footer>
  );
}
