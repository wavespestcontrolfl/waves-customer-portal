const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * adminFetch — shared helper for admin/tech API calls.
 *
 * Returns the raw Response (caller invokes .json() / .ok).
 * Attaches the waves_admin_token. Defaults Content-Type to application/json
 * unless the body is FormData. Auto-stringifies plain-object bodies.
 *
 * Usage:
 *   const r = await adminFetch('/admin/job-costs');
 *   const data = await r.json();
 */
export function adminFetch(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && !isFormData && typeof body !== 'string' && !(body instanceof Blob)) {
    body = JSON.stringify(body);
  }

  return fetch(`${API_BASE}${path}`, { ...options, headers, body });
}
