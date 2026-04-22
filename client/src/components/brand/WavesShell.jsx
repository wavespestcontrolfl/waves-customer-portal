import React from 'react';
import HelpPhoneLink from './HelpPhoneLink';
import TrustFooter from './TrustFooter';
import { WavesShellContext } from './WavesShellContext';

// Page chrome for customer + admin surfaces.
//
// Top bar layout: phone on the LEFT, full Waves logo (PNG wordmark,
// shared with the admin shell) on the RIGHT.
//
// variant="customer" → standard top bar, trust footer, guarantee line.
// variant="admin"    → neutral tone, stripped footer ("Internal system ...").
// topBar="solid"     → surface-on-page top bar (default).
// topBar="transparent" → transparent top bar for /login video hero; phone
//                        reverses to white.
export default function WavesShell({
  children,
  variant = 'customer',
  topBar = 'solid',
  showFooter = true,
  footerTone,
}) {
  const isTransparent = topBar === 'transparent';
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
          <HelpPhoneLink tone={phoneTone} />
          <img
            src="/waves-logo.png"
            alt="Waves"
            style={{ height: 28, display: 'block', filter: isTransparent ? 'brightness(0) invert(1)' : 'none' }}
          />
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
