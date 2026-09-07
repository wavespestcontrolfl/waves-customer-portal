const API_BASE = import.meta.env.VITE_API_URL || "/api";
export function adminFetch(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    ...options.headers,
  };
  if (!options.skipContentType) headers["Content-Type"] = "application/json";
  const { skipContentType: _skipContentType, ...fetchOptions } = options;
  return fetch(`${API_BASE}${path.replace(/^\/api/, "")}`, {
    ...fetchOptions,
    headers,
  });
}
