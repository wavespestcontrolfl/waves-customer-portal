import { Link, Navigate, useLocation } from 'react-router-dom';
import { isNativeApp } from '../../native/platform';
import { getAdminAuthToken } from '../../lib/adminAuth';
import AddToHomeScreenHint from './AddToHomeScreenHint';

// The standalone /tech portal shell is retired: the field workspace lives at
// /admin/today. Installed PWAs, push notifications and old bookmarks still open
// /tech/*, so every such URL maps to its /admin/today equivalent forever.
export function techToTodayPath(pathname) {
  const rest = pathname.replace(/^\/tech/i, '').replace(/\/+$/, '');
  return `/admin/today${rest}`;
}

export default function TechPortalRedirect() {
  const { pathname, search, hash } = useLocation();
  if (isNativeApp()) return <Navigate to="/" replace />;
  const target = `${techToTodayPath(pathname)}${search}${hash}`;
  // Signed out: stay on this field-branded page (the server renders the
  // Field Tools manifest for /tech) so a new technician can Add to Home
  // Screen before signing in, as the retired /tech shell allowed (Codex
  // #5573 r10). The installed app starts at /admin/today.
  if (!getAdminAuthToken()) {
    return (
      <div style={{ minHeight: '100vh', padding: 24, background: '#0f1923', color: '#e2e8f0', fontFamily: "'DM Sans', system-ui, sans-serif" }}>
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
