'use strict';

/**
 * New-home mail list (admin, read only): the rows the new-home run keeps in mail_prospects
 * (services/mail/new-home-list.js, stored by services/mail/prospect-store.js), one row per deed of the Manatee County
 * Clerk's public daily deed list. Three views:
 *   live          eligible (gets a postcard in a later build step) and held_back (one home in five: the comparison group,
 *                 which gets none)
 *   not_eligible  a deed that is not a new home for a person, with the reason (a company or trust buyer, no new-home permit)
 *   unmatched     a deed the run could not tie to a parcel yet, with the reason
 * The counts and the reasons cover the whole list, whatever the view. It sends nothing and calls no AI. The sale price, the
 * sellers, the parcel and permit numbers and the deed's instrument number stay in the table: none is returned.
 *
 * Each row also carries its shadow price (mailer step 2b): the quarterly pest plan price the price pass
 * (services/mail/home-price.js) stored, the home facts it used, and why a home has no price. Nothing is sent or quoted to
 * anyone from it. The engine digest stays in the table.
 *
 * A live row also carries its page slug (mailer step 2d-2): the short typed address the postcard prints, shown as
 * "gowavesfl.com/<slug>" (null until the home has one).
 */

const db = require('../../models/db');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const VIEWS = ['live', 'not_eligible', 'unmatched'];
const VIEW_STATUSES = { live: ['eligible', 'held_back'], not_eligible: ['not_eligible'], unmatched: ['unmatched'] };
// The list is a few new homes a day, so 300 rows is a few weeks; the cap only guards the page. The counts cover the whole
// list either way.
const ROW_LIMIT = 300;
// A pg DATE read as a JS Date can slip a day, so a date is read as text.
const DAY = (column) => `to_char(${column}, 'YYYY-MM-DD')`;
// pg numeric comes back as text.
const num = (value) => (value == null ? null : Number(value));
const iso = (value) => (value == null ? null : new Date(value).toISOString());

function toPrice(row) {
  const annual = num(row.price_annual);
  return {
    status: row.price_status || 'untried',
    reason: row.price_reason || null,
    annual,
    // The plan is billed monthly: the card and the home's page show the monthly price.
    // From whole cents: a float division can sit just under a half cent (1250.10 / 12 * 100 = 10417.4999...).
    monthly: annual == null ? null : Math.round(Math.round(annual * 100) / 12) / 100,
    setupFee: num(row.price_setup_fee),
    homeSqft: num(row.home_sqft),
    sizeSource: row.home_sqft_source || null,
    stories: num(row.home_stories),
    lotSqft: num(row.lot_sqft),
    pricedAt: iso(row.priced_at),
    checkedAt: iso(row.price_checked_at),
  };
}

function toRow(row) {
  return {
    id: row.id,
    recordedDate: row.recorded_day,
    status: row.status,
    reason: row.reason || null,
    recipientNames: Array.isArray(row.recipient_names) ? row.recipient_names : [],
    addressLine1: row.address_line1 || null,
    city: row.city || null,
    zip: row.zip || null,
    pageSlug: row.page_slug || null,
    mailedAt: iso(row.mailed_at),
    mailBatch: row.mail_batch || null,
    typedViews: Number(row.page_typed_views) || 0,
    subdivision: row.subdivision || null,
    matchBasis: row.match_basis || null,
    coDate: row.co_day || null,
    livingSqft: row.living_sqft == null ? null : Number(row.living_sqft),
    legalDescription: row.legal_description || null,
    price: toPrice(row),
  };
}

/**
 * The list for one view: newest recorded deed first, then address, at most ROW_LIMIT rows (truncated says more matched).
 * The rows and the totals come from one snapshot (a read-only REPEATABLE READ transaction), so a run that commits between
 * the two reads cannot split them.
 * @returns {Promise<{ view: string, counts: { eligible: number, heldBack: number, notEligible: number, unmatched: number },
 *   priceCounts: { priced: number, notClean: number, missingFact: number, failed: number, untried: number },
 *   reasons: { status: string, reason: string|null, count: number }[], newestRecordedDate: string|null,
 *   lastCheckedAt: string|null, rows: object[], truncated: boolean }>}
 */
async function listMailProspects({ view = VIEWS[0] } = {}) {
  if (!VIEWS.includes(view)) throw new Error('unknown view');
  // One read at a time: a transaction is one connection, and the pg driver deprecates a query sent while another runs.
  const [groups, priceGroups, found] = await db.transaction(async (trx) => [
    await trx('mail_prospects')
      .where({ list_key: LIST_KEY })
      .groupBy('status', 'reason')
      .select('status', 'reason', trx.raw('count(*) AS total'),
        trx.raw(`${DAY('max(recorded_date)')} AS newest_day`), trx.raw('max(last_checked_at) AS last_checked')),
    await trx('mail_prospects')
      .where({ list_key: LIST_KEY })
      .where({ status: 'eligible' })
      .groupBy('price_status')
      .select('price_status', trx.raw('count(*) AS total')),
    await trx('mail_prospects')
      .where({ list_key: LIST_KEY })
      .whereIn('status', VIEW_STATUSES[view])
      .orderBy([{ column: 'recorded_date', order: 'desc' }, { column: 'address_line1', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(ROW_LIMIT + 1)
      .select('id', 'status', 'reason', 'recipient_names', 'address_line1', 'city', 'zip', 'page_slug', 'mailed_at', 'mail_batch', 'page_typed_views', 'subdivision', 'match_basis',
        'living_sqft', 'legal_description', 'price_status', 'price_reason', 'price_annual', 'price_setup_fee', 'home_sqft',
        'home_sqft_source', 'home_stories', 'lot_sqft', 'priced_at', 'price_checked_at',
        trx.raw(`${DAY('recorded_date')} AS recorded_day`), trx.raw(`${DAY('co_date')} AS co_day`)),
  ], { isolationLevel: 'repeatable read', readOnly: true });

  // count() is a bigint: the driver gives a string.
  const total = (status) => groups.filter((g) => g.status === status).reduce((sum, g) => sum + Number(g.total), 0);
  const counts = { eligible: total('eligible'), heldBack: total('held_back'), notEligible: total('not_eligible'), unmatched: total('unmatched') };
  // The price pass on the eligible homes, whatever the view (the pass prices only those: held-back homes get no card).
  // An untried home has price_status NULL.
  const priceTotal = (status) => priceGroups.filter((g) => (g.price_status || null) === status).reduce((sum, g) => sum + Number(g.total), 0);
  const priceCounts = {
    priced: priceTotal('priced'), notClean: priceTotal('not_clean'), missingFact: priceTotal('missing_fact'),
    failed: priceTotal('failed'), untried: priceTotal(null),
  };
  const reasons = groups
    .filter((g) => g.status === 'not_eligible' || g.status === 'unmatched')
    .map((g) => ({ status: g.status, reason: g.reason || null, count: Number(g.total) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status) || String(a.reason).localeCompare(String(b.reason)));
  // Day text sorts the same as the day.
  const newestRecordedDate = groups.reduce((best, g) => (g.newest_day && (!best || g.newest_day > best) ? g.newest_day : best), null);
  const checked = groups.map((g) => g.last_checked).filter(Boolean).map((at) => new Date(at).getTime());
  const lastCheckedAt = checked.length ? new Date(Math.max(...checked)).toISOString() : null;
  return {
    view, counts, priceCounts, reasons, newestRecordedDate, lastCheckedAt,
    rows: found.slice(0, ROW_LIMIT).map(toRow),
    truncated: found.length > ROW_LIMIT,
  };
}

module.exports = { VIEWS, listMailProspects, toPrice };
