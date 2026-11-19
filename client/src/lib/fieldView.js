// Field view (owner 2026-11-19): an admin login can make the phone open on
// Today. The switch is saved on that phone, for that login only, with the
// other saved menu settings (key `waves_admin_navigation:<accountId>`).
// Everything here is pure and reads device storage only, so it can run before
// the admin shell checks the login with the server.

export const adminNavigationPreferenceKey = (accountId) => `waves_admin_navigation:${accountId}`;

// A missing, malformed or non-boolean value reads as off.
export function readFieldViewPreference(accountId, storage) {
  if (!accountId) return false;
  try {
    const saved = JSON.parse((storage || localStorage).getItem(adminNavigationPreferenceKey(accountId)) || '{}');
    return saved?.fieldView === true;
  } catch { return false; }
}

// The landing page of a cold open, decided from this device alone: the last
// verified profile (`waves_admin_user`) names the login and its role, and that
// login's saved switch must be on. Returns the path to open, or null to leave
// the address as it is. Only `/admin` and `/admin/` can move; the check the
// shell runs afterwards, and the role it trusts, are unchanged.
export function fieldViewLanding(pathname, storage) {
  const target = String(pathname || '').toLowerCase().replace(/\/$/, '');
  if (target !== '/admin') return null;
  try {
    const profile = JSON.parse((storage || localStorage).getItem('waves_admin_user') || 'null');
    if (profile?.role !== 'admin' || !profile.id) return null;
    return readFieldViewPreference(profile.id, storage) ? '/admin/today' : null;
  } catch { return null; }
}
