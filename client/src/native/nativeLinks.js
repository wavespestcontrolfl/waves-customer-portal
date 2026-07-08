/**
 * Universal / App Link handling for the native (Capacitor) shell.
 *
 * When iOS or Android hands the app a verified https://portal.wavespestcontrol.com
 * URL (universal link / app link), Capacitor emits 'appUrlOpen' on @capacitor/app
 * instead of navigating anywhere. The shell's webview already runs the remote
 * portal (capacitor.config server.url), so honoring the link is a same-origin
 * location.assign — the SPA router, auth guards, and the /l/:code short-link
 * 302s all behave exactly as they do in a browser tab, just inside the app.
 *
 * Cold starts deliver the URL via App.getLaunchUrl() before listeners can bind,
 * so both paths are handled; the current-location guard makes them idempotent
 * when the OS fires both for one tap. On the web this module is an inert no-op
 * (mirrors nativePush.js), and any URL that isn't same-origin is ignored —
 * the OS should never hand us a foreign host, but a webview must not be
 * steerable to one if it does.
 */
import { isNativeApp } from './platform';

export function sameOriginPath(rawUrl, loc = window.location) {
  if (!rawUrl) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.origin !== loc.origin) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

function navigateTo(rawUrl) {
  const dest = sameOriginPath(rawUrl);
  if (!dest) return;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (dest === current) return;
  window.location.assign(dest);
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
