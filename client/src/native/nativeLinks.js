/**
 * Universal / App Link handling for the native (Capacitor) shell.
 *
 * When iOS or Android hands the app a verified https://portal.wavespestcontrol.com
 * URL (universal link / app link), Capacitor emits 'appUrlOpen' on @capacitor/app
 * instead of navigating anywhere. The shell's webview already runs the remote
 * portal (capacitor.config server.url), so honoring the link is a same-origin
 * navigation — the SPA router, auth guards, and the /l/:code short-link 302s
 * all behave exactly as they do in a browser tab, just inside the app.
 *
 * Cold starts deliver the URL via App.getLaunchUrl() before listeners can bind,
 * so both paths are handled; the current-location guard makes them idempotent
 * when the OS fires both for one tap. On the web this module is an inert no-op
 * (mirrors nativePush.js).
 *
 * Safety rules (the OS should never hand us a violating URL, but the webview
 * must not be steerable if it does):
 *  - foreign origins are ignored, and navigation uses the origin-checked
 *    ABSOLUTE href — never a derived path. A crafted same-origin URL like
 *    https://portal.wavespestcontrol.com//evil.example/x has pathname
 *    //evil.example/x, which location.assign would treat as protocol-relative
 *    and leave the origin; such pathnames are rejected outright.
 *  - /admin, /tech, and /api are never claimed by the association files
 *    (AASA excludes; Android intent-filter allowlists customer paths), and
 *    are refused here too as defense in depth.
 */
import { isNativeApp } from './platform';

const STAFF_OR_API_PATH = /^\/(admin|tech|api)(\/|$)/;

export function sameOriginUrl(rawUrl, loc = window.location) {
  if (!rawUrl) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.origin !== loc.origin) return null;
  // Protocol-relative smuggling: pathname beginning with '//' would be read
  // by location.assign as a scheme-relative URL to a foreign host.
  if (target.pathname.startsWith('//')) return null;
  return target;
}

// Push payloads commonly use a portal-relative path (for example
// /?tab=documents), while universal links are absolute. Accept both forms,
// but only after proving that the final URL stays on this exact origin and is
// a customer route. Bare strings such as "evil.example/login" are rejected
// instead of being reinterpreted as a same-origin pathname.
export function customerAppUrl(rawUrl, loc = window.location) {
  if (typeof rawUrl !== 'string') return null;
  const value = rawUrl.trim();
  if (!value) return null;
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (!absolute && (!value.startsWith('/') || value.startsWith('//'))) return null;

  let target;
  try {
    target = new URL(value, loc.origin);
  } catch {
    return null;
  }
  if (target.origin !== loc.origin) return null;
  if (target.pathname.startsWith('//') || STAFF_OR_API_PATH.test(target.pathname)) return null;
  return target;
}

export function navigateToCustomerUrl(rawUrl, loc = window.location) {
  const target = customerAppUrl(rawUrl, loc);
  if (!target) return false;
  const dest = `${target.pathname}${target.search}${target.hash}`;
  const current = `${loc.pathname || ''}${loc.search || ''}${loc.hash || ''}`;
  if (dest === current) return false;
  try {
    loc.assign(target.href);
    return true;
  } catch {
    return false;
  }
}

function navigateTo(rawUrl) {
  navigateToCustomerUrl(rawUrl);
}

// App.getLaunchUrl() returns the SAME URL for the entire native app session,
// and in remote-server mode every location.assign is a full document load that
// re-runs this module. The dest === current guard above cannot catch a launch
// URL that REDIRECTS — an /l/:code short link 302s to /estimate/:token, so the
// webview is never "at" /l/:code and the replay loops the app forever
// (2026-07-23 prod incident: a customer's estimate short link looped ~3
// navigations/sec until they force-quit). Consume the launch URL ONCE per app
// session: mark it in sessionStorage — which WebKit scopes to the browsing
// session, so it survives in-session document reloads but resets on the next
// cold start — BEFORE navigating, and skip the replay on later boots.
export const LAUNCH_URL_CONSUMED_KEY = 'waves-native-launch-url-consumed';

function consumeLaunchUrl(url) {
  try {
    if (sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY) === url) return false;
    sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, url);
  } catch {
    // Storage unavailable: still honor the launch URL — a true cold start must
    // navigate. The loop needs storage broken AND a redirecting link at once.
  }
  return true;
}

export async function initNativeLinks() {
  if (!isNativeApp()) return;

  let App;
  try {
    ({ App } = await import('@capacitor/app'));
  } catch {
    // Old binary without the App plugin compiled in — universal links can't
    // reach it anyway (no entitlement), so silently keep legacy behavior.
    return;
  }

  try {
    App.addListener('appUrlOpen', ({ url }) => navigateTo(url));
    const launch = await App.getLaunchUrl();
    if (launch?.url && consumeLaunchUrl(launch.url)) navigateTo(launch.url);
  } catch {
    // Never let link plumbing break app boot.
  }
}
