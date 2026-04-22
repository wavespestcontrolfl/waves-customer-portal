import React from 'react';
import WavesMark from './WavesMark';
import HelpPhoneLink from './HelpPhoneLink';
import TrustFooter from './TrustFooter';
import { WavesShellContext } from './WavesShellContext';

// Page chrome for customer + admin surfaces.
//
// variant="customer" → brand-navy mark, trust footer, guarantee line.
// variant="admin"    → neutral-gray mark, stripped footer ("Internal system ...").
// topBar="solid"     → surface-on-page top bar (default).
// topBar="transparent" → transparent top bar for /login video hero; mark + phone
//                        reverse to white.
export default function WavesShell({
  children,
  variant = 'customer',
  topBar = 'solid',
  showFooter = true,
  footerTone,
}) {
  const isAdmin = variant === 'admin';
  const isTransparent = topBar === 'transparent';
  const markFill = isAdmin ? 'var(--text-muted)' : 'var(--brand)';
  const phoneTone = isTransparent ? 'light' : 'dark';
  const resolvedFooterTone = footerTone || (isTransparent ? 'light' : 'dark');

  const topBarStyle = {
    position: isTransparent ? 'absolute' : 'relative',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 24px',
    background: isTransparent ? 'transparent' : 'var(--surface)',
    borderBottom: isTransparent ? 'none' : '1px solid var(--border)',
  };

  const logoWrapStyle = {
    display: 'inline-flex',
    alignItems: 'center',
  };

  return (
    <WavesShellContext.Provider value={{ variant }}>
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--page)',
          color: 'var(--text)',
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        <header style={topBarStyle}>
          <div style={logoWrapStyle}>
            <WavesMark size={28} fill={markFill} />
          </div>
          <HelpPhoneLink tone={phoneTone} />
        </header>
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
        {showFooter && (
          <TrustFooter tone={resolvedFooterTone} variant={variant} />
        )}
      </div>
    </WavesShellContext.Provider>
  );
}
