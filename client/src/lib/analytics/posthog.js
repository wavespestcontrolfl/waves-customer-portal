// =============================================================================
// PostHog loader — PUBLIC funnel pages only.
// =============================================================================
// PostHog is initialized ONLY on the customer-acquisition funnel pages
// (/book, /estimate, /pay). It is never loaded on /admin, /tech, or the
// authenticated customer portal — those carry employee/customer PII and have
// zero acquisition-funnel value. The gate is enforced by isPublicFunnelPath()
// and by where <PublicFunnelTracking/> chooses to boot.
//
// Identity stitches with the marketing site (wavespestcontrol.com) via the
// shared `.wavespestcontrol.com` consent + distinct_id cookies, so a visitor
// who clicks "Book my first visit" on the hub is the same PostHog person here.
//
// Dark until VITE_POSTHOG_KEY is set (mirrors the marketing site's
// PUBLIC_POSTHOG_KEY gating) and until consent is present.
// =============================================================================

const KEY = import.meta.env.VITE_POSTHOG_KEY || '';
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
const CONSENT_COOKIE = 'waves_cookies_accepted';

let booted = false;

/** Funnel pages PostHog is allowed to run on. Everything else (esp. /admin,
 *  /tech, authed customer portal) is excluded. */
export function isPublicFunnelPath(pathname) {
  const p = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
  return /^\/(book|estimate|pay)(\/|$)/.test(p);
}

/** True once the visitor has accepted cookies (set here or on the marketing
 *  site — the cookie is shared across the .wavespestcontrol.com family). */
export function hasConsent() {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').some((c) => c === `${CONSENT_COOKIE}=1`);
}

/** Persist consent on the registrable domain so it carries across subdomains.
 *  Mirrors the marketing site's CookieBanner exactly. */
export function grantConsent() {
  if (typeof document === 'undefined') return;
  const host = window.location.hostname;
  const onHubFamily = host === 'wavespestcontrol.com' || host.endsWith('.wavespestcontrol.com');
  const domainAttr = onHubFamily ? '; Domain=.wavespestcontrol.com' : '';
  document.cookie = `${CONSENT_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax; Secure${domainAttr}`;
}

/** Inject + init PostHog. No-ops without a key, off-funnel, or already booted.
 *  Caller is responsible for the consent check (so the consent UI can boot it
 *  on Accept). */
export function bootPostHog() {
  if (booted || !KEY || typeof window === 'undefined') return;
  if (!isPublicFunnelPath(window.location.pathname)) return;
  booted = true;
  // -- Official PostHog array-stub loader -------------------------------------
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(KEY, {
    api_host: HOST,
    person_profiles: 'identified_only',
    capture_pageview: true,
    autocapture: true,
    // Replay: mask every input value; sample rate set in the PostHog UI. Tag PII
    // text nodes with class "ph-mask"; un-mask safe controls with "ph-no-mask".
    session_recording: { maskAllInputs: true, maskTextSelector: '.ph-mask' },
    cross_subdomain_cookie: true,
  });
}

/** Convenience: boot immediately if consent already exists. Returns whether it
 *  booted, so a consent UI can decide whether to render. */
export function bootPostHogIfConsented() {
  if (KEY && hasConsent()) {
    bootPostHog();
    return true;
  }
  return false;
}

export const POSTHOG_ENABLED = !!KEY;
