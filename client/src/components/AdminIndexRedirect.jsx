import { Navigate, useOutletContext } from 'react-router-dom';
import useAdminNavigation from '../hooks/useAdminNavigation';
import { FIELD_VIEW_LANDING_STATE } from '../lib/fieldView';

// /admin lands technicians on their field workspace; everyone else on the
// dashboard (a requireAdmin page that would be a wall of 403s for a technician).
// An admin with Field view on (saved on this phone) lands on Today as well,
// marked as a Field view landing: a sign-in after it returns to /admin, so
// the login that signs in next lands by its own switch.
export default function AdminIndexRedirect() {
  const role = useOutletContext()?.user?.role;
  const fieldView = useAdminNavigation()?.fieldView === true;
  if (role === 'technician') return <Navigate to="today" replace />;
  if (fieldView) return <Navigate to="today" replace state={FIELD_VIEW_LANDING_STATE} />;
  return <Navigate to="dashboard" replace />;
}
