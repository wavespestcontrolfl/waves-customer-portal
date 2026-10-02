import { useEffect, useRef } from 'react';
import { Link, matchPath, Outlet, useLocation } from 'react-router-dom';
import useIsMobile from '../../hooks/useIsMobile';
import { CalendarDays, ClipboardList, MoreHorizontal, Waves, Wrench } from 'lucide-react';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';
import AddToHomeScreenHint from './AddToHomeScreenHint';
import { useTechNavigationLock } from './TechNavigationLock';
import { useTechBasePath } from './techBasePath';
import './tech-field.css';

// Mounted only after TechLayout verifies the staff profile. One flag read
// owns the entire workspace; child routes consume the outlet context.
// embedded adjusts the chrome for the admin scroll container and adds a Menu
// tab back into the rest of Waves Admin.
export default function TechFieldShell({ children, techName, techRole, documentsAvailable, payGrowthAvailable, embedded = false }) {
  const { enabled, ready } = useFeatureFlagReady('tech-field-workspace', false);
  const base = useTechBasePath();
  const { pathname, search } = useLocation();
  const isMobile = useIsMobile();
  // Embedded, .tf-main is its own scroll container and stays mounted across
  // child routes: snap it to the top on navigation like AdminLayoutV2 does
  // for .admin-main.
  const mainRef = useRef(null);
  useEffect(() => { mainRef.current?.scrollTo?.({ top: 0, behavior: 'instant' }); }, [pathname]);
  const { navigationBusy, setNavigationBusy } = useTechNavigationLock();
  const documentsRoute = Boolean(matchPath(`${base}/documents`, pathname));
  const payGrowthRoute = Boolean(matchPath(`${base}/pay-growth`, pathname));
  const todayRoute = Boolean(matchPath(base, pathname));
  const moreRoute = Boolean(matchPath(`${base}/more`, pathname));
  const visit = new URLSearchParams(search).get('visit');
  const visitSearch = visit ? `?visit=${encodeURIComponent(visit)}` : '';
  const legacyTool = ['protocols', 'lawn-diagnostic', 'social-post'].map(tool => `${base}/${tool}`).some(path => matchPath(path, pathname));
  if (!ready) return <div className={embedded ? 'tech-field tf-embedded' : 'tech-field'} role="status">Loading field workspace…</div>;
  if (!enabled) return children;
  const section = moreRoute || documentsRoute || payGrowthRoute ? 'more'
    : todayRoute ? 'today' : 'tools';
  return (
    <div className={embedded ? 'tech-field tf-embedded' : 'tech-field'}>
      <header className="tf-header">
        <Link to={base} className="tf-brand" aria-label="Waves Tech Today" onClick={(event) => { if (navigationBusy) event.preventDefault(); }} aria-disabled={navigationBusy}><Waves aria-hidden="true" /><strong>waves</strong> tech</Link>
        <span className="tf-profile">{techName}</span>
      </header>
      <main className="tf-main" ref={mainRef}>
        <AddToHomeScreenHint />
        {visit && !todayRoute && <Link className="tf-button" to={`${base}${visitSearch}`} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>Return to visit</Link>}
        <div className={legacyTool ? 'tf-existing' : undefined}>
          {documentsRoute && !documentsAvailable
            ? <p>Staff documents are unavailable.</p>
            : <Outlet context={{ fieldWorkspace: true, techRole, documentsAvailable, payGrowthAvailable, setNavigationBusy }} />}
        </div>
      </main>
      <nav className="tf-nav" aria-label="Field navigation">
        {[
          { id: 'today', to: base, label: 'Today', Icon: CalendarDays },
          { id: 'tools', to: `${base}/tools`, label: 'Tools', Icon: Wrench },
          { id: 'more', to: `${base}/more`, label: 'More', Icon: ClipboardList },
          // /admin/more is the mobile-only index (it redirects desktop to /admin);
          // on desktop the admin sidebar is already beside the workspace.
          ...(embedded && isMobile ? [{ id: 'menu', to: '/admin/more', label: 'Menu', Icon: MoreHorizontal, leavesWorkspace: true }] : []),
        ].map(({ id, to, label, Icon, leavesWorkspace }) => (
          <Link key={id} to={leavesWorkspace ? to : `${to}${visitSearch}`} aria-current={section === id ? 'page' : undefined} aria-disabled={navigationBusy} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
