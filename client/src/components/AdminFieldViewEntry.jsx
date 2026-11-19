import { Navigate, useLocation } from 'react-router-dom';
import { fieldViewLanding } from '../lib/fieldView';

// Wraps the admin shell. A visit to /admin with Field view on goes to Today
// BEFORE the shell mounts: the shell decides at mount, from its path, whether
// the sign-in check may fall back to the offline pass, and only Today gets
// that fallback. The landing reads device storage only (the last verified
// login and its switch as saved now), so a cold open with no signal still
// lands on Today. Every other path, or the switch off, renders the shell.
export default function AdminFieldViewEntry({ children }) {
  const location = useLocation();
  const landing = fieldViewLanding(location.pathname);
  if (landing) return <Navigate to={landing} replace />;
  return children;
}
