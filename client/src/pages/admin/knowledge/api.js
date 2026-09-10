const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function requestJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export function adminFetch(path) {
  return requestJson(path);
}

export function adminPost(path, body) {
  return requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function errorMessage(error, fallback) {
  return error?.message || fallback;
}
