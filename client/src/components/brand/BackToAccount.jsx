import React from 'react';
import { ChevronLeft, Home } from 'lucide-react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { isNativeApp, hasSessionToken } from '../../native/platform';
import { useWavesShell } from './WavesShellContext';

// A way back to the signed-in account from the standalone customer pages
// (pay, receipt, reschedule, secure, track, appointment, moving, rate).
//
// The Capacitor shell has no address bar or Back button, so a customer who
// taps Pay or Reschedule inside the app lands on a page with no way home.
// Shown ONLY in the native app AND with a customer session, and NEVER inside
// a locked WavesShell (Book at the Table hand-off: the person holding the
// owner's phone must not leave the page).
export function useShowBackToAccount() {
  const { locked } = useWavesShell();
  return !locked && isNativeApp() && signedInSafe();
}

function goHome(navigate, event) {
  // A modified or non-primary click (new tab, new window) keeps the browser's own behavior.
  const plain = event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  if (navigate && plain) {
    event.preventDefault();
    navigate('/');
  }
  // Without a router the plain href="/" does a full load of the portal home.
}

function RouterBackLink(props) {
  const navigate = useNavigate();
  return <BackLink {...props} navigate={navigate} />;
}

function BackLink({ navigate, variant, tone }) {
  if (variant === 'header') {
    return (
      <a
        href="/"
        aria-label="Back to my account"
        data-testid="back-to-account"
        onClick={(e) => goHome(navigate, e)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 2,
          color: tone === 'light' ? 'rgba(255, 255, 255, 0.9)' : 'var(--text)',
          textDecoration: 'none', fontSize: 15, fontWeight: 600, lineHeight: 1,
          // ~44px hit area without changing the bar's rhythm.
          padding: '12px 8px 12px 0', margin: '-12px 0',
        }}
      >
        <ChevronLeft size={20} strokeWidth={2.25} aria-hidden="true" />
        <span>My account</span>
      </a>
    );
  }
  return (
    <a
      href="/"
      data-testid="back-to-account"
      data-glass-accent=""
      data-glass-size="primary"
      onClick={(e) => goHome(navigate, e)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        minHeight: 48, marginTop: 20, padding: '0 20px', boxSizing: 'border-box',
        width: '100%', borderRadius: 'var(--radius-md, 10px)',
        border: '1px solid var(--border-strong, #cbd5e1)',
        background: 'var(--surface, #fff)', color: 'var(--brand, #0b5cab)',
        fontFamily: "'Inter', system-ui, sans-serif", fontSize: 16, fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      <Home size={16} aria-hidden="true" /> Back to my account
    </a>
  );
}

function Link(props) {
  return useInRouterContext() ? <RouterBackLink {...props} /> : <BackLink {...props} navigate={null} />;
}

/** Compact control for the WavesShell top bar. Renders null unless it should show. */
export function HeaderBackToAccount({ tone }) {
  const show = useShowBackToAccount();
  return show ? <Link variant="header" tone={tone} /> : null;
}

/** Full-width button for success / terminal states. Renders null unless it should show. */
export default function BackToAccountButton() {
  const show = useShowBackToAccount();
  return show ? <Link variant="button" /> : null;
}

function RouterHomeAnchor(props) {
  const navigate = useNavigate();
  return <HomeAnchor {...props} navigate={navigate} />;
}

function HomeAnchor({ navigate, children, ...rest }) {
  return <a {...rest} href="/" onClick={(e) => goHome(navigate, e)}>{children}</a>;
}

/**
 * A link to the account home that stays inside the app (router navigation, so
 * no reload and no second Face ID unlock); a full load only outside a router.
 */
export function AccountHomeLink(props) {
  return useInRouterContext() ? <RouterHomeAnchor {...props} /> : <HomeAnchor {...props} navigate={null} />;
}

/** Signed-in check that never throws (blocked browser storage = signed out). */
export function signedInSafe() {
  try { return hasSessionToken(); } catch { return false; }
}
