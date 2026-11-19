import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { fieldViewLanding } from '../lib/fieldView';

// Wraps the admin shell. A cold open at /admin with Field view on goes to
// Today BEFORE the shell mounts: the shell decides at mount, from its path,
// whether the sign-in check may fall back to the offline pass, and only Today
// gets that fallback. Decided once, from device storage; later visits to
// /admin inside the open app use the verified role (AdminIndexRedirect).
export default function AdminFieldViewEntry({ children }) {
  const location = useLocation();
  const [landing] = useState(() => fieldViewLanding(location.pathname));
  // Once the redirect has moved the address, the shell mounts as usual.
  if (landing && /^\/admin\/?$/i.test(location.pathname)) {
    return <Navigate to={landing} replace />;
  }
  return children;
}
