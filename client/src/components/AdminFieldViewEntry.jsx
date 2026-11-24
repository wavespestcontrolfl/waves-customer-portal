import { Navigate, useLocation } from 'react-router-dom';
import { FIELD_VIEW_LANDING_STATE, fieldViewLanding } from '../lib/fieldView';

// Wraps the admin shell. A visit to /admin with Field view on goes to Today
// BEFORE the shell mounts: the shell decides at mount, from its path, whether
// its login check may fall back to the offline pass, and only Today gets that
// fallback. fieldViewLanding moves only when that pass would open Today. The
// state marks the landing, so a sign-in the shell then asks for returns to
// /admin (signInReturnLocation). Any other path, or the switch off, renders
// the shell as before.
export default function AdminFieldViewEntry({ children }) {
  const location = useLocation();
  const landing = fieldViewLanding(location.pathname);
  if (landing) return <Navigate to={landing} replace state={FIELD_VIEW_LANDING_STATE} />;
  return children;
}
