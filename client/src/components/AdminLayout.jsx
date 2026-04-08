import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import NotificationBell from './NotificationBell';

const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', red: '#ef4444' };

const NAV_SECTIONS = [
  { section: 'Operations', items: [
    { path: '/admin/dashboard', icon: '📊', label: 'Dashboard' },
    { path: '/admin/customers', icon: '👥', label: 'Customers' },
    { path: '/admin/health', icon: '❤️', label: 'Customer Health' },
    { path: '/admin/leads', icon: '📈', label: 'Leads' },
    { path: '/admin/estimates', icon: '📋', label: 'Pipeline' },
    { path: '/admin/schedule', icon: '📅', label: 'Schedule' },
    { path: '/admin/timetracking', icon: '⏱️', label: 'Time Tracking' },
    { path: '/admin/service-library', icon: '📖', label: 'Service Library' },
    { path: '/admin/discounts', icon: '🏷️', label: 'Discounts' },
  ]},
  { section: 'Communications', items: [
    { path: '/admin/communications', icon: '📱', label: 'SMS & Calls' },
    { path: '/admin/call-recordings', icon: '🎧', label: 'Call Recordings' },
    { path: '/admin/reviews', icon: '⭐', label: 'Reviews' },
    { path: '/admin/referrals', icon: '🎁', label: 'Referrals' },
    { path: '/admin/voice-agent', icon: '🎙️', label: 'Voice Agent' },
  ]},
  { section: 'Marketing', items: [
    { path: '/admin/ppc', icon: '📣', label: 'PPC' },
    { path: '/admin/seo', icon: '🔍', label: 'SEO' },
    { path: '/admin/social-media', icon: '📲', label: 'Social Media' },
    { path: '/admin/wordpress', icon: '🌐', label: 'WordPress Sites' },
  ]},
  { section: 'Field & Equipment', items: [
    { path: '/admin/equipment', icon: '🔧', label: 'Equipment' },
    { path: '/admin/fleet', icon: '🚐', label: 'Fleet & Mileage' },
    { path: '/admin/inventory', icon: '📦', label: 'Inventory' },
    { path: '/admin/compliance', icon: '📋', label: 'Compliance' },
    { path: '/admin/lawn-assessment', icon: '🌿', label: 'Lawn Assessment' },
  ]},
  { section: 'Intelligence', items: [
    { path: '/admin/knowledge', icon: '📚', label: 'Knowledge Base' },
    { path: '/admin/kb', icon: '🧠', label: 'Claudeopedia' },
  ]},
  { section: 'Finance', items: [
    { path: '/admin/invoices', icon: '🧾', label: 'Invoices' },
    { path: '/admin/tax', icon: '💰', label: 'Tax Center' },
  ]},
  { section: 'System', items: [
    { path: '/admin/badges', icon: '🏅', label: 'Badges' },
    { path: '/admin/settings', icon: '⚙️', label: 'Settings' },
  ]},
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('waves_admin_token');
    if (!token) { navigate('/admin/login', { replace: true }); return; }
    const u = localStorage.getItem('waves_admin_user');
    if (u) setUser(JSON.parse(u));
    fetch('/api/admin/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.status === 401) { localStorage.removeItem('waves_admin_token'); localStorage.removeItem('waves_admin_user'); navigate('/admin/login', { replace: true }); } })
      .catch(() => {});
  }, [navigate]);

  // Close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  // Close sidebar on desktop resize
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const handler = (e) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    navigate('/admin/login', { replace: true });
  };

  const userName = user ? `${user.name?.split(' ')[0]} ${user.name?.split(' ')[1]?.[0] || ''}.` : 'Staff';
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: D.bg, fontFamily: "'DM Sans', sans-serif" }}>

      {/* Mobile top bar */}
      <div style={{
        display: 'none', position: 'fixed', top: 0, left: 0, right: 0, height: 52, zIndex: 60,
        background: D.bg, borderBottom: `1px solid ${D.border}`, padding: '0 16px',
        alignItems: 'center', justifyContent: 'space-between',
      }} className="mobile-topbar">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{
          background: 'none', border: 'none', color: D.white, fontSize: 24, cursor: 'pointer', padding: 4,
        }}>☰</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/waves-logo.png" alt="" style={{ height: 24 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: D.white }}>WAVES</span>
        </div>
        <NotificationBell type="admin" />
      </div>

      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90,
        }} className="sidebar-overlay" />
      )}

      {/* Sidebar */}
      <div style={{
        width: 240, background: D.bg, borderRight: `1px solid ${D.border}`,
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 100,
        transform: sidebarOpen ? 'translateX(0)' : (isDesktop ? 'translateX(0)' : 'translateX(-100%)'),
        transition: 'transform 0.2s ease',
        overflowY: 'auto', overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        boxShadow: sidebarOpen && !isDesktop ? '8px 0 32px rgba(0,0,0,0.3)' : 'none',
      }} className="admin-sidebar">
        {/* Header + close button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 12px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/waves-logo.png" alt="" style={{ height: 28 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.white }}>WAVES ADMIN</div>
              <div style={{ fontSize: 11, color: D.muted }}>{userName}</div>
            </div>
          </div>
          <div className="desktop-bell" style={{ display: 'flex', alignItems: 'center' }}>
            <NotificationBell type="admin" />
          </div>
          <button onClick={() => setSidebarOpen(false)} style={{
            background: 'none', border: 'none', color: D.muted, fontSize: 20, cursor: 'pointer',
            padding: 4, lineHeight: 1, display: 'none',
          }} className="sidebar-close">✕</button>
        </div>

        {/* Nav items - scrollable */}
        <nav style={{ flex: 1, padding: '0 12px', overflowY: 'auto' }}>
          {NAV_SECTIONS.map(({ section, items }) => (
            <div key={section}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: D.border, textTransform: 'uppercase',
                letterSpacing: '0.08em', padding: '14px 12px 4px', userSelect: 'none',
              }}>{section}</div>
              {items.map(item => {
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
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ paddingTop: 12, padding: '12px', borderTop: `1px solid ${D.border}`, flexShrink: 0 }}>
          <Link to="/" style={{ fontSize: 12, color: D.teal, textDecoration: 'none', display: 'block', padding: '8px 12px' }}>{'←'} Customer Portal</Link>
          <div onClick={handleLogout} style={{
            fontSize: 13, color: D.red, cursor: 'pointer', padding: '10px 12px',
            borderRadius: 8, marginTop: 4, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>{'🚪'} Sign Out</div>
          <div style={{ fontSize: 10, color: D.border, padding: '4px 12px' }}>v2.0</div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, marginLeft: 240, padding: '24px 28px', overflowY: 'auto', minHeight: '100vh' }} className="admin-main">
        <Outlet />
      </div>

      {/* Mobile-responsive CSS */}
      <style>{`
        @media (max-width: 767px) {
          .mobile-topbar { display: flex !important; }
          .admin-sidebar {
            transform: translateX(-100%);
            box-shadow: 8px 0 32px rgba(0,0,0,0.3);
          }
          .admin-sidebar[style*="translateX(0)"] {
            transform: translateX(0) !important;
          }
          .sidebar-close { display: block !important; }
          .desktop-bell { display: none !important; }
          .admin-main {
            margin-left: 0 !important;
            padding: 68px 16px 24px !important;
          }
        }
        .admin-sidebar::-webkit-scrollbar { width: 4px; }
        .admin-sidebar::-webkit-scrollbar-track { background: transparent; }
        .admin-sidebar::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
      `}</style>
    </div>
  );
}
