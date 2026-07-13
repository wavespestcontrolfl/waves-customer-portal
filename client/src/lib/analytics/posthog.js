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

import { SERVICE_ESTIMATE_SLUGS } from '../serviceEstimateSlugs';

const KEY = import.meta.env.VITE_POSTHOG_KEY || '';
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
const CONSENT_COOKIE = 'waves_cookies_accepted';

let booted = false;
let bootedMode = null; // 'funnel' | 'tokenized' — which route class initialized the SDK

/** Funnel pages PostHog is allowed to run on. Everything else (esp. /admin,
 *  /tech, authed customer portal) is excluded. */
export function isPublicFunnelPath(pathname) {
  const p = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
  // Bare acquisition routes (/book, /estimate). /book?service=… still matches —
  // the query string is not part of the pathname.
  if (/^\/(book|estimate)\/?$/.test(p)) return true;
  // Public marketing quote pages: /estimate/<service-slug> renders the public
  // QuotePage (see EstimatePublicGateway). A /estimate/<x> whose segment is NOT
  // a known slug is a tokenized customer estimate (PII) and stays excluded — as
  // do /pay/:token and /book/:token.
  const m = p.match(/^\/estimate\/([^/]+)\/?$/);
  if (!m) return false;
  // Decode defensively — a malformed escape (/estimate/%E0%A4%A) throws, and
  // this runs during render even when analytics is dark, so a bad URL must fall
  // through to "not public", never blank the SPA.
  let seg;
  try { seg = decodeURIComponent(m[1]).toLowerCase(); } catch { return false; }
  return SERVICE_ESTIMATE_SLUGS.has(seg);
}

/** Tokenized customer estimate page (/estimate/<token> where the segment is
 *  NOT a known marketing slug). Deliberately excluded from the cookie-based
 *  funnel boot (the URL itself is a bearer credential), but the seamless
 *  accept flow's EXPLICIT funnel events must still count (Codex #2681 r2) —
 *  these pages get a COOKIELESS boot: persistence:'memory', no pageview/
 *  replay/autocapture, token redacted from every URL-ish property, explicit
 *  events only. No cookies or persisted identifiers are set, so the
 *  cookie-consent contract (which governs cookie-based tracking) does not
 *  attach; each pageload is its own anonymous distinct_id. */
export function isTokenizedEstimatePath(pathname) {
  const p = typeof pathname === 'string'
    ? pathname
    : (typeof window !== 'undefined' ? window.location.pathname : '');
  const m = p.match(/^\/estimate\/([^/]+)\/?$/);
  if (!m) return false;
  let seg;
  try { seg = decodeURIComponent(m[1]).toLowerCase(); } catch { return false; }
  return !SERVICE_ESTIMATE_SLUGS.has(seg);
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
  if (!KEY || typeof window === 'undefined') return;
  const tokenizedBoot = isTokenizedEstimatePath(window.location.pathname);
  if (!isPublicFunnelPath(window.location.pathname) && !tokenizedBoot) return;
  const mode = tokenizedBoot ? 'tokenized' : 'funnel';
  if (booted) {
    // The one-shot latch must not freeze the FIRST route class's privacy
    // mode for the whole SPA session (Codex #2681 r3 P2): a tokenized-first
    // boot would leave a later consented /book visit cookieless and
    // pageview-less, and a funnel-first boot would put tokenized estimate
    // events on the persistent cookie identity. Event GATING is already
    // per-route in before_send; persistence + the missed funnel pageview
    // are reconfigured here on a mode crossing.
    if (bootedMode !== mode && window.posthog?.set_config) {
      try {
        if (mode === 'funnel' && hasConsent()) {
          window.posthog.set_config({ persistence: 'localStorage+cookie' });
          // capture_pageview only fires at init — emit the funnel entry
          // pageview the init-time config suppressed (before_send scrubs it).
          if (typeof window.posthog.capture === 'function') window.posthog.capture('$pageview');
          bootedMode = mode;
        } else if (mode === 'tokenized') {
          window.posthog.set_config({ persistence: 'memory' });
          bootedMode = mode;
        }
      } catch { /* set_config unavailable until array.js loads — next nav retries */ }
    }
    return;
  }
  booted = true;
  bootedMode = mode;
  // -- Official PostHog array-stub loader -------------------------------------
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(KEY, {
    api_host: HOST,
    // Fire posthog-ready (which flushes the pre-consent queue) only once the
    // REAL SDK has loaded — flushing into the array stub could lose a sendBeacon
    // capture if the asset load is slow and the page unloads first.
    loaded: () => { window.__wavesPhReady = true; window.dispatchEvent(new Event('posthog-ready')); },
    person_profiles: 'identified_only',
    // Tokenized estimate pages: cookieless + explicit-events-only (see
    // isTokenizedEstimatePath). No automatic $pageview (its $current_url is
    // the bearer URL), no replay, nothing persisted.
    ...(tokenizedBoot ? { persistence: 'memory', disable_session_recording: true } : {}),
    capture_pageview: !tokenizedBoot,
    // The booking flow is PII-dense (name/phone/address text + Google Places
    // address suggestions). Autocapture records clicked-element text, so it is
    // OFF here — the explicit funnel events carry the signal we need.
    autocapture: false,
    // Replay: mask every input value AND every rendered text node ('*'), so no
    // customer PII text (rendered name/phone/address, Places suggestions) can
    // reach replay on these pages. Recording sample rate is set in the UI.
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      // If network capture is ever enabled in the PostHog UI, the booking flow
      // sends address/phone in GET query strings (/booking/availability?address=…,
      // /booking/customer-lookup?phone=…). Strip the query from captured request
      // URLs so that PII can't ride along in replay network data.
      maskCapturedNetworkRequestFn: (request) => {
        if (!request) return request;
        // Strip both query AND hash — PostHog applies this to the replay snapshot
        // page URL too, so /book#lead=… must be scrubbed as well as ?…
        if (typeof request.name === 'string') request.name = request.name.split('?')[0].split('#')[0];
        // Providing this fn overrides PostHog's default body redaction, so drop
        // request/response bodies entirely — the public flows POST
        // name/phone/email/address/notes.
        request.requestBody = undefined;
        request.responseBody = undefined;
        return request;
      },
    },
    cross_subdomain_cookie: true,
    // Hard gate + PII scrub: drop EVERY event (incl. replay $snapshot) whenever
    // the route isn't a funnel route (protects against a client-side nav into
    // /admin or the authed portal after consenting on /book), AND strip the
    // query string / hash from the URL + referrer so a lead id or token carried
    // in /book?…&lead=… never reaches PostHog's automatic $pageview.
    before_send: (event) => {
      const onTokenized = isTokenizedEstimatePath();
      if (!isPublicFunnelPath() && !onTokenized) return null;
      if (!event) return event;
      // Tokenized estimate pages are explicit-events-only: no pageview/
      // pageleave/replay/autocapture frames, however they got triggered.
      if (onTokenized && ['$pageview', '$pageleave', '$snapshot', '$autocapture', '$rageclick'].includes(event.event)) {
        return null;
      }
      const strip = (u) => {
        if (typeof u !== 'string') return u;
        const bare = u.split('?')[0].split('#')[0];
        // The estimate token is a bearer credential — redact it from every
        // URL-ish property (path kept for funnel context, token never leaves
        // the browser). Known marketing slugs (/estimate/pest-control) are
        // NOT tokens and keep their real path.
        return bare.replace(/\/estimate\/([^/?#]+)/i, (full, seg) => {
          let dec;
          try { dec = decodeURIComponent(seg).toLowerCase(); } catch { return '/estimate/[token]'; }
          return SERVICE_ESTIMATE_SLUGS.has(dec) ? full : '/estimate/[token]';
        });
      };
      // Referrers can be a tokenized customer page the visitor came from (e.g.
      // /estimate/<token>), so reduce them to ORIGIN — drop the path entirely.
      // Our own funnel URLs keep their path (it's the funnel page, not PII) but
      // lose query/hash. Covers event props AND first-touch/session person props.
      const toOrigin = (u) => {
        if (typeof u !== 'string') return u;
        try { return new URL(u).origin; } catch (e) { return strip(u); }
      };
      const URL_KEYS = ['$current_url', '$initial_current_url', '$session_entry_url', '$pathname', '$initial_pathname', '$session_entry_pathname'];
      const REFERRER_KEYS = ['$referrer', '$initial_referrer', '$session_entry_referrer'];
      // PostHog auto-copies UTM / click-id params onto events + person props, so
      // a crafted /book?utm_campaign=<email> would carry PII. Drop campaign
      // values that look like PII (email/whitespace/over-long); keep clean ones.
      // Match the bare key, the $initial_/$session_entry_ person props, AND
      // PostHog's $-prefixed current-event campaign props ($utm_campaign, $gclid).
      const CAMPAIGN_RE = /(^|_|\$)(utm_[a-z]+|gclid|gad_source|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|twclid|li_fat_id|igshid|ttclid)$/i;
      // Unsafe = looks like PII: email, %40, phone-shaped (>=7 digits), or
      // over-long. Whitespace alone is fine ("Spring Promo" / "Google Ads").
      const unsafe = (v) => typeof v === 'string' && (v.length > 64 || /@|%40/i.test(v) || v.replace(/\D/g, '').length >= 7);
      const scrub = (bag) => {
        if (!bag) return;
        for (const k of URL_KEYS) if (typeof bag[k] === 'string') bag[k] = strip(bag[k]);
        for (const k of REFERRER_KEYS) if (typeof bag[k] === 'string') bag[k] = toOrigin(bag[k]);
        for (const k of Object.keys(bag)) if (CAMPAIGN_RE.test(k) && unsafe(bag[k])) delete bag[k];
      };
      const props = event.properties;
      scrub(props);
      if (props) { scrub(props.$set); scrub(props.$set_once); }
      scrub(event.$set);
      scrub(event.$set_once);
      return event;
    },
  });
}

/** Start/stop session replay as the SPA enters/leaves funnel routes. Pairs with
 *  before_send (which drops off-funnel events) so a consented visitor who
 *  navigates from /book into /admin or the authed portal stops being recorded. */
export function setFunnelActive(active) {
  if (!booted || typeof window === 'undefined' || !window.posthog) return;
  try {
    if (active) window.posthog.startSessionRecording();
    else window.posthog.stopSessionRecording();
  } catch { /* recorder controls unavailable until array.js loads — safe no-op */ }
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
