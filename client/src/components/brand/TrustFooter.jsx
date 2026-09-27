import React, { useSyncExternalStore } from 'react';
import { WAVES_FL_LICENSE_LINE } from '../../constants/business';

const YEAR = new Date().getFullYear();
const RIGHTS_LINE = `© ${YEAR} Waves Pest Control, LLC. All rights reserved.`;
const TRUST_LINE = `Licensed & insured · ${WAVES_FL_LICENSE_LINE} · Backed by the Waves Guarantee`;
const NO_GUARANTEE_TRUST_LINE = `Licensed & insured · ${WAVES_FL_LICENSE_LINE} · Written estimate scope and terms apply`;
// Same URLs the quote wizard's consent line links to.
const PRIVACY_URL = 'https://wavespestcontrol.com/privacy-policy/';
const TERMS_URL = 'https://wavespestcontrol.com/terms-of-service/';

// EstimateViewPage is rendered inside WavesShell, while this footer is the
// shell's sibling below it. This tiny external store carries the loaded
// estimate's guarantee decision across that boundary without changing the
// universal shell contract or affecting any other route.
let estimateNoGuarantee = false;
const estimateTrustListeners = new Set();

export function setEstimateTrustFooterNoGuarantee(value) {
  const next = value === true;
  if (next === estimateNoGuarantee) return;
  estimateNoGuarantee = next;
  estimateTrustListeners.forEach((listener) => listener());
}

function subscribeEstimateTrust(listener) {
  estimateTrustListeners.add(listener);
  return () => estimateTrustListeners.delete(listener);
}

function estimateTrustSnapshot() {
  return estimateNoGuarantee;
}

export default function TrustFooter({ tone = 'dark', align = 'center', variant = 'customer', noGuarantee }) {
  const estimateNoGuaranteeSnapshot = useSyncExternalStore(
    subscribeEstimateTrust,
    estimateTrustSnapshot,
    () => false,
  );
  const omitGuarantee = typeof noGuarantee === 'boolean' ? noGuarantee : estimateNoGuaranteeSnapshot;
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
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1.5,
  };

  // Admin variant keeps the single internal-system line per spec §7.2.
  // Plain blocks: WavesShell's <footer role="contentinfo"> is the landmark.
  if (variant === 'admin') {
    return (
      <div style={base}>
        Internal system · Waves Pest Control, LLC
      </div>
    );
  }

  const link = { color: linkColor, fontWeight: 500, textDecoration: 'none', whiteSpace: 'nowrap' };

  return (
    <div style={base}>
      <div style={{ marginBottom: 4 }}>
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={link}>Privacy Policy</a>
        <span aria-hidden="true" style={{ margin: '0 6px' }}>·</span>
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={link}>Terms of Service</a>
      </div>
      <div>{RIGHTS_LINE}</div>
      <div>{omitGuarantee ? NO_GUARANTEE_TRUST_LINE : TRUST_LINE}</div>
    </div>
  );
}
