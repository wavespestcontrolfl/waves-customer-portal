import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { getAdminAuthToken, getAdminDisplayName } from '../lib/adminAuth';
import AddToHomeScreenHint from './tech/AddToHomeScreenHint';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

// Messages tab dropped — /tech/messages had no underlying feature and
// the bottom-nav button dead-ended. Will return when the messaging
// surface actually exists.
const NAV_ITEMS = [
  { path: '/tech', icon: '📅', label: 'Route', exact: true },
  { path: '/tech/estimate', icon: '📋', label: 'Estimate' },
  { path: '/tech/protocols', icon: '📖', label: 'Protocols' },
];

export default function TechLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [techName, setTechName] = useState('Tech');
  const [authed, setAuthed] = useState(() => Boolean(getAdminAuthToken()));

  useEffect(() => {
    const token = getAdminAuthToken();
    setAuthed(Boolean(token));
    if (token) setTechName(getAdminDisplayName('Tech'));
  }, []);

  // While in the tech portal, point the PWA manifest + home-screen title at
  // the field app. The default manifest pins start_url to "/" (the customer
  // portal), so an "Add to Home Screen" install that honors the manifest start
  // URL would otherwise launch the tech into the customer app. manifest.tech
  // uses start_url "/tech" with scope "/" (kept broad so the /admin/login auth
  // hop stays in the standalone window instead of popping out to Safari).
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const link = document.querySelector('link[rel="manifest"]');
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const prevManifest = link?.getAttribute('href');
    const prevTitle = title?.getAttribute('content');
    link?.setAttribute('href', '/manifest.tech.json');
    title?.setAttribute('content', 'Field Tools');
    return () => {
      if (link && prevManifest) link.setAttribute('href', prevManifest);
      if (title && prevTitle) title.setAttribute('content', prevTitle);
    };
  }, []);

  // Unauthenticated landing. Keep first-time techs on /tech (rather than
  // bouncing straight to /admin/login) so they can read the install hint and
  // so an "Add to Home Screen" install captures /tech as the launch URL. The
  // hint self-hides off iOS / when already installed; the Sign in button
  // continues to the shared admin/tech login.
  if (!authed) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: DARK.bg,
          color: DARK.text,
          fontFamily: "'Nunito Sans', sans-serif",
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          paddingTop: 'calc(24px + env(safe-area-inset-top, 0px))',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 14,
              background: `linear-gradient(135deg, ${DARK.teal}, #2563eb)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, fontWeight: 800, fontFamily: "'Montserrat', sans-serif",
              color: '#fff',
            }}
          >W</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Montserrat', sans-serif" }}>
            Waves Field Tools
          </div>
        </div>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <AddToHomeScreenHint />
          <button
            type="button"
            onClick={() => navigate('/admin/login')}
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: 10,
              border: 'none',
              background: DARK.teal,
              color: '#fff',
              fontSize: 15,
              fontWeight: 700,
              fontFamily: "'Montserrat', sans-serif",
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const isActive = (item) => {
    if (item.exact) return location.pathname === item.path;
    return location.pathname.startsWith(item.path);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: DARK.bg,
      color: DARK.text,
      fontFamily: "'Nunito Sans', sans-serif",
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        // Clear the iPhone notch/status bar in standalone PWA mode (viewport-fit=cover).
        paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))',
        background: DARK.card,
        borderBottom: `1px solid ${DARK.border}`,
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `linear-gradient(135deg, ${DARK.teal}, #2563eb)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 800, fontFamily: "'Montserrat', sans-serif",
            color: '#fff',
          }}>W</div>
          <span style={{
            fontSize: 15, fontWeight: 700,
            fontFamily: "'Montserrat', sans-serif",
            color: DARK.text,
          }}>Field Tools</span>
        </div>
        <span style={{ fontSize: 13, color: DARK.muted }}>{techName}</span>
      </header>

      {/* Main content area */}
      <main style={{ flex: 1, padding: '16px', paddingBottom: 80, overflowY: 'auto' }}>
        <AddToHomeScreenHint />
        <Outlet />
      </main>

      {/* Bottom nav */}
      <nav style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: DARK.card,
        borderTop: `1px solid ${DARK.border}`,
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        padding: '8px 0 env(safe-area-inset-bottom, 8px)',
        zIndex: 50,
      }}>
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                textDecoration: 'none',
                padding: '4px 12px',
                borderRadius: 8,
                color: active ? DARK.teal : DARK.muted,
                transition: 'color 0.2s',
              }}
            >
              <span style={{ fontSize: 22 }}>{item.icon}</span>
              <span style={{
                fontSize: 10, fontWeight: active ? 700 : 500,
                fontFamily: "'Montserrat', sans-serif",
              }}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
