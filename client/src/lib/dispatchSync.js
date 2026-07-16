export async function requestDispatchSync({ apiBase, date, token }) {
  const response = await fetch(`${apiBase}/dispatch/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ date }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Sync failed (${response.status})`);
  }
  return payload;
}
