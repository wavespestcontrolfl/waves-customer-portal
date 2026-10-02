import { useOutletContext } from 'react-router-dom';
import TechFieldShell from '../../components/tech/TechFieldShell';
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
  return (
    <TechBasePathContext.Provider value="/admin/today">
      <TechFieldShell
        forceEnabled
        embedded
        techName={user?.name || 'Staff'}
        techRole={user?.role}
        documentsAvailable={documentsAvailable}
        payGrowthAvailable={payGrowthAvailable}
      />
    </TechBasePathContext.Provider>
  );
}
