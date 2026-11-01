/**
 * Nightly lead repeat sweep: GATE_LEAD_REPEAT_SWEEP (owner 2026-11-01, Action
 * inbox agents "A": "nightly fixers for ... lead status").
 *
 * The Action Inbox item "N leads waiting over 30m for first contact" counts
 * every unanswered `new` lead, so a person who reran the quote wizard five
 * times, or called twice in one evening, reads as five or two people waiting.
 * The repeats also stall the person's real lead: the live conversion and
 * contact paths (convertLeadFromEvent, the call processor) refuse to pick one
 * of several open leads on one customer, so the person's visit never closes
 * the lead.
 *
 * This sweep files such a repeat as `duplicate` of the person's open lead, the
 * way an operator does on the Leads page (a status_change history row, then
 * the funnel bridge after commit), and stamps the same
 * extracted_data.duplicate_of_lead_id marker the wizard's repeat-run dedupe
 * writes, so every ancestry reader (followDuplicateLink, scopeToProspects)
 * resolves the repeat to its root.
 *
 * Positive evidence only. A waiting lead L is filed as a repeat of root R when
 * ALL hold:
 *  - L is in the waiting queue (applyLeadsAwaitingContactFilter, the inbox's
 *    own definition) and carries a 10-digit phone;
 *  - an earlier live lead with the same phone (last 10 digits), first touched
 *    at most REPEAT_WINDOW_DAYS before L, resolves through followDuplicateLink
 *    to R;
 *  - R is live, still open (OPEN_LEAD_STATUSES: a won, lost or otherwise
 *    closed earlier lead makes L a new opportunity, never a repeat), has the
 *    same phone, and first touched before L;
 *  - the names agree positively (namesCompatible, and a first or last name is
 *    present on both rows);
 *  - they are not two customer rows (both linked means the same customer_id)
 *    and not two properties (both carry a parsable street means the same
 *    street key, and the same unit and ZIP where both have one);
 *  - exactly one such R exists (two open roots that both fit would be a
 *    household or business line: a human decides).
 * Anything else stays waiting. Nothing here texts, calls, books or charges;
 * no first-response time is stamped (nobody responded). Every write re-reads
 * the lead and its root under row locks (taken in id order, held to commit),
 * pins the identity the decision read, and re-checks the root.
 */

const db = require('../models/db');
const logger = require('./logger');
const { leadRepeatSweepLive } = require('../config/feature-gates');
const { OPEN_LEAD_STATUSES } = require('./lead-statuses');
const { applyLeadsAwaitingContactFilter } = require('./lead-waiting-queue');
const { namesCompatible, normName, normalizeStreetKey } = require('./customer-dedupe');
const { leadAddressFields } = require('../utils/address-normalizer');
const { followDuplicateLink } = require('./lead-estimate-link');
const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');

const REPEAT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// The run pages through every candidate (keyset on first_contact_at, id), so a
// lead kept on an earlier run never hides a newer one. MAX_PAGES only bounds a
// runaway queue; WRITE_CAP bounds the filings per run.
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const WRITE_CAP = 50;
// Earlier same-phone leads read per waiting lead. More than this is a busy
// shared line: the lead stays waiting rather than being judged on a partial read.
const EARLIER_LIMIT = 25;
const PERFORMED_BY = 'Lead repeat sweep';
const phoneLast10Sql = (column) => `right(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;
const PHONE_LAST10_SQL = phoneLast10Sql('phone');
// The identity a filing decision read. The locked re-read must match it, so a
// staff edit between the read and the write wins.
const PINNED_COLUMNS = ['status', 'phone', 'customer_id', 'first_name', 'last_name', 'address', 'city', 'zip', 'response_time_minutes'];

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Compatible (no part conflicts) AND a first or last name present on both:
// two unnamed rows sharing a phone are not proof of one person.
function namesAgree(a, b) {
  if (!namesCompatible(a, b)) return false;
  return ['first_name', 'last_name'].some((key) => normName(a[key]) && normName(b[key]));
}

// The lead's street as the customer dedupe keys it. leadAddressFields splits a
// one-line form address the way the form split it; a call's partial address
// ("12912") parses to no street and so is no evidence either way.
function premiseOf(lead) {
  const fields = leadAddressFields(lead);
  const street = normalizeStreetKey(fields.line1);
  if (!street) return null;
  return { key: street.key, unit: street.unit || null, zip: String(fields.zip || '').slice(0, 5) || null };
}

// Two properties: both rows carry a parsable street and a part differs.
function differentPremise(a, b) {
  const pa = premiseOf(a);
  const pb = premiseOf(b);
  if (!pa || !pb) return false;
  if (pa.key !== pb.key) return true;
  if (pa.unit && pb.unit && pa.unit !== pb.unit) return true;
  return Boolean(pa.zip && pb.zip && pa.zip !== pb.zip);
}

function differentCustomer(a, b) {
  return Boolean(a.customer_id && b.customer_id && String(a.customer_id) !== String(b.customer_id));
}

function firstTouchMs(lead) {
  return new Date(lead.first_contact_at || lead.created_at).getTime();
}

// Whether open lead `root` is the same person's earlier lead. Pure.
function isSamePersonRoot(lead, root) {
  const leadPhone = phoneLast10(lead.phone);
  return Boolean(leadPhone)
    && phoneLast10(root.phone) === leadPhone
    && firstTouchMs(root) < firstTouchMs(lead)
    && namesAgree(lead, root)
    && !differentCustomer(lead, root)
    && !differentPremise(lead, root);
}

// extracted_data must be a JSON object (or empty) for the marker merge; any
// other stored shape is left for a human rather than overwritten.
function mergeableExtractedData(value) {
  return value == null || (typeof value === 'object' && !Array.isArray(value));
}

/**
 * The open root a waiting lead repeats: { root } or { reason }.
 * Reads fresh rows, so a repeat this run already filed resolves through its
 * new marker to the same root instead of reading as a second open lead.
 */
async function resolveRepeatRoot(database, lead) {
  const phone = phoneLast10(lead.phone);
  if (!phone || !lead.first_contact_at) return { reason: 'no_phone' };
  const firstContact = new Date(lead.first_contact_at);
  const earlier = await database('leads')
    .whereNull('deleted_at')
    .whereNot('id', lead.id)
    .whereRaw(`${PHONE_LAST10_SQL} = ?`, [phone])
    .where('first_contact_at', '<', firstContact)
    .where('first_contact_at', '>=', new Date(firstContact.getTime() - REPEAT_WINDOW_DAYS * DAY_MS))
    .orderBy('first_contact_at', 'asc')
    .orderBy('id', 'asc')
    .limit(EARLIER_LIMIT + 1)
    .select('*');
  if (!earlier.length) return { reason: 'not_repeat' };
  if (earlier.length > EARLIER_LIMIT) return { reason: 'busy_line' };

  const roots = new Map();
  for (const row of earlier) {
    const root = await followDuplicateLink(database, row);
    if (!root || root.deleted_at || String(root.id) === String(lead.id)) continue;
    if (!OPEN_LEAD_STATUSES.includes(root.status)) continue;
    if (isSamePersonRoot(lead, root)) roots.set(String(root.id), root);
  }
  if (roots.size === 0) return { reason: 'no_open_same_person_root' };
  if (roots.size > 1) return { reason: 'ambiguous' };
  return { root: [...roots.values()][0] };
}

function sameAsRead(current, read) {
  return PINNED_COLUMNS.every((key) => String(current[key] ?? '') === String(read[key] ?? ''));
}

/**
 * File one waiting lead as a duplicate of `root`, in one transaction under the
 * lead's row lock: status + marker, then the Leads page's status_change row.
 * The funnel bridge runs after commit, best-effort, as the Leads page runs it.
 */
async function fileRepeat(database, { lead, root }) {
  const outcome = await database.transaction(async (trx) => {
    // Lock the repeat AND its root through commit, in id order (one statement,
    // so every writer that locks both takes them in the same order): a root
    // closed, deleted or reassigned by a concurrent transaction is read after
    // that transaction commits, never before.
    const locked = await trx('leads').whereIn('id', [lead.id, root.id]).orderBy('id').forUpdate().select('*');
    const current = locked.find((row) => String(row.id) === String(lead.id));
    const currentRoot = locked.find((row) => String(row.id) === String(root.id));
    if (!current || current.deleted_at || !sameAsRead(current, lead)) return { filed: false, reason: 'lead_changed' };
    if (!mergeableExtractedData(current.extracted_data)) return { filed: false, reason: 'extracted_data_shape' };
    if (!currentRoot || currentRoot.deleted_at || !OPEN_LEAD_STATUSES.includes(currentRoot.status)
      || !isSamePersonRoot(current, currentRoot)) {
      return { filed: false, reason: 'root_changed' };
    }
    const updated = await trx('leads')
      .where({ id: lead.id, status: 'new' })
      .whereNull('deleted_at')
      .whereNull('response_time_minutes')
      .update({
        status: 'duplicate',
        extracted_data: trx.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ duplicate_of_lead_id: String(root.id) })]),
        updated_at: new Date(),
      });
    if (!updated) return { filed: false, reason: 'claim_lost' };
    await trx('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'status_change',
      description: 'Status: new → duplicate',
      performed_by: PERFORMED_BY,
      metadata: JSON.stringify({
        status: 'duplicate',
        previous_status: 'new',
        duplicate_of_lead_id: String(root.id),
        source: 'lead_repeat_sweep',
        reason: `Same phone and name as an open lead from the ${REPEAT_WINDOW_DAYS} days before`,
      }),
    });
    return { filed: true };
  });
  if (outcome.filed) {
    // Post-commit funnel mirror (duplicate collapses the repeat's own funnel
    // row), best-effort like the Leads page's PUT: the status already stands.
    try {
      await bridgeLeadFunnelStage(lead.id, 'duplicate', database);
    } catch (err) {
      logger.warn(`[lead-repeat-sweep] funnel bridge failed for lead ${lead.id} (status kept): ${err.message}`);
    }
  }
  return outcome;
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

// Waiting leads that have an earlier same-phone lead in the window: the only
// rows that can be repeats, so a queue of answered-by-nobody singles never
// costs a lookup each.
function repeatCandidatesQuery(dbi) {
  return applyLeadsAwaitingContactFilter(dbi('leads'), dbi)
    .whereRaw(`length(${PHONE_LAST10_SQL}) = 10`)
    .whereExists(function earlierSamePhone() {
      this.select(dbi.raw('1')).from('leads as earlier')
        .whereNull('earlier.deleted_at')
        .whereRaw('earlier.id <> leads.id')
        .whereRaw(`${phoneLast10Sql('earlier.phone')} = ${phoneLast10Sql('leads.phone')}`)
        .whereRaw('earlier.first_contact_at < leads.first_contact_at')
        .whereRaw(`earlier.first_contact_at >= leads.first_contact_at - interval '${REPEAT_WINDOW_DAYS} days'`);
    });
}

async function settleOne(dbi, lead, results) {
  try {
    const verdict = await resolveRepeatRoot(dbi, lead);
    if (!verdict.root) {
      bump(results.kept, verdict.reason);
      return;
    }
    const outcome = await fileRepeat(dbi, { lead, root: verdict.root });
    if (outcome.filed) {
      results.filed += 1;
      results.filings.push({ leadId: String(lead.id), rootId: String(verdict.root.id) });
    } else {
      bump(results.kept, outcome.reason);
    }
  } catch (err) {
    results.errors += 1;
    logger.warn(`[lead-repeat-sweep] lead ${lead.id} left waiting: ${err.message}`);
  }
}

/**
 * The nightly run. Candidates oldest first (a root is always judged before
 * its repeats, and each filing is read back by the next lookup), keyset-paged
 * through the whole queue, one transaction per filing, at most WRITE_CAP.
 */
async function runLeadRepeatSweep({ dbi = db, pageSize = PAGE_SIZE } = {}) {
  if (!leadRepeatSweepLive()) return { skipped: 'gate_off' };

  const results = { scanned: 0, filed: 0, kept: {}, errors: 0, filings: [] };
  let after = null;
  for (let page = 0; page < MAX_PAGES && results.filed < WRITE_CAP; page += 1) {
    const query = repeatCandidatesQuery(dbi);
    if (after) {
      query.where((next) => next.where('first_contact_at', '>', after.first_contact_at)
        .orWhere((tie) => tie.where('first_contact_at', after.first_contact_at).where('id', '>', after.id)));
    }
    const rows = await query.orderBy('first_contact_at', 'asc').orderBy('id', 'asc').limit(pageSize).select('*');
    for (const lead of rows) {
      if (results.filed >= WRITE_CAP) break;
      results.scanned += 1;
      await settleOne(dbi, lead, results);
    }
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1];
  }

  logger.info(`[lead-repeat-sweep] scanned=${results.scanned} filed=${results.filed} errors=${results.errors} kept=${JSON.stringify(results.kept)}`);
  return results;
}

module.exports = {
  runLeadRepeatSweep,
  resolveRepeatRoot,
  fileRepeat,
  isSamePersonRoot,
  _test: {
    REPEAT_WINDOW_DAYS,
    PAGE_SIZE,
    MAX_PAGES,
    WRITE_CAP,
    EARLIER_LIMIT,
    PERFORMED_BY,
    PINNED_COLUMNS,
    namesAgree,
    differentPremise,
    premiseOf,
    phoneLast10,
    mergeableExtractedData,
  },
};
