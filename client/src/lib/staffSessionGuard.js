// One place that notices a rejected staff session on the tech shell.
//
// Tech screens call fetch() directly from dozens of handlers (route read,
// en-route, on-site, timesheet, rain-out, ...). Most turn a 401 into an
// inline error and keep the token, the stored profile and the saved route on
// the device — and the offline fallback in TechLayout would later unlock the
// shell from that profile. TechLayout installs this guard while it is
// mounted: any staff API response (/admin/*, /tech/*, both behind the
// admin-auth middleware) that answers 401 to the CURRENT token calls
// onRejected once. Requests under another token (a login switch in another
// tab) and every other path pass through untouched; the response itself is
// never read or altered.

const STAFF_PATH = /\/api\/(admin|tech)\//;

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const hit = entries.find(([key]) => String(key).toLowerCase() === wanted);
  return hit ? hit[1] : null;
}

function requestParts(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || String(input || ''));
  const auth = headerValue(init?.headers, 'Authorization') ?? headerValue(input?.headers, 'Authorization');
  return { url, auth };
}

export function installStaffSessionGuard({ getToken, onRejected, target = globalThis }) {
  const original = target.fetch;
  if (typeof original !== 'function') return () => {};
  let fired = false;
  const guarded = async function guardedFetch(input, init) {
    const response = await original.call(this, input, init);
    try {
      const token = getToken();
      if (!fired && response?.status === 401 && token) {
        const { url, auth } = requestParts(input, init);
        if (STAFF_PATH.test(url) && auth === `Bearer ${token}`) {
          fired = true;
          onRejected();
        }
      }
    } catch { /* the guard never breaks the caller's request */ }
    return response;
  };
  target.fetch = guarded;
  return () => {
    if (target.fetch === guarded) target.fetch = original;
  };
}
