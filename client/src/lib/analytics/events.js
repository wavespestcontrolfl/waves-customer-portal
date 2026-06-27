// =============================================================================
// Funnel analytics — event taxonomy (portal / booking half)
// =============================================================================
// Single source of truth for the booking + estimate-accept funnel events fired
// from the PUBLIC portal pages (/book, /estimate, /pay). The marketing site owns
// the upstream half in the astro repo (src/lib/analytics/events.ts). The two
// stitch into one PostHog funnel via the shared `.wavespestcontrol.com` cookie,
// so a visitor who clicks "Book my first visit" on wavespestcontrol.com is the
// same person here on portal.wavespestcontrol.com.
//
// SCOPE: these events only fire on public funnel pages. PostHog is never even
// initialized on /admin, /tech, or the authenticated customer portal — see
// client/src/lib/analytics/posthog.js (isPublicFunnelPath).
//
// Conventions: snake_case; PII-SAFE properties only (no name/email/phone/full
// address — city/zip/sqft/money-as-number are fine); `track()` is a no-op until
// consent + key, so callers never guard.
// =============================================================================

export const FUNNEL_EVENTS = {
  // -- Public booking flow (PublicBookingPage.jsx) ----------------------------
  /** /book mounted. props: { source }  source: marketing-site | estimate | direct */
  BOOKING_VIEWED: 'booking_viewed',
  /** A service was chosen. props: { service } */
  BOOKING_SERVICE_SELECTED: 'booking_service_selected',
  /** Availability lookup returned. props: { has_slots } */
  BOOKING_AVAILABILITY_LOADED: 'booking_availability_loaded',
  /** The natural-language schedule search was used (no query text — could be PII). props: {} */
  BOOKING_AI_SEARCH_USED: 'booking_ai_search_used',
  /** A date/time slot was picked. props: { date } */
  BOOKING_SLOT_SELECTED: 'booking_slot_selected',
  /** The contact-details step was reached. props: { is_existing_customer } */
  BOOKING_CONTACT_STARTED: 'booking_contact_started',
  /** POST /api/booking/confirm succeeded. props: { service, is_existing_customer, recurring } */
  BOOKING_CONFIRMED: 'booking_confirmed',

  // -- Public estimate-accept (tokenized estimate link) -----------------------
  /** A tokenized estimate/pay link was opened. props: {} */
  ESTIMATE_ACCEPT_OPENED: 'estimate_accept_opened',
  /** The customer accepted the estimate. props: { recurring } */
  ESTIMATE_ACCEPTED: 'estimate_accepted',
};

/**
 * Fire a funnel event. No-op until PostHog is loaded (it attaches
 * `window.posthog` only on public funnel pages after consent + key). Callers
 * never need to guard — undefined/null/'' props are dropped before send.
 */
export function track(event, props) {
  if (typeof window === 'undefined') return;
  const ph = window.posthog;
  if (!ph || typeof ph.capture !== 'function') return;
  let clean;
  if (props) {
    clean = {};
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined && v !== null && v !== '') clean[k] = v;
    }
  }
  ph.capture(event, clean);
}
