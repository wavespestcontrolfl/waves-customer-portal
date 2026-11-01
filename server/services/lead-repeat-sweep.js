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
 * the lead under its row lock, pins the identity the decision read, and
 * re-checks the root.
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
// Waiting leads read per run, and repeats filed per run.
const SCAN_LIMIT = 500;
const WRITE_CAP = 50;
// Earlier same-phone leads read per waiting lead. More than this is a busy
// shared line: the lead stays waiting rather than being judged on a partial read.
const EARLIER_LIMIT = 25;
const PERFORMED_BY = 'Lead repeat sweep';
const PHONE_LAST10_SQL = "right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)";
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
    const current = await trx('leads').where({ id: lead.id }).whereNull('deleted_at').forUpdate().first();
    if (!current || !sameAsRead(current, lead)) return { filed: false, reason: 'lead_changed' };
    if (!mergeableExtractedData(current.extracted_data)) return { filed: false, reason: 'extracted_data_shape' };
    const currentRoot = await trx('leads').where({ id: root.id }).whereNull('deleted_at').first();
    if (!currentRoot || !OPEN_LEAD_STATUSES.includes(currentRoot.status) || !isSamePersonRoot(current, currentRoot)) {
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

/**
 * The nightly run. Waiting leads oldest first (a root is always read before
 * its repeats), one transaction per filing, bounded by WRITE_CAP.
 */
async function runLeadRepeatSweep({ dbi = db } = {}) {
  if (!leadRepeatSweepLive()) return { skipped: 'gate_off' };

  const waiting = await applyLeadsAwaitingContactFilter(dbi('leads'), dbi)
    .whereRaw(`length(${PHONE_LAST10_SQL}) = 10`)
    .orderBy('first_contact_at', 'asc')
    .orderBy('id', 'asc')
    .limit(SCAN_LIMIT)
    .select('*');

  const results = { scanned: waiting.length, filed: 0, kept: {}, errors: 0, filings: [] };
  for (const lead of waiting) {
    if (results.filed >= WRITE_CAP) break;
    try {
      const verdict = await resolveRepeatRoot(dbi, lead);
      if (!verdict.root) {
        bump(results.kept, verdict.reason);
        continue;
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
    SCAN_LIMIT,
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
