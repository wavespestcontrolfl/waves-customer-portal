// One place that notices a rejected staff session.
//
// Tech screens call fetch() directly from dozens of handlers (route read,
// en-route, on-site, timesheet, rain-out, ...). Most turn a 401 into an
// inline error and keep the token, the stored profile and the saved route on
// the device — and the offline fallback in TechLayout would later unlock the
// shell from that profile. main.jsx installs it once for the whole app
// (admin pages included, since a tech can leave /tech for /admin/*) to
// delete the offline data; TechLayout adds one while it is mounted that
// also ends the session and goes to login. Any API response (/api/*) that answers 401 to a request carrying
// the CURRENT staff token calls onRejected once. Staff routes are not only
// /admin and /tech (visual moments, dispatch, knowledge and more sit behind
// the same admin-auth middleware), so the token, not the path, decides.
// Requests under another token (a login switch in another tab) pass through
// untouched; the response itself is never read or altered.

const API_PATH = /\/api\//;
// 401s that are not a verdict on the staff session: the terminal handoff
// check rejects the HANDOFF token it is given.
const NOT_SESSION_401 = [/\/api\/stripe\/terminal\/validate-handoff(?:[?#]|$)/];

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

// `onEnrollmentRequired` (optional): a 403 MFA_ENROLLMENT_REQUIRED for the
// current token (GATE_ADMIN_MFA_ENFORCE) is the same kind of verdict on the
// session; the body is read from a clone, in the background, so the caller's
// response is untouched.
export function installStaffSessionGuard({ getToken, onRejected, onEnrollmentRequired = null, target = globalThis }) {
  const original = target.fetch;
  if (typeof original !== 'function') return () => {};
  // Once per token: a later login gets a fresh guard.
  let firedFor = null;
  let enrollmentFiredFor = null;
  const guarded = async function guardedFetch(input, init) {
    const response = await original.call(this, input, init);
    try {
      const token = getToken();
      const { url, auth } = requestParts(input, init);
      const forCurrentSession = Boolean(token) && API_PATH.test(url) && auth === `Bearer ${token}`;
      if (firedFor !== token && response?.status === 401 && forCurrentSession && !NOT_SESSION_401.some((re) => re.test(url))) {
        firedFor = token;
        onRejected();
      }
      if (onEnrollmentRequired && enrollmentFiredFor !== token && response?.status === 403 && forCurrentSession
        && typeof response.clone === 'function') {
        response.clone().json().then((body) => {
          if (body?.code !== 'MFA_ENROLLMENT_REQUIRED' || enrollmentFiredFor === token || getToken() !== token) return;
          enrollmentFiredFor = token;
          onEnrollmentRequired();
        }).catch(() => {});
      }
    } catch { /* the guard never breaks the caller's request */ }
    return response;
  };
  target.fetch = guarded;
  return () => {
    if (target.fetch === guarded) target.fetch = original;
  };
}
