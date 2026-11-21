/**
 * Bot check for the public newsletter signup (POST /api/public/newsletter/subscribe).
 *
 * Why: from mid-October the website's newsletter form took a steady stream of
 * signups that never confirmed, and some of the people whose addresses were
 * used reported the confirmation email as spam. Every one of those emails goes
 * out from the same sending account as invoices and visit reminders.
 *
 * The website form (astro NewsletterSignup) now sends two extra fields:
 *   - `website`: a field people never see. A person leaves it empty; a bot that
 *     fills every input fills it in.
 *   - `formMs`: milliseconds from the form appearing on the page to the submit.
 *     A browser script that fills and submits at once sends a tiny one.
 *
 * Website forms built before this check (an older spoke deploy, a tab opened
 * before the deploy) send neither field. They still work: a body with no
 * `formMs` passes when the request comes from a browser on a fleet page (its
 * Origin is on the CORS allowlist, config/cors-origins.js). A script that
 * posts the old body straight to this endpoint sends no such Origin and is
 * dropped. Origin can be forged; this is a bot filter, not authentication.
 *
 * screenPublicSignup decides, before any row is written or any email is sent,
 * whether to drop the signup. The route answers a dropped signup exactly like
 * a real one, so a bot cannot tell it was dropped.
 *
 * Only the website form's own sources must carry `formMs`; the portal's own
 * signup form and other callers send different sources and are untouched
 * except for the `website` field, which no real caller ever fills.
 */

const { WAITLIST_SOURCE } = require('./newsletter-subscribers');
const { allowedOrigins } = require('../config/cors-origins');

const FLEET_ORIGINS = new Set(allowedOrigins);

// Sources the astro NewsletterSignup component posts (its default and the
// out-of-area waitlist card). Both go through the same component, so both
// carry the hidden field and formMs.
const WEBSITE_FORM_SOURCES = new Set(['astro-website', WAITLIST_SOURCE]);

// A person needs at least this long to focus the field, pick or type an
// address and press the button. Kept low on purpose: a dropped person sees
// the normal "check your inbox" line and never gets the email.
const MIN_FORM_MS = 1000;

// A person leaves the hidden field empty. Any other value is a bot: a
// non-empty string, or anything that is not a string at all (never trimmed or
// stringified, so a crafted object cannot throw here).
function hiddenFieldFilled(value) {
  if (value == null) return false;
  if (typeof value !== 'string') return true;
  return value.trim() !== '';
}

// origin: the request's Origin header (a browser always sends it on the
// website form's cross-origin POST).
function screenPublicSignup(body, { origin } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (hiddenFieldFilled(b.website)) return { drop: true, reason: 'hidden_field' };
  const source = typeof b.source === 'string' ? b.source : '';
  if (!WEBSITE_FORM_SOURCES.has(source)) return { drop: false, reason: null };
  if (b.formMs === undefined) {
    // A form built before this check: allowed from a browser on a fleet page.
    if (typeof origin === 'string' && FLEET_ORIGINS.has(origin)) return { drop: false, reason: null };
    return { drop: true, reason: 'no_form_timing' };
  }
  const ms = b.formMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_FORM_MS) {
    return { drop: true, reason: 'too_fast' };
  }
  return { drop: false, reason: null };
}

// Log-safe source label: the body's source is free text from the public.
function sourceLabel(body) {
  const s = body && typeof body === 'object' ? body.source : null;
  return WEBSITE_FORM_SOURCES.has(s) ? s : 'other';
}

module.exports = {
  screenPublicSignup, sourceLabel, WEBSITE_FORM_SOURCES, MIN_FORM_MS,
};
