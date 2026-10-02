import { useOutletContext } from 'react-router-dom';
import TechFieldShell from '../../components/tech/TechFieldShell';
import TechNavigationLock from '../../components/tech/TechNavigationLock';
import { TechBasePathContext } from '../../components/tech/techBasePath';
import useStaffDocumentsAvailable from '../../hooks/useStaffDocumentsAvailable';
import usePayGrowthAvailable from '../../hooks/usePayGrowthAvailable';

// Layout route for /admin/today. The technician field workspace lives inside
// Waves Admin; AdminLayout has already verified the staff profile and hands it
// down through the outlet context. TechFieldShell renders its own <Outlet>, so
// this component renders no children and no second Outlet.
export default function TodayShell() {
  const { user } = useOutletContext() || {};
  const documentsAvailable = useStaffDocumentsAvailable(true);
  const payGrowthAvailable = usePayGrowthAvailable(true);
  return (
    <TechBasePathContext.Provider value="/admin/today">
      <TechNavigationLock>
        <TechFieldShell
          forceEnabled
          embedded
          techName={user?.name || 'Staff'}
          techRole={user?.role}
          documentsAvailable={documentsAvailable}
          payGrowthAvailable={payGrowthAvailable}
        />
      </TechNavigationLock>
    </TechBasePathContext.Provider>
  );
}
