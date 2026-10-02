import { Outlet, matchPath, useLocation, useOutletContext } from 'react-router-dom';
import TechFieldShell from '../../components/tech/TechFieldShell';
import { useTechNavigationLock } from '../../components/tech/TechNavigationLock';
import { TechBasePathContext } from '../../components/tech/techBasePath';
import useStaffDocumentsAvailable from '../../hooks/useStaffDocumentsAvailable';
import usePayGrowthAvailable from '../../hooks/usePayGrowthAvailable';

// Layout route for /admin/today. The technician field workspace lives inside
// Waves Admin; AdminLayout has already verified the staff profile and hands it
// down through the outlet context. TechFieldShell renders its own <Outlet>, so
// this component renders no children and no second Outlet.
//
// The navigation lock is NOT mounted here: TechNavigationLock's history guard
// must register before BrowserRouter's popstate listener to win, so App.jsx
// mounts the one provider outside the router and TechFieldShell reads it
// through useTechNavigationLock (pre-push Codex P1).
export default function TodayShell() {
  const { user } = useOutletContext() || {};
  const documentsAvailable = useStaffDocumentsAvailable(true);
  const payGrowthAvailable = usePayGrowthAvailable(true);
  const lock = useTechNavigationLock();
  const { pathname } = useLocation();
  // Same document gate the field shell applies (and the retired /tech shell
  // applied) when the flag is off: a bookmarked /admin/today/documents must
  // not mount the library against dark-gated endpoints.
  const documentsGated = Boolean(matchPath('/admin/today/documents', pathname)) && !documentsAvailable;
  // The tech-field-workspace flag keeps its meaning here (pre-push Codex P1):
  // on → the field workspace; off → the legacy route UI, exactly as the /tech
  // shell rendered it, as this shell's children.
  // The legacy route UI paints light text for the retired /tech shell's dark
  // page; keep that wrapper so a flag-off (or flag-fetch-failure) render is
  // readable inside the light admin surface.
  const legacy = (
    <div style={{ minHeight: '100%', margin: '-24px -28px', padding: 16, background: '#0f1923', color: '#e2e8f0', fontFamily: "'Nunito Sans', sans-serif" }} data-legacy-field-shell>
      {documentsGated ? <p>Staff documents are unavailable.</p> : <Outlet context={{
        fieldWorkspace: false,
        techRole: user?.role,
        documentsAvailable,
        payGrowthAvailable,
        setNavigationBusy: lock?.setNavigationBusy,
      }} />}
    </div>
  );
  return (
    <TechBasePathContext.Provider value="/admin/today">
      <TechFieldShell
        embedded
        techName={user?.name || 'Staff'}
        techRole={user?.role}
        documentsAvailable={documentsAvailable}
        payGrowthAvailable={payGrowthAvailable}
      >
        {legacy}
      </TechFieldShell>
    </TechBasePathContext.Provider>
  );
}
