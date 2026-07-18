export function getAdminAuthToken() {
  return localStorage.getItem('waves_admin_token') || '';
}

export function getAdminUser() {
  try {
    const raw = localStorage.getItem('waves_admin_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getAdminDisplayName(fallback = 'Tech') {
  const user = getAdminUser();
  return user?.name || localStorage.getItem('techName') || localStorage.getItem('adminName') || fallback;
}
