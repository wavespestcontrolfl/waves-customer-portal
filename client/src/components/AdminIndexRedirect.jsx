import { Navigate, useOutletContext } from 'react-router-dom';
import useAdminNavigation from '../hooks/useAdminNavigation';

// /admin lands technicians on their field workspace; everyone else on the
// dashboard (a requireAdmin page that would be a wall of 403s for a technician).
// An admin with Field view on (saved on this phone) lands on Today as well.
export default function AdminIndexRedirect() {
  const role = useOutletContext()?.user?.role;
  const fieldView = useAdminNavigation()?.fieldView === true;
  return <Navigate to={role === 'technician' || fieldView ? 'today' : 'dashboard'} replace />;
}
