/*
 * AdminLayoutV2 — Square Dashboard-inspired light admin shell.
 *
 * Gated behind the `admin-shell-v2` feature flag. V1 AdminLayout remains
 * the default for flag-off users; see DECISIONS.md entry dated 2026-04-18
 * for the palette/typography rationale (warm stone, not clinical zinc).
 *
 * Consumes only the CSS custom properties defined in theme-square.css —
 * no inline hex values. When the tech-portal dark variant lands, it can
 * remap the same tokens on a `[data-theme="tech-dark"]` scope without
 * touching this component.
 */
import { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { cn } from './ui/cn';
import {
  LayoutDashboard,
  Users,
  ClipboardList,
  Calendar,
  Clock,
  BookOpen,
  MessageSquare,
  Star,
  Gift,
  Mic,
  Mail,
  Megaphone,
  Search,
  Share2,
  Wrench,
  Truck,
  Package,
  ShieldCheck,
  Leaf,
  BookMarked,
  Brain,
  FileText,
  Landmark,
  Receipt,
  Calculator,
  Award,
  Activity,
  Settings,
  LogOut,
  Menu,
  Home,
  X,
} from 'lucide-react';
import useIsMobile from '../hooks/useIsMobile';
import NotificationBell from './NotificationBell';
import GlobalCommandPalette from './admin/GlobalCommandPalette';

const MOBILE_TABS = [
  { path: '/admin/dashboard', icon: Home, label: 'Dashboard' },
  { path: '/admin/schedule', icon: Calendar, label: 'Schedule' },
  { path: '/admin/customers', icon: Users, label: 'Customers' },
  { path: '/admin/communications', icon: MessageSquare, label: 'Messages' },
  { path: '/admin/more', icon: Menu, label: 'More' },
];

function isTabActive(pathname, tabPath) {
  if (pathname === tabPath) return true;
  if (tabPath === '/admin/dashboard' && pathname === '/admin') return true;
  if (pathname.startsWith(tabPath + '/')) return true;
  return false;
}

const NAV_SECTIONS = [
  { section: 'Operations', items: [
    { path: '/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/admin/customers', icon: Users, label: 'Customers' },
    { path: '/admin/estimates', icon: ClipboardList, label: 'Pipeline' },
    { path: '/admin/schedule', icon: Calendar, label: 'Schedule' },
    { path: '/admin/timetracking', icon: Clock, label: 'Time Tracking' },
    { path: '/admin/service-library', icon: BookOpen, label: 'Service Library' },
  ]},
  { section: 'Communications', items: [
    { path: '/admin/communications', icon: MessageSquare, label: 'Communications' },
    { path: '/admin/reviews', icon: Star, label: 'Reviews' },
    { path: '/admin/referrals', icon: Gift, label: 'Referrals' },
    { path: '/admin/voice-agent', icon: Mic, label: 'Voice Agent' },
    { path: '/admin/email', icon: Mail, label: 'Email' },
  ]},
  { section: 'Marketing', items: [
    { path: '/admin/ppc', icon: Megaphone, label: 'PPC' },
    { path: '/admin/seo', icon: Search, label: 'SEO' },
    { path: '/admin/social-media', icon: Share2, label: 'Social Media' },
  ]},
  { section: 'Field & Equipment', items: [
    { path: '/admin/equipment', icon: Wrench, label: 'Equipment' },
    { path: '/admin/fleet', icon: Truck, label: 'Fleet & Mileage' },
    { path: '/admin/inventory', icon: Package, label: 'Inventory' },
    { path: '/admin/compliance', icon: ShieldCheck, label: 'Compliance' },
    { path: '/admin/lawn-assessment', icon: Leaf, label: 'Lawn Assessment' },
  ]},
  { section: 'Intelligence', items: [
    { path: '/admin/knowledge', icon: BookMarked, label: 'Knowledge Base' },
    { path: '/admin/kb', icon: Brain, label: 'Claudeopedia' },
  ]},
  { section: 'Finance', items: [
    { path: '/admin/invoices', icon: FileText, label: 'Invoices' },
    { path: '/admin/banking', icon: Landmark, label: 'Banking' },
    { path: '/admin/tax', icon: Receipt, label: 'Tax Center' },
    { path: '/admin/pricing-logic', icon: Calculator, label: 'Pricing Logic' },
  ]},
  { section: 'System', items: [
    { path: '/admin/badges', icon: Award, label: 'Badges' },
    { path: '/admin/tool-health', icon: Activity, label: 'Tool Health' },
    { path: '/admin/settings', icon: Settings, label: 'Settings' },
  ]},
];

function initialsFor(name) {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function roleLabel(role) {
  if (!role) return 'Staff';
  if (role === 'admin') return 'Admin';
  if (role === 'technician') return 'Technician';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default function AdminLayoutV2() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [user, setUser] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const paletteRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem('waves_admin_token');
    if (!token) { navigate('/admin/login', { replace: true }); return; }
    const u = localStorage.getItem('waves_admin_user');
    if (u) setUser(JSON.parse(u));
    fetch('/api/admin/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (r.status === 401) {
          localStorage.removeItem('waves_admin_token');
          localStorage.removeItem('waves_admin_user');
          navigate('/admin/login', { replace: true });
        }
      })
      .catch(() => {});
  }, [navigate]);

  // Auto-close sidebar on route change (mobile) + when viewport grows to desktop.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [location.pathname, isMobile]);

  const handleLogout = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    navigate('/admin/login', { replace: true });
  };

  const openPalette = () => paletteRef.current?.open();

  const sidebarVisible = !isMobile || sidebarOpen;

  return (
    <div
      className="admin-shell-v2"
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--surface-page)',
        fontFamily: "'DM Sans', sans-serif",
        color: 'var(--text-primary)',
      }}
    >
      {/* Mobile top bar — only visible below breakpoint */}
      {isMobile && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 'calc(52px + env(safe-area-inset-top))',
            background: 'var(--surface-primary)',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingTop: 'env(safe-area-inset-top)',
            paddingLeft: 'max(8px, env(safe-area-inset-left))',
            paddingRight: 'max(8px, env(safe-area-inset-right))',
            zIndex: 90,
          }}
        >
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-primary)',
              width: 44,
              height: 44,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Menu size={22} strokeWidth={1.75} />
          </button>
          <img src="/waves-logo.png" alt="" style={{ height: 24 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            Waves Admin
          </div>
          <NotificationBell type="admin" />
        </div>
      )}

      {/* Backdrop — only when mobile sidebar is open */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 99,
          }}
        />
      )}

      {/* Sidebar */}
      <aside
        style={{
          width: 220,
          background: 'var(--surface-primary)',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
          overflowY: 'auto',
          transform: sidebarVisible ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.2s ease',
          boxShadow: isMobile && sidebarOpen ? '2px 0 16px rgba(0,0,0,0.12)' : 'none',
        }}
      >
        {/* Logo + title + notification bell */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 14px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <img src="/waves-logo.png" alt="" style={{ height: 28 }} />
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-primary)',
              letterSpacing: '0.01em',
              flex: 1,
            }}
          >
            Waves Admin
          </div>
          {isMobile ? (
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                width: 44,
                height: 44,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <X size={20} strokeWidth={1.75} />
            </button>
          ) : (
            <NotificationBell type="admin" />
          )}
        </div>

        {/* Search trigger → opens ⌘K palette */}
        <button
          type="button"
          onClick={openPalette}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '10px 12px',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: 'var(--surface-hover)',
            color: 'var(--text-tertiary)',
            fontSize: 13,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          aria-label="Open search"
        >
          <Search size={14} strokeWidth={2} />
          <span style={{ flex: 1 }}>Search…</span>
          <kbd
            style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'var(--kbd-bg)',
              border: '1px solid var(--kbd-border)',
              color: 'var(--kbd-fg)',
            }}
          >
            ⌘K
          </kbd>
        </button>

        {/* Nav sections */}
        <nav style={{ flex: 1, padding: '4px 8px 12px' }}>
          {NAV_SECTIONS.map(({ section, items }) => (
            <div key={section} style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--text-quaternary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '10px 12px 4px',
                  userSelect: 'none',
                }}
              >
                {section}
              </div>
              {items.map(({ path, icon: Icon, label }) => {
                const isActive =
                  location.pathname === path ||
                  (path === '/admin/dashboard' && location.pathname === '/admin');
                return (
                  <Link
                    key={path}
                    to={path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: isMobile ? '10px 12px' : '7px 12px',
                      minHeight: isMobile ? 44 : undefined,
                      borderRadius: 6,
                      marginBottom: 1,
                      background: isActive ? 'var(--surface-active)' : 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: isMobile ? 14 : 13,
                      fontWeight: isActive ? 500 : 400,
                      textDecoration: 'none',
                      transition: 'background 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'var(--surface-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* User chip footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'var(--surface-active)',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            {initialsFor(user?.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {user?.name || 'Staff'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {roleLabel(user?.role)}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Sign out"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: '100%',
          marginLeft: isMobile ? 0 : 220,
          paddingTop: isMobile ? 'calc(52px + env(safe-area-inset-top) + 16px)' : 24,
          paddingBottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom) + 16px)' : 24,
          paddingLeft: isMobile ? 16 : 28,
          paddingRight: isMobile ? 16 : 28,
          minHeight: '100vh',
          background: 'var(--surface-page)',
        }}
        className="admin-main"
      >
        <Outlet />
      </div>

      {/* Mobile bottom tab bar */}
      {isMobile && (
        <nav
          aria-label="Primary"
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'var(--surface-primary)',
            borderTop: '1px solid var(--border-default)',
            paddingBottom: 'env(safe-area-inset-bottom)',
            zIndex: 95,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'stretch', height: 56 }}>
            {MOBILE_TABS.map(({ path, icon: Icon, label }) => {
              const active = isTabActive(location.pathname, path);
              return (
                <Link
                  key={path}
                  to={path}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex-1 flex flex-col items-center justify-center gap-[3px] select-none no-underline',
                  )}
                  style={{
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    minHeight: 44,
                  }}
                >
                  <Icon size={22} strokeWidth={active ? 2.25 : 1.75} />
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: 1,
                      letterSpacing: '0.08em',
                      fontWeight: 500,
                      textTransform: 'uppercase',
                    }}
                  >
                    {label}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {/* Global ⌘K palette */}
      <GlobalCommandPalette ref={paletteRef} />
    </div>
  );
}
