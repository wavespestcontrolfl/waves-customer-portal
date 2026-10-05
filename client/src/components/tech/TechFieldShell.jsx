import { useEffect, useRef } from 'react';
import { Link, matchPath, Outlet, useLocation } from 'react-router-dom';
import AddToHomeScreenHint from './AddToHomeScreenHint';
import { useTechNavigationLock } from './TechNavigationLock';
import { useTechBasePath } from './techBasePath';
import './tech-field.css';

// Mounted only after the admin shell verifies the staff profile. Child routes
// consume the outlet context. The workspace sits inside Waves Admin: the admin
// top bar and tab bar are the chrome, and a page-level tab row (Today, Tools,
// More) switches between the workspace's own sections (owner 2026-10-05).
export default function TechFieldShell({ staffProfile = null, techRole, documentsAvailable, payGrowthAvailable }) {
  const base = useTechBasePath();
  const { pathname, search } = useLocation();
  // The page scrolls in the admin main area (.admin-main), which stays mounted
  // across child routes. AdminLayoutV2 snaps it to the top when the path
  // changes; opening or closing a visit changes only ?visit=, so reset then
  // too (Codex #5573 r15).
  const rootRef = useRef(null);
  const visitKey = new URLSearchParams(search).get('visit');
  useEffect(() => { rootRef.current?.closest('.admin-main')?.scrollTo?.({ top: 0, behavior: 'instant' }); }, [pathname, visitKey]);
  const { navigationBusy, setNavigationBusy } = useTechNavigationLock();
  const documentsRoute = Boolean(matchPath(`${base}/documents`, pathname));
  const payGrowthRoute = Boolean(matchPath(`${base}/pay-growth`, pathname));
  const todayRoute = Boolean(matchPath(base, pathname));
  const moreRoute = Boolean(matchPath(`${base}/more`, pathname));
  const visit = new URLSearchParams(search).get('visit');
  const visitSearch = visit ? `?visit=${encodeURIComponent(visit)}` : '';
  const legacyTool = ['protocols', 'lawn-diagnostic', 'social-post'].map(tool => `${base}/${tool}`).some(path => matchPath(path, pathname));
  const section = moreRoute || documentsRoute || payGrowthRoute ? 'more'
    : todayRoute ? 'today' : 'tools';
  return (
    <div className="tech-field" ref={rootRef}>
      <nav className="tf-tabs" aria-label="Field sections">
        {[
          { id: 'today', to: base, label: 'Today' },
          { id: 'tools', to: `${base}/tools`, label: 'Tools' },
          { id: 'more', to: `${base}/more`, label: 'More' },
        ].map(({ id, to, label }) => (
          <Link key={id} to={`${to}${visitSearch}`} aria-current={section === id ? 'page' : undefined} aria-disabled={navigationBusy} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="tf-main">
        <AddToHomeScreenHint />
        {visit && !todayRoute && <Link className="tf-button" to={`${base}${visitSearch}`} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>Return to visit</Link>}
        <div className={legacyTool ? 'tf-existing' : undefined}>
          {documentsRoute && !documentsAvailable
            ? <p>Staff documents are unavailable.</p>
            : <Outlet context={{ techRole, staffProfile, documentsAvailable, payGrowthAvailable, setNavigationBusy }} />}
        </div>
      </div>
    </div>
  );
}
