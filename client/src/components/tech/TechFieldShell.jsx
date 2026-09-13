import { Link, matchPath, Outlet, useLocation } from 'react-router-dom';
import { CalendarDays, MoreHorizontal, Waves, Wrench } from 'lucide-react';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';
import AddToHomeScreenHint from './AddToHomeScreenHint';
import { useTechNavigationLock } from './TechNavigationLock';
import './tech-field.css';

// Mounted only after TechLayout verifies the staff profile. One flag read
// owns the entire workspace; child routes consume the outlet context.
export default function TechFieldShell({ children, techName, techRole, documentsAvailable, payGrowthAvailable }) {
  const { enabled, ready } = useFeatureFlagReady('tech-field-workspace', false);
  const { pathname, search } = useLocation();
  const { navigationBusy, setNavigationBusy } = useTechNavigationLock();
  const documentsRoute = Boolean(matchPath('/tech/documents', pathname));
  const payGrowthRoute = Boolean(matchPath('/tech/pay-growth', pathname));
  const todayRoute = Boolean(matchPath('/tech', pathname));
  const moreRoute = Boolean(matchPath('/tech/more', pathname));
  const visit = new URLSearchParams(search).get('visit');
  const visitSearch = visit ? `?visit=${encodeURIComponent(visit)}` : '';
  const legacyTool = ['/tech/protocols', '/tech/lawn-diagnostic', '/tech/social-post'].some(path => matchPath(path, pathname));
  if (!ready) return <div className="tech-field" role="status">Loading field workspace…</div>;
  if (!enabled) return children;
  const section = moreRoute || documentsRoute || payGrowthRoute ? 'more'
    : todayRoute ? 'today' : 'tools';
  return (
    <div className="tech-field">
      <header className="tf-header">
        <Link to="/tech" className="tf-brand" aria-label="Waves Tech Today" onClick={(event) => { if (navigationBusy) event.preventDefault(); }} aria-disabled={navigationBusy}><Waves aria-hidden="true" /><strong>waves</strong> tech</Link>
        <span className="tf-profile">{techName}</span>
      </header>
      <main className="tf-main">
        <AddToHomeScreenHint />
        {visit && !todayRoute && <Link className="tf-button" to={`/tech${visitSearch}`} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>Return to visit</Link>}
        <div className={legacyTool ? 'tf-existing' : undefined}>
          {documentsRoute && !documentsAvailable
            ? <p>Staff documents are unavailable.</p>
            : <Outlet context={{ fieldWorkspace: true, techRole, documentsAvailable, payGrowthAvailable, setNavigationBusy }} />}
        </div>
      </main>
      <nav className="tf-nav" aria-label="Field navigation">
        {[
          { id: 'today', to: '/tech', label: 'Today', Icon: CalendarDays },
          { id: 'tools', to: '/tech/tools', label: 'Tools', Icon: Wrench },
          { id: 'more', to: '/tech/more', label: 'More', Icon: MoreHorizontal },
        ].map(({ id, to, label, Icon }) => (
          <Link key={id} to={`${to}${visitSearch}`} aria-current={section === id ? 'page' : undefined} aria-disabled={navigationBusy} onClick={(event) => { if (navigationBusy) event.preventDefault(); }}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
