import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { isNativeApp } from '../../native/platform';
import { getAdminAuthToken } from '../../lib/adminAuth';
import AddToHomeScreenHint from './AddToHomeScreenHint';
import { FIELD_BOOKMARK_META } from '../../lib/adminBookmarkMeta';

// The standalone /tech portal shell is retired: the field workspace lives at
// /admin/today. Installed PWAs, push notifications and old bookmarks still open
// /tech/*, so every such URL maps to its /admin/today equivalent forever.
export function techToTodayPath(pathname) {
  const rest = pathname.replace(/^\/tech/i, '').replace(/\/+$/, '');
  return `/admin/today${rest}`;
}

// While the signed-out landing is mounted the document carries the Field Tools
// identity, so Add to Home Screen installs the field app even after a Back
// from the sign-in page restored the customer defaults (Codex #5573 r16).
function useFieldInstallIdentity(active) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const manifest = document.querySelector('link[rel="manifest"]');
    const meta = (name) => document.querySelector(`meta[name="${name}"]`);
    const before = {
      manifest: manifest?.getAttribute('href'),
      appTitle: meta('apple-mobile-web-app-title')?.getAttribute('content'),
      themeColor: meta('theme-color')?.getAttribute('content'),
      title: document.title,
    };
    manifest?.setAttribute('href', FIELD_BOOKMARK_META.manifest);
    meta('apple-mobile-web-app-title')?.setAttribute('content', FIELD_BOOKMARK_META.appTitle);
    meta('theme-color')?.setAttribute('content', FIELD_BOOKMARK_META.themeColor);
    document.title = FIELD_BOOKMARK_META.documentTitle;
    return () => {
      if (before.manifest != null) manifest?.setAttribute('href', before.manifest);
      if (before.appTitle != null) meta('apple-mobile-web-app-title')?.setAttribute('content', before.appTitle);
      if (before.themeColor != null) meta('theme-color')?.setAttribute('content', before.themeColor);
      document.title = before.title;
    };
  }, [active]);
}

export default function TechPortalRedirect() {
  const { pathname, search, hash } = useLocation();
  // Reactive to a sign-in (or out) in another tab, as the retired shell was:
  // the landing then redirects to /admin/today (Codex #5573 r18).
  const [hasToken, setHasToken] = useState(() => !!getAdminAuthToken());
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === null || event.key === 'waves_admin_token') setHasToken(!!getAdminAuthToken());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const signedOutLanding = !isNativeApp() && !hasToken;
  useFieldInstallIdentity(signedOutLanding);
  if (isNativeApp()) return <Navigate to="/" replace />;
  const target = `${techToTodayPath(pathname)}${search}${hash}`;
  // Signed out: stay on this field-branded page (the server renders the
  // Field Tools manifest for /tech) so a new technician can Add to Home
  // Screen before signing in, as the retired /tech shell allowed (Codex
  // #5573 r10). The installed app starts at /admin/today.
  if (signedOutLanding) {
    return (
      // Standalone PWA under viewport-fit=cover: clear the notch / status bar
      // like the retired shell did (Codex #5573 r14).
      <div style={{ minHeight: '100vh', padding: 24, paddingTop: 'calc(24px + env(safe-area-inset-top, 0px))', background: '#0f1923', color: '#e2e8f0', fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 24, margin: '8px 0 16px' }}>Waves Field Tools</h1>
        <AddToHomeScreenHint />
        <Link to={`/admin/login?next=${encodeURIComponent(target)}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '10px 16px', borderRadius: 8, background: '#e2e8f0', color: '#0f1923', fontSize: 16, fontWeight: 700, textDecoration: 'none' }}>
          Sign in
        </Link>
      </div>
    );
  }
  return <Navigate to={target} replace />;
}
