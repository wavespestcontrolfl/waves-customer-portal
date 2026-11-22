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
    subdivision: row.subdivision || null,
    matchBasis: row.match_basis || null,
    coDate: row.co_day || null,
    livingSqft: row.living_sqft == null ? null : Number(row.living_sqft),
    legalDescription: row.legal_description || null,
  };
}

/**
 * The list for one view: newest recorded deed first, then address, at most ROW_LIMIT rows (truncated says more matched).
 * The rows and the totals come from one snapshot (a read-only REPEATABLE READ transaction), so a run that commits between
 * the two reads cannot split them.
 * @returns {Promise<{ view: string, counts: { eligible: number, heldBack: number, notEligible: number, unmatched: number },
 *   reasons: { status: string, reason: string|null, count: number }[], newestRecordedDate: string|null,
 *   lastCheckedAt: string|null, rows: object[], truncated: boolean }>}
 */
async function listMailProspects({ view = VIEWS[0] } = {}) {
  if (!VIEWS.includes(view)) throw new Error('unknown view');
  // One read at a time: a transaction is one connection, and the pg driver deprecates a query sent while another runs.
  const [groups, found] = await db.transaction(async (trx) => [
    await trx('mail_prospects')
      .where({ list_key: LIST_KEY })
      .groupBy('status', 'reason')
      .select('status', 'reason', trx.raw('count(*) AS total'),
        trx.raw(`${DAY('max(recorded_date)')} AS newest_day`), trx.raw('max(last_checked_at) AS last_checked')),
    await trx('mail_prospects')
      .where({ list_key: LIST_KEY })
      .whereIn('status', VIEW_STATUSES[view])
      .orderBy([{ column: 'recorded_date', order: 'desc' }, { column: 'address_line1', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(ROW_LIMIT + 1)
      .select('id', 'status', 'reason', 'recipient_names', 'address_line1', 'city', 'zip', 'subdivision', 'match_basis',
        'living_sqft', 'legal_description',
        trx.raw(`${DAY('recorded_date')} AS recorded_day`), trx.raw(`${DAY('co_date')} AS co_day`)),
  ], { isolationLevel: 'repeatable read', readOnly: true });

  // count() is a bigint: the driver gives a string.
  const total = (status) => groups.filter((g) => g.status === status).reduce((sum, g) => sum + Number(g.total), 0);
  const counts = { eligible: total('eligible'), heldBack: total('held_back'), notEligible: total('not_eligible'), unmatched: total('unmatched') };
  const reasons = groups
    .filter((g) => g.status === 'not_eligible' || g.status === 'unmatched')
    .map((g) => ({ status: g.status, reason: g.reason || null, count: Number(g.total) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status) || String(a.reason).localeCompare(String(b.reason)));
  // Day text sorts the same as the day.
  const newestRecordedDate = groups.reduce((best, g) => (g.newest_day && (!best || g.newest_day > best) ? g.newest_day : best), null);
  const checked = groups.map((g) => g.last_checked).filter(Boolean).map((at) => new Date(at).getTime());
  const lastCheckedAt = checked.length ? new Date(Math.max(...checked)).toISOString() : null;
  return {
    view, counts, reasons, newestRecordedDate, lastCheckedAt,
    rows: found.slice(0, ROW_LIMIT).map(toRow),
    truncated: found.length > ROW_LIMIT,
  };
}

module.exports = { VIEWS, listMailProspects };
