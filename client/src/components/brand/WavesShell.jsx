import React from 'react';
import HelpPhoneLink from './HelpPhoneLink';
import HeaderStoreLinks from './HeaderStoreLinks';
import TrustFooter from './TrustFooter';
import { WavesShellContext } from './WavesShellContext';

// Page chrome for customer + admin surfaces.
//
// Top bar layout (owner spec 2026-07-06): App Store / Google Play icon
// links on the LEFT, Waves logo CENTERED, phone CTA on the RIGHT.
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
    // Sticky (owner 2026-07-06) — the bar stays pinned while scrolling.
    position: isTransparent ? 'absolute' : 'sticky',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    background: isTransparent ? 'transparent' : 'var(--surface)',
    borderBottom: isTransparent ? 'none' : '1px solid var(--border)',
    // viewport-fit=cover: keep the bar's content below a notch/status bar.
    paddingTop: 'env(safe-area-inset-top, 0px)',
  };

  return (
    <WavesShellContext.Provider value={{ variant, inShell: true }}>
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
        {/* First focusable element: hidden-until-focus skip link past the
            header chrome (styles in index.css). */}
        <a href="#waves-shell-main" className="waves-skip-link">Skip to content</a>
        {/* data-waves-shell-header: EstimateGlassTheme's classify walker must
            NOT pill-compact the standard shell bar (it hides the icon row
            behind the centered logo). */}
        <header data-waves-shell-header="" style={topBarStyle}>
          <nav aria-label="Waves" style={{
            width: 'min(100%, 1120px)',
            margin: '0 auto',
            padding: '14px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            boxSizing: 'border-box',
            position: 'relative',
          }}>
            {/* Logo first in DOM so reading order matches the visual
                hierarchy; absolute positioning keeps the flex layout of the
                in-flow store links + phone CTA unchanged. */}
            <img
              src="/waves-logo.png"
              alt="Waves"
              style={{
                height: 36, display: 'block',
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                filter: isTransparent ? 'brightness(0) invert(1)' : 'none',
              }}
            />
            <HeaderStoreLinks tone={phoneTone} />
            {/* marginLeft:auto keeps the phone CTA on the right even when
                HeaderStoreLinks renders null inside the native app (the
                logo is absolutely positioned, so space-between alone would
                pull the lone in-flow child to the left edge). */}
            <span style={{ marginLeft: 'auto' }}>
              <HelpPhoneLink tone={phoneTone} />
            </span>
          </nav>
        </header>
        {/* The ONE main landmark for every shell-wrapped page, in every
            state (loading/error included) — wrapped pages must not render
            their own <main>. Also the .waves-skip-link target. */}
        <main id="waves-shell-main" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
        {showFooter && (
          <TrustFooter tone={resolvedFooterTone} variant={variant} />
        )}
      </div>
    </WavesShellContext.Provider>
  );
}
