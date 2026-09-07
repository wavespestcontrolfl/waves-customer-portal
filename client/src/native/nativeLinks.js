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
 * Cold starts can deliver the URL via App.getLaunchUrl() before listeners bind,
 * so both paths are handled. An event delivered during startup takes priority
 * over the launch lookup. On the web this module is an inert no-op.
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
import { isNativeApp, nativePlatform } from './platform';
import { reportNativeLink } from '../lib/reportError';

const STAFF_OR_API_PATH = /^\/(admin|tech|api)(\/|$)/;
const LINK_ROUTES = new Map([['', 'home'], ['l', 'shortlink'], ['estimate', 'estimate']]);

function traceLink(source, outcome, target) {
  reportNativeLink({
    platform: nativePlatform(),
    source,
    outcome,
    route: LINK_ROUTES.get(window.location.pathname.split('/')[1]) || 'other',
    target: target ? LINK_ROUTES.get(target.pathname.split('/')[1]) || 'other' : 'none',
  });
}

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
  if (isCurrentUrl(target, loc)) return false;
  try {
    loc.assign(target.href);
    return true;
  } catch {
    return false;
  }
}

function isCurrentUrl(target, loc = window.location) {
  const dest = `${target.pathname}${target.search}${target.hash}`;
  const current = `${loc.pathname || ''}${loc.search || ''}${loc.hash || ''}`;
  return dest === current;
}

// The native launch lookup can replay its URL across document reloads. A short
// link redirects, so isCurrentUrl cannot prevent assign -> 302 -> boot loops.
// Preserve the existing marker across reloads; do not assume a retained marker
// proves this is the same native session. Explicit appUrlOpen events always
// bypass it. Storage persistence on a real cold start needs device evidence.
export const LAUNCH_URL_CONSUMED_KEY = 'waves-native-launch-url-consumed';

function navigateTo(rawUrl, source) {
  const target = customerAppUrl(rawUrl);
  if (!target) {
    traceLink(source, 'rejected');
    return false;
  }
  traceLink(source, 'received', target);

  let previousUrl;
  let markerWritten = false;
  // iOS updates ApplicationDelegateProxy.lastURL on every event. Android's
  // Bridge.intentUri remains the original launch URL: an event must not replace
  // its marker, or the next document would navigate back to that old link.
  if (source === 'launch' || nativePlatform() === 'ios') {
    try {
      previousUrl = sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY);
      if (source === 'launch' && previousUrl === target.href) {
        traceLink(source, 'replay-skipped', target);
        return false;
      }
      sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, target.href);
      markerWritten = true;
    } catch {
      // Preserve the existing best-effort behavior, but make missing loop
      // protection visible instead of silently assuming storage works.
      traceLink(source, 'storage-unavailable', target);
    }
  }

  if (isCurrentUrl(target)) {
    traceLink(source, 'already-current', target);
    return true;
  }
  // This records an attempt, not proof that the destination loaded. A later
  // boot/replay event reports the new document's route family separately.
  traceLink(source, 'navigation-requested', target);
  if (navigateToCustomerUrl(target.href)) return true;

  // A synchronous navigation failure must not burn a valid URL. Restore only
  // our own marker, retaining protection for a previously consumed link.
  if (markerWritten) {
    try {
      if (sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY) === target.href) {
        if (previousUrl === null) sessionStorage.removeItem(LAUNCH_URL_CONSUMED_KEY);
        else sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, previousUrl);
      }
    } catch {
      traceLink(source, 'storage-unavailable', target);
    }
  }
  traceLink(source, 'navigation-failed', target);
  return false;
}

export async function initNativeLinks() {
  if (!isNativeApp()) return;
  traceLink('boot', 'started');

  let App;
  try {
    ({ App } = await import('@capacitor/app'));
  } catch {
    traceLink('boot', 'plugin-error');
    return;
  }

  let handledEvent = false;
  try {
    // Registration is asynchronous. Handle its rejection independently so a
    // missing listener cannot prevent the cold-start lookup from running.
    void App.addListener('appUrlOpen', (event) => {
      handledEvent = navigateTo(event?.url, 'event') || handledEvent;
    }).then(() => traceLink('boot', 'listener-ready'))
      .catch(() => traceLink('boot', 'listener-error'));
  } catch {
    traceLink('boot', 'listener-error');
  }

  // A bridge call can hang without rejecting. Report that separately, without
  // cancelling a delayed result or blocking an eventual appUrlOpen event.
  const lookupTimer = setTimeout(() => traceLink('launch', 'lookup-timeout'), 5000);
  try {
    const launch = await App.getLaunchUrl();
    // Android keeps its original launch URL even after a newer event. Consume
    // the superseded lookup so the event's destination survives the next boot.
    const supersededAndroidUrl = handledEvent && nativePlatform() === 'android'
      ? customerAppUrl(launch?.url) : null;
    if (supersededAndroidUrl) {
      try {
        sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, supersededAndroidUrl.href);
      } catch {
        traceLink('launch', 'storage-unavailable', supersededAndroidUrl);
      }
    }
    if (handledEvent) traceLink('launch', 'superseded');
    else if (launch?.url) navigateTo(launch.url, 'launch');
    else traceLink('launch', 'empty');
  } catch {
    traceLink('launch', 'lookup-error');
  } finally {
    clearTimeout(lookupTimer);
  }
}
