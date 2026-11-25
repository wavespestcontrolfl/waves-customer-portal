const TRACK_TOKEN_EXPIRY_SQL =
  "((?::date + COALESCE(?::time, TIME '23:59:59')) AT TIME ZONE 'America/New_York') + INTERVAL '1 day'";

function scheduledServiceTrackTokenExpiry(knex, scheduledDate, windowEnd) {
  if (!knex || typeof knex.raw !== 'function') {
    throw new Error('scheduledServiceTrackTokenExpiry requires a knex instance');
  }
  return knex.raw(TRACK_TOKEN_EXPIRY_SQL, [scheduledDate, windowEnd || null]);
}

function isTrackTokenLive(expiresAt) {
  if (!expiresAt) return true;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= Date.now();
}

// A link that needs a REAL expiry: a missing one is refused, where isTrackTokenLive keeps legacy holder links alive.
// The visit text recipient's link (GATE_CALL_GIVEN_VISIT_TEXTS) is issued and served only on this rule.
function isTrackTokenLiveWithExpiry(expiresAt) {
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= Date.now();
}

// How long a visit text recipient's tracker link outlives the visit (GATE_CALL_GIVEN_VISIT_TEXTS): it opens only while the
// visit is en route or on site, and for this long after completed_at (a plain "complete" card). Never while scheduled,
// cancelled, skipped, parked or rebooking. It also needs a live, finite track_token_expires_at.
const RECIPIENT_LINK_AFTER_COMPLETE_MS = 2 * 60 * 60 * 1000;
function recipientTrackLinkOpen(visit, nowMs = Date.now()) {
  if (!visit || !isTrackTokenLiveWithExpiry(visit.track_token_expires_at)) return false;
  if (visit.status === 'completed') {
    const doneMs = visit.completed_at ? new Date(visit.completed_at).getTime() : NaN;
    return Number.isFinite(doneMs) && doneMs <= nowMs + 5 * 60 * 1000 && nowMs - doneMs <= RECIPIENT_LINK_AFTER_COMPLETE_MS;
  }
  // The two live pairs only: a mixed pair (on site by status but en route by track state, or the reverse) is a stale row.
  return (visit.status === 'en_route' && visit.track_state === 'en_route')
    || (visit.status === 'on_site' && visit.track_state === 'on_property');
}

// THE full eligibility rule of a recipient's link: the lifetime and state pair above, and a row the page can show. A parked
// customer-pick row (customer_pick_by set, no placed window) reads "scheduled" on the page, so it is out whatever its status and
// track state say; a completed visit is the one status that is never parked. The track route's own publicTrackState agrees with
// this on every row (pinned by a test that compares them), and the module that resolves the token and the route that answers it
// both call THIS function, so no route can answer an ineligible token differently from an unknown one.
function recipientLinkEligible(visit, nowMs = Date.now()) {
  if (!recipientTrackLinkOpen(visit, nowMs)) return false;
  if (visit.status === 'completed') return true;
  return !(visit.customer_pick_by && !visit.window_start);
}

module.exports = {
  isTrackTokenLive,
  isTrackTokenLiveWithExpiry,
  recipientTrackLinkOpen,
  recipientLinkEligible,
  RECIPIENT_LINK_AFTER_COMPLETE_MS,
  TRACK_TOKEN_EXPIRY_SQL,
  scheduledServiceTrackTokenExpiry,
};
