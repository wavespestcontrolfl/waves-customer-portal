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

function navigateTo(rawUrl) {
  const target = sameOriginUrl(rawUrl);
  if (!target) return;
  if (STAFF_OR_API_PATH.test(target.pathname)) return;
  const dest = `${target.pathname}${target.search}${target.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (dest === current) return;
  window.location.assign(target.href);
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
    if (launch?.url) navigateTo(launch.url);
  } catch {
    // Never let link plumbing break app boot.
  }
}
