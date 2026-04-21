import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Home, Calendar, Users, MessageSquare, Menu, Sparkles } from 'lucide-react';
import NotificationBell from '../NotificationBell';
import { cn } from '../ui/cn';

/**
 * Mobile-only admin shell — top bar + 5-tab bottom bar.
 * Activates below md breakpoint (<768px) via Tailwind `md:hidden`.
 * Desktop admin layout (sidebar) continues to render unchanged above md.
 *
 * The 5 tabs are the only nav surface on mobile. Everything else lives
 * under /admin/more. The command palette replaces ⌘K for touch users.
 */

const TABS = [
  { path: '/admin/dashboard', icon: Home, label: 'Dashboard' },
  { path: '/admin/schedule', icon: Calendar, label: 'Schedule' },
  { path: '/admin/customers', icon: Users, label: 'Customers' },
  { path: '/admin/communications', icon: MessageSquare, label: 'Messages' },
];

export default function MobileAdminShell({ onCommandOpen, onMenuOpen }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      {/* Top bar — hamburger + logo left, command + notifications right */}
      <header
        className="md:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-white border-b border-hairline border-zinc-200 flex items-center justify-between px-4"
        style={{ paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <div className="flex items-center gap-1 -ml-2">
          <button
            type="button"
            onClick={onMenuOpen}
            aria-label="Open menu"
            className="w-11 h-11 flex items-center justify-center rounded-md text-zinc-900 bg-white border-0 active:bg-zinc-100"
          >
            <Menu size={22} strokeWidth={1.75} />
          </button>
          <button
            onClick={() => navigate('/admin/dashboard')}
            className="flex items-center gap-2 px-1 py-1 rounded-md bg-white border-0 active:bg-zinc-50"
            aria-label="Go to dashboard"
          >
            <img src="/waves-logo.png" alt="" className="h-6 w-auto" />
            <span className="text-13 font-medium text-zinc-900 tracking-label">WAVES</span>
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCommandOpen}
            aria-label="Open Intelligence Bar"
            className="w-11 h-11 flex items-center justify-center rounded-md text-zinc-900 bg-white border-0 active:bg-zinc-100"
          >
            <Sparkles size={20} strokeWidth={1.75} />
          </button>
          <NotificationBell type="admin" />
        </div>
      </header>

      {/* Bottom tab bar */}
      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-t border-hairline border-zinc-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
      >
        <div className="flex items-stretch h-14">
          {TABS.map(({ path, icon: Icon, label }) => {
            const active = isActive(pathname, path);
            return (
              <Link
                key={path}
                to={path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex-1 flex flex-col items-center justify-center gap-[3px] select-none no-underline',
                  active ? 'text-zinc-900' : 'text-zinc-500',
                )}
              >
                <Icon size={22} strokeWidth={active ? 2.25 : 1.75} />
                <span className={cn(
                  'text-[10px] leading-none tracking-label font-medium uppercase',
                )}>{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

function isActive(pathname, tabPath) {
  if (pathname === tabPath) return true;
  if (tabPath === '/admin/dashboard' && pathname === '/admin') return true;
  if (pathname.startsWith(tabPath + '/')) return true;
  return false;
}
