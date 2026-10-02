'use strict';
// ONE live answer to "does a third-party payer own this invoice RIGHT NOW?" (Codex round-39 P1, PR #5331).
//
// invoices.payer_id is a snapshot taken at creation: a payer assigned through the scheduled service or the customer
// default AFTER the invoice was minted leaves it NULL, so the raw column (or the withdrawal stamp) alone misclassifies
// an AP-owned invoice as the homeowner's. The pay page's Zelle visibility check, the SMS draft-time Zelle fetch, the
// send-time Zelle recheck AND the SMS invoice-status facts (context-aggregator) all ask this one function, so none of
// them can disagree about whose debt an invoice is.
//
//   null              -> verifiably the homeowner's (self-pay)
//   'payer_owned'     -> stamped payer_id / payer_statement_id, or the live resolver names a payer
//   'payer_unverifiable' -> no customer to resolve for, or the resolver failed: ownership is UNKNOWN (fail closed)
const db = require('../models/db');
const logger = require('./logger');

async function invoicePayerOwnership(inv, dbh = db) {
  if (inv.payer_id || inv.payer_statement_id) return 'payer_owned';
  if (!inv.customer_id) return 'payer_unverifiable';
  try {
    const resolved = await require('./payer').resolveForInvoice({
      database: dbh,
      customerId: String(inv.customer_id),
      ...(inv.scheduled_service_id ? { scheduledServiceId: String(inv.scheduled_service_id) } : {}),
      throwOnError: true,
    });
    return resolved?.payerId ? 'payer_owned' : null;
  } catch (err) {
    logger.warn(`[invoice-payer-ownership] payer ownership check failed for invoice ${inv.id}: ${err.message}; treating as unverifiable`);
    return 'payer_unverifiable';
  }
}

// Batch form for a list of one customer's invoice rows (must carry scheduled_service_id / payer_statement_id when they
// exist). Resolution depends only on (customer, scheduled service), so it is memoized per service. Returns
// { ownedIds: Set<string> (payer-owned), unverifiable: boolean }. `ownLimit` (optional) stops resolving once that many
// rows are verified self-pay (rows after that point are left unjudged — the caller only ever shows its first `ownLimit - 1`),
// EXCEPT rows `alwaysJudge(row)` names (Codex round-40 P1: every row that can feed the owed balance must carry a live verdict
// however far down the list it sits — the display cap is for the status LIST only).
// `maxResolutions` (Codex round-43 P1): a hard cap on the number of LIVE resolver lookups one call may make (distinct scheduled
// services). Past it the verdict is UNVERIFIABLE (fail closed) - never an unbounded serial walk of a mature account's history.
// `byCandidatePayer` (Codex round-47 P2): for a LONG history (every visit its own scheduled service), memoize by the payer each
// service WOULD bill instead of by service. resolveForInvoice's candidate is the service's payer_id, else - unless the visit is
// pinned self-pay - the customer's default payer; with no candidate it is self-pay. Two batched reads give every service's candidate,
// then the real resolver runs ONCE per distinct candidate payer (it alone decides active / inactive). A failed read => unverifiable.
async function candidatePayerKeys(customerId, rows, dbh) {
  const payer = require('./payer');
  const ssIds = [...new Set(rows.filter((r) => !(r.payer_id || r.payer_statement_id) && r.scheduled_service_id).map((r) => String(r.scheduled_service_id)))];
  const cust = await dbh('customers').where({ id: customerId }).first('payer_id');
  const cols = ['id', 'payer_id'];
  if (ssIds.length && await payer.scheduledServicesHasSelfPay(dbh)) cols.push('self_pay_override');
  const services = ssIds.length ? await dbh('scheduled_services').where({ customer_id: customerId }).whereIn('id', ssIds).select(cols) : [];
  const byId = new Map((services || []).map((ss) => [String(ss.id), ss]));
  return (inv) => {
    const ss = inv.scheduled_service_id ? byId.get(String(inv.scheduled_service_id)) : null;
    const candidate = ss?.payer_id || (ss?.self_pay_override === true ? null : cust?.payer_id) || null;
    return candidate == null ? 'self' : `payer:${candidate}`;
  };
}

// One row's verdict, memoized per key (scheduled service, or candidate payer); a stamped row needs no lookup. Past maxResolutions
// live lookups it answers CAP_HIT (the batch is then unverifiable).
const CAP_HIT = Symbol('cap_hit');
function memoizedVerdict({ customerId, dbh, memo, candidateKey, maxResolutions }) {
  let resolutions = 0;
  return async (inv) => {
    const keyed = !(inv.payer_id || inv.payer_statement_id);
    const key = keyed ? (candidateKey ? candidateKey(inv) : String(inv.scheduled_service_id || '')) : null;
    if (keyed && memo.has(key)) return memo.get(key);
    if (resolutions >= maxResolutions) return CAP_HIT;
    resolutions += 1;
    const verdict = await invoicePayerOwnership({ ...inv, customer_id: inv.customer_id || customerId }, dbh);
    if (keyed) memo.set(key, verdict);
    return verdict;
  };
}

async function liveInvoiceOwnership(customerId, rows, dbh = db, { ownLimit = Infinity, alwaysJudge = null, maxResolutions = Infinity, byCandidatePayer = false } = {}) {
  const ownedIds = new Set();
  let unverifiable = false;
  let own = 0;
  const memo = new Map();
  let candidateKey = null;
  if (byCandidatePayer) {
    try {
      candidateKey = await candidatePayerKeys(customerId, rows, dbh);
    } catch (err) {
      logger.warn(`[invoice-payer-ownership] batched payer read failed for customer ${customerId}: ${err.message}; treating as unverifiable`);
      return { ownedIds, unverifiable: true };
    }
    memo.set('self', null); // no candidate payer anywhere => resolveForInvoice returns self-pay without a payer lookup
  }
  const judge = memoizedVerdict({ customerId, dbh, memo, candidateKey, maxResolutions });
  for (const inv of rows) {
    if (own >= ownLimit && !(typeof alwaysJudge === 'function' && alwaysJudge(inv))) continue;
    const verdict = await judge(inv);
    if (verdict === CAP_HIT) { unverifiable = true; break; }
    if (verdict === 'payer_owned') ownedIds.add(String(inv.id));
    else if (verdict) unverifiable = true;
    else own += 1;
  }
  return { ownedIds, unverifiable };
}

module.exports = { invoicePayerOwnership, liveInvoiceOwnership };
