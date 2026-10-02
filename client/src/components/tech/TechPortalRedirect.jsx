import { Navigate, useLocation } from 'react-router-dom';
import { isNativeApp } from '../../native/platform';

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
  return <Navigate to={`${techToTodayPath(pathname)}${search}${hash}`} replace />;
}
