import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { FONTS, BUTTON_BASE } from '../theme';

const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', red: '#ef4444' };

const NAV_ITEMS = [
  { path: '/admin/dashboard', icon: '📊', label: 'Dashboard' },
  { path: '/admin/customers', icon: '👥', label: 'Customers' },
  { path: '/admin/estimates', icon: '📋', label: 'Pipeline' },
  { path: '/admin/schedule', icon: '📅', label: 'Schedule' },
  { path: '/admin/communications', icon: '📱', label: 'Communications' },
  { path: '/admin/reviews', icon: '⭐', label: 'Reviews' },
  { path: '/admin/referrals', icon: '🎁', label: 'Referrals' },
  { path: '/admin/ppc', icon: '📣', label: 'PPC' },
  { path: '/admin/social-media', icon: '📲', label: 'Social Media' },
  { path: '/admin/seo', icon: '🔍', label: 'SEO' },
  { path: '/admin/knowledge', icon: '📚', label: 'Knowledge Base' },
  { path: '/admin/voice-agent', icon: '🎙️', label: 'Voice Agent' },
  { path: '/admin/inventory', icon: '📦', label: 'Inventory' },
  { path: '/admin/tax', icon: '💰', label: 'Tax' },
  { path: '/admin/settings', icon: '⚙️', label: 'Settings' },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('waves_admin_token');
    if (!token) { navigate('/admin/login', { replace: true }); return; }
    const u = localStorage.getItem('waves_admin_user');
    if (u) setUser(JSON.parse(u));
    // Verify token is still valid
    fetch('/api/admin/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.status === 401) { localStorage.removeItem('waves_admin_token'); localStorage.removeItem('waves_admin_user'); navigate('/admin/login', { replace: true }); } })
      .catch(() => {});
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    navigate('/admin/login', { replace: true });
  };

  const userName = user ? `${user.name?.split(' ')[0]} ${user.name?.split(' ')[1]?.[0] || ''}.` : 'Staff';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: D.bg, fontFamily: "'DM Sans', sans-serif" }}>
      {/* Sidebar */}
      <div style={{
        width: 240, background: D.bg, borderRight: `1px solid ${D.border}`,
        padding: '16px 12px', display: 'flex', flexDirection: 'column', flexShrink: 0,
        position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 24px' }}>
          <img src="/waves-logo.png" alt="" style={{ height: 28 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.white, fontFamily: "'DM Sans', sans-serif" }}>WAVES ADMIN</div>
            <div style={{ fontSize: 11, color: D.muted }}>{userName}</div>
          </div>
        </div>

        <nav style={{ flex: 1 }}>
          {NAV_ITEMS.map(item => {
            const isActive = location.pathname === item.path || (item.path === '/admin/dashboard' && location.pathname === '/admin');
            return (
              <Link key={item.path} to={item.path} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8, marginBottom: 2,
                background: isActive ? D.card : 'transparent',
                borderLeft: isActive ? `3px solid ${D.teal}` : '3px solid transparent',
                color: isActive ? D.white : D.muted,
                textDecoration: 'none', fontSize: 13, fontWeight: isActive ? 600 : 400,
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div style={{ paddingTop: 16, borderTop: `1px solid ${D.border}` }}>
          <Link to="/" style={{ fontSize: 12, color: D.teal, textDecoration: 'none', display: 'block', padding: '8px 12px' }}>{'←'} Customer Portal</Link>
          <div onClick={handleLogout} style={{
            fontSize: 13, color: D.red, cursor: 'pointer', padding: '10px 12px',
            borderRadius: 8, marginTop: 4, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 8,
            transition: 'background 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.background = D.red + '15'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >{'🚪'} Sign Out</div>
          <div style={{ fontSize: 10, color: D.border, padding: '4px 12px' }}>v2.0</div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, marginLeft: 240, padding: '24px 28px', overflowY: 'auto', minHeight: '100vh' }}>
        <Outlet />
      </div>
    </div>
  );
}
