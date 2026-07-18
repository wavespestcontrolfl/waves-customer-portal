/**
 * Final flagship event-selection gate.
 *
 * Draft creation filters events, but stored drafts can outlive policy changes
 * or carry manually supplied ids. Proofing and delivery therefore re-load the
 * locked rows and fail closed before any external mail or send-state claim.
 */

const db = require('../models/db');
const { FLAGSHIP_TYPE_KEY, isFlagshipType } = require('../config/newsletter-types');
const {
  isEligibleForFreshDigest,
  isEditoriallyNewEvent,
  isSeriesDebutEvent,
  normalizeDigestTitle,
  excludeRepeatedDateIdentities,
  dedupeDigestEvents,
  getActiveNewsletterTuesday,
} = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTINE_IDENTITY_HORIZON_DAYS = 90;

function parseLockedEventIds(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function isPreviouslyFeaturedIdentity(event, featuredHistory, reference) {
  return (Array.isArray(featuredHistory) ? featuredHistory : []).some((prior) => {
    if (String(prior.id) === String(event.id)) return false;
    const hasHistory = Number(prior.times_featured) > 0 || Boolean(prior.last_featured_at);
    if (!hasHistory) return false;

    const sameTitle = normalizeDigestTitle(prior.title)
      && normalizeDigestTitle(prior.title) === normalizeDigestTitle(event.title);
    // A roundup article URL can legitimately back many distinct events. Only
    // canonical title identity carries feature history across ingestion rows.
    if (!sameTitle) return false;

    // Annual occurrences can return after the same 300-day cooldown used for
    // row-local feature history. Missing timestamps fail closed.
    if (event.event_type === 'annual' || event.recurrence_type === 'annual') {
      return !isEditoriallyNewEvent({
        ...event,
        times_featured: Math.max(1, Number(prior.times_featured) || 0),
        last_featured_at: prior.last_featured_at,
      }, reference);
    }
    return true;
  });
}

async function loadFeaturedIdentityHistory(knex = db) {
  return knex('events_raw')
    .select(
      'id', 'title', 'event_url', 'event_type', 'recurrence_type',
      'times_featured', 'last_featured_at',
    )
    .where((query) => query.where('times_featured', '>', 0).orWhereNotNull('last_featured_at'));
}

/** Remove logical events already featured on a different ingestion row. */
async function filterPreviouslyFeaturedIdentities(events, { knex = db, reference = new Date() } = {}) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return [];
  const history = await loadFeaturedIdentityHistory(knex);
  // A starred row bypasses cross-row identity history — the operator is
  // deliberately re-featuring an identity that shipped before, and the star
  // is consumed on ship. (A DEBUT gets no such bypass here: prior shipped
  // history for the same identity is proof it isn't a debut.)
  return rows.filter((event) => event.admin_status === 'featured'
    || !isPreviouslyFeaturedIdentity(event, history, reference));
}

function repeatedDateTitleKeys(events) {
  const rows = Array.isArray(events) ? events : [];
  const survivingTitles = new Set(
    excludeRepeatedDateIdentities(rows).map((event) => normalizeDigestTitle(event?.title)).filter(Boolean),
  );
  return new Set(
    rows.map((event) => normalizeDigestTitle(event?.title))
      .filter((title) => title && !survivingTitles.has(title)),
  );
}

async function loadRoutineIdentityPool(knex = db, reference = new Date()) {
  const issueTuesday = getActiveNewsletterTuesday(reference);
  const issueStart = parseETDateTime(`${issueTuesday}T00:00:00`);
  const horizonStart = parseETDateTime(
    `${etDateString(addETDays(issueStart, -ROUTINE_IDENTITY_HORIZON_DAYS))}T00:00:00`,
  );
  const horizonEnd = parseETDateTime(
    `${etDateString(addETDays(issueStart, ROUTINE_IDENTITY_HORIZON_DAYS))}T23:59:59`,
  );
  return knex('events_raw')
    .select('id', 'title', 'start_at')
    .whereNull('merged_into')
    .where('start_at', '>=', horizonStart)
    .where('start_at', '<=', horizonEnd);
}

/**
 * DB-backed routine-identity gate shared by planning and final validation.
 * The bounded ±90-day horizon catches next week's sibling and a prior-only
 * sibling (including a rejected row, which is still recurrence evidence)
 * even when only this week's occurrence was selected into the draft.
 */
async function filterRepeatedDateIdentities(
  events,
  { knex = db, reference = new Date(), identityPool = null } = {},
) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return [];
  const pool = identityPool || await loadRoutineIdentityPool(knex, reference);
  const repeatedTitles = repeatedDateTitleKeys(pool);
  return rows.filter((event) => {
    // Two carve-outs survive the repeated-title exclusion: an operator STAR
    // (deliberate editorial override, consumed on ship) and the single-use
    // series DEBUT — whose own later occurrences share its normalized title
    // in the ±90-day pool, which is exactly what this filter keys on; an
    // inaugural weekly market would otherwise never reach the digest. Both
    // remain subject to every row-level gate (isEligibleForFreshDigest).
    if (event?.admin_status === 'featured') return true;
    if (event?.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event)) return true;
    return !repeatedTitles.has(normalizeDigestTitle(event?.title));
  });
}

function assessFlagshipEventSelection(
  send,
  rows,
  reference = new Date(),
  featuredHistory = [],
  issueIdentityPool = rows,
) {
  if (!isFlagshipType(send?.newsletter_type)) {
    return { valid: true, errors: [], events: [], flagship: false };
  }

  const ids = parseLockedEventIds(send.event_ids);
  const errors = [];
  if (!ids.length) {
    return { valid: false, errors: ['Flagship draft has no locked event ids.'], events: [], flagship: true };
  }
  if (ids.some((id) => !UUID_RE.test(id))) {
    return { valid: false, errors: ['Flagship draft contains an invalid locked event id.'], events: [], flagship: true };
  }
  if (new Set(ids).size !== ids.length) errors.push('Flagship draft repeats a locked event id.');

  const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.id), row]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== new Set(ids).size) errors.push('One or more locked events no longer exist.');

  const issueTuesday = getActiveNewsletterTuesday(reference);
  const windowStart = parseETDateTime(`${issueTuesday}T00:00:00`);
  const windowEnd = parseETDateTime(`${etDateString(addETDays(windowStart, 6))}T23:59:59`);
  const repeatedTitles = repeatedDateTitleKeys(issueIdentityPool);
  const eligible = [];
  for (const event of ordered) {
    const start = event.start_at ? new Date(event.start_at) : null;
    const inIssueWindow = start && !Number.isNaN(start.getTime())
      && start >= windowStart && start <= windowEnd;
    const approved = ['approved', 'featured'].includes(event.admin_status);
    // Same carve-outs as the planning filters, or the final proof/send gate
    // would reject a lineup planning deliberately admitted: a STAR bypasses
    // the repeated-title and identity-history checks; a series DEBUT
    // bypasses repeated-title only (prior shipped history disproves debut).
    const starred = event.admin_status === 'featured';
    const debut = event.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event);
    if (!approved || !inIssueWindow
        || (!starred && !debut && repeatedTitles.has(normalizeDigestTitle(event.title)))
        || !isEligibleForFreshDigest(event, reference)
        || (!starred && isPreviouslyFeaturedIdentity(event, featuredHistory, reference))) {
      errors.push(`Locked event is no longer eligible: ${event.title || event.id}.`);
      continue;
    }
    eligible.push(event);
  }

  if (dedupeDigestEvents(eligible).length !== eligible.length) {
    errors.push('Flagship draft contains duplicate event identities.');
  }

  return { valid: errors.length === 0, errors, events: eligible, flagship: true };
}

/**
 * Pre-engine sends have newsletter_type=NULL. A legacy row linked from the
 * flagship calendar is still a flagship and must not bypass cadence/lineup
 * gates merely because its type predates the registry. Undefined is kept
 * distinct for old test fixtures and unsaved objects; only persisted NULL
 * rows with a calendar relationship are promoted.
 */
async function isFlagshipSend(send, { knex = db } = {}) {
  if (isFlagshipType(send?.newsletter_type)) return true;
  if (send?.newsletter_type !== null || !send?.id) return false;
  const linked = await knex('newsletter_calendar').where({ send_id: send.id }).first('id');
  return Boolean(linked);
}

async function validateFlagshipEventSelection(send, { knex = db, reference = new Date() } = {}) {
  const flagship = await isFlagshipSend(send, { knex });
  if (!flagship) return { valid: true, errors: [], events: [], flagship: false };
  const typedSend = isFlagshipType(send?.newsletter_type)
    ? send
    : { ...send, newsletter_type: FLAGSHIP_TYPE_KEY };
  const ids = parseLockedEventIds(send.event_ids);
  if (!ids.length || ids.some((id) => !UUID_RE.test(id))) {
    return assessFlagshipEventSelection(typedSend, [], reference);
  }

  const rows = await knex('events_raw')
    .select(
      'id', 'title', 'description', 'admin_status', 'start_at', 'end_at',
      'event_url', 'event_type', 'recurrence_type', 'freshness_status',
      'times_featured', 'last_featured_at', 'pulled_at', 'merged_into',
    )
    .whereIn('id', [...new Set(ids)]);
  const featuredHistory = await loadFeaturedIdentityHistory(knex);
  const routineIdentityPool = await loadRoutineIdentityPool(knex, reference);
  return assessFlagshipEventSelection(typedSend, rows, reference, featuredHistory, routineIdentityPool);
}

module.exports = {
  parseLockedEventIds,
  isPreviouslyFeaturedIdentity,
  loadFeaturedIdentityHistory,
  filterPreviouslyFeaturedIdentities,
  repeatedDateTitleKeys,
  loadRoutineIdentityPool,
  filterRepeatedDateIdentities,
  assessFlagshipEventSelection,
  isFlagshipSend,
  validateFlagshipEventSelection,
};
