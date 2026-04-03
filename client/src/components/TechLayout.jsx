import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const NAV_ITEMS = [
  { path: '/tech', icon: '📅', label: 'Route', exact: true },
  { path: '/tech/estimate', icon: '📋', label: 'Estimate' },
  { path: '/tech/protocols', icon: '📖', label: 'Protocols' },
  { path: '/tech/messages', icon: '💬', label: 'Messages' },
];

export default function TechLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [techName, setTechName] = useState('Tech');

  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      navigate('/admin/login', { replace: true });
      return;
    }
    const name = localStorage.getItem('techName') || localStorage.getItem('adminName') || 'Tech';
    setTechName(name);
  }, [navigate]);

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
