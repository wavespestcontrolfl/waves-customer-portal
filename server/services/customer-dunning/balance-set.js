'use strict';

/**
 * The single set authority for customer-level overdue reminders (dunning
 * consolidation, PR 1: inert — nothing on a live path imports this yet).
 *
 * resolveDunnableSet(customerId) answers ONE question — "which invoices would
 * the pay page charge together if this customer followed a reminder link
 * today, and may we tell them about it?" — by re-running the pay page's OWN
 * authority (open-balance.js `openBalanceInvoices` for the open set,
 * pay-combined.js `combinedEligibleSiblings` for the combined set, and pay-v2's
 * anchor predicates) rather than a narrower parallel predicate. The message,
 * the pay page and the provider-handoff re-check (boundary.js, a later PR) can
 * then never disagree about what a touch names (Codex #5188/#5270 class 2:
 * A-1, A-6, A-12, A-13, B-1, B-4, B-15, B-16).
 *
 * PURE READ. No credit apply, no short-link mint, no writes. `database` is
 * honoured on EVERY query and on every helper it calls, so the boundary can
 * run it on the handoff's transaction handle (DB_POOL_MAX=2, Codex A-17).
 * Never throws: any failure is a `hold`, never a send.
 *
 * `applyCreditBeforeResolve` is the ONE writer in this file, kept apart on
 * purpose: only the runner calls it (never the boundary), before the set is
 * resolved, so the total the message names is already net of account credit
 * (Codex B-1).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const featureGates = require('../../config/feature-gates');
const { openBalanceInvoices } = require('../open-balance');
const PayCombined = require('../pay-combined');

// Which hold wins when several apply (highest first). payer_* = payer_anchor
// and payer_unresolved. 'none' is never a hold (it means genuinely single).
const HOLD_PRECEDENCE = Object.freeze([
  'balance_incomplete',
  'member_paused',
  'member_autopay_hold',
  'credit_covers_anchor',
  'anchor_reconciliation',
  'payer_anchor',
  'payer_unresolved',
  'incomplete',
  'over_cap',
  'gate_off',
]);

const pickHold = (reasons) => HOLD_PRECEDENCE.find((r) => reasons.includes(r)) || reasons[0];

const centsOf = (inv) => PayCombined.amountDueCents(inv);

// Total order for "oldest first": created_at, ties broken by id.
function compareOldestFirst(a, b) {
  const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
  const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
  if (ta !== tb) return ta - tb;
  const ia = String(a.id);
  const ib = String(b.id);
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}
const sortOldestFirst = (rows) => [...rows].sort(compareOldestFirst);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * sha256(anchor.id | sorted "invoiceId:cents") — the identity of a set as the
 * page would charge it. Any change to membership, an amount (credit,
 * adjustment) or the anchor changes it.
 */
function setDigest(anchorId, members) {
  const parts = members.map((m) => `${m.invoice_id}:${m.cents}`).sort();
  return sha256(`${anchorId}|${parts.join(',')}`);
}

async function readSequences(invoiceIds, database) {
  const map = new Map();
  if (!invoiceIds.length) return map;
  const rows = await database('invoice_followup_sequences')
    .whereIn('invoice_id', invoiceIds)
    .select('id', 'invoice_id', 'status');
  for (const r of rows) map.set(String(r.invoice_id), { seqId: r.id, status: String(r.status || '').toLowerCase() });
  return map;
}

// True only for an invoice whose PaymentIntent is waiting on the customer to
// confirm two bank micro-deposits. `throwOnError` so an unreadable Stripe
// state is a hold (via resolveDunnableSet's catch), never a silent "no" — the
// default of this Stripe helper is fail-OPEN, which is right for a single
// invoice's nudge and wrong for a set the message will assert.
async function isMicrodepositPending(inv) {
  if (!featureGates.gates.divertMicrodepositDunning || !inv.stripe_payment_intent_id) return false;
  const StripeService = require('../stripe');
  return StripeService.isInvoiceAwaitingMicrodepositVerification(
    { id: inv.id, stripe_payment_intent_id: inv.stripe_payment_intent_id },
    { throwOnError: true },
  );
}

// Every non-stopped open invoice is checked — never the anchor only (B-9).
async function microdepositPendingIds(open, seqMap) {
  const ids = new Set();
  for (const inv of open) {
    if (seqMap.get(String(inv.id))?.status === 'stopped') continue;
    if (await isMicrodepositPending(inv)) ids.add(String(inv.id));
  }
  return ids;
}

/**
 * Classify the open invoices by their sequence row.
 *   stopped -> excluded (the page excludes stopped siblings; never an anchor)
 *   md      -> excluded (the page excludes a verify-with-microdeposits PI as
 *              live; never an anchor; never nudged by this engine)
 *   otherwise a member: seqStatus active|paused|autopay_hold|completed|none;
 *   `quiet` = completed or no row (named in count/total because the page
 *   charges it, never a cadence driver).
 */
function classifyOpen(open, seqMap, mdIds) {
  const members = [];
  const excluded = { stopped: [], md: [] };
  for (const inv of open) {
    const id = String(inv.id);
    const seq = seqMap.get(id);
    if (seq?.status === 'stopped') { excluded.stopped.push(id); continue; }
    if (mdIds.has(id)) { excluded.md.push(id); continue; }
    members.push(memberOf(inv, seq));
  }
  return { members, excluded };
}

function memberOf(inv, seq) {
  const seqStatus = seq?.status || 'none';
  return {
    invoice_id: String(inv.id),
    cents: centsOf(inv),
    seqStatus,
    quiet: seqStatus === 'completed' || seqStatus === 'none',
    seq_id: seq?.seqId || null,
  };
}

// The anchor's hold reason for a member-predicate verdict.
const ANCHOR_HOLD_BY_REASON = Object.freeze({
  not_collectible: 'balance_incomplete',
  payer_billed: 'payer_anchor',
  withdrawn: 'payer_anchor',
  deposit_settlement: 'anchor_reconciliation',
  charge_reconciliation: 'anchor_reconciliation',
});

// The pay-v2 preview's own predicates on the anchor. Every per-member money
// check (status, payer, withdrawal, live payer, received-deposit settlement,
// charge reconciliation) is PayCombined.memberCollectionPending — the ONE
// predicate that also vets every sibling inside combinedEligibleSiblings, so
// anchor and siblings can never be judged by different rules. Only the
// credit-coverage probe is anchor-specific (the page's capture step). Returns a
// hold reason or null. Anything unreadable holds — never a send: a payer
// lookup failure is payer_unresolved, any other throw anchor_reconciliation.
async function anchorProblem(anchorRow, database) {
  let verdict = null;
  let unreadable = null;
  try {
    verdict = await PayCombined.memberCollectionPending(anchorRow, { database });
  } catch (err) {
    unreadable = err;
    logger.info(`[customer-dunning] anchor ${anchorRow.id} check unreadable (${err.code || err.memberCheck || 'error'}): ${err.message}`);
  }
  const held = verdict ? ANCHOR_HOLD_BY_REASON[verdict.reason] : null;
  // Ownership / status verdicts stop before the credit probe, as the page's
  // preview does.
  if (held === 'balance_incomplete' || held === 'payer_anchor') return held;
  if (unreadable?.memberCheck === 'payer_resolve') return 'payer_unresolved';
  // credit_covers_anchor outranks the reconciliation holds (HOLD_PRECEDENCE).
  if (await PayCombined.invoiceCreditWouldFullyCover(anchorRow, { database })) return 'credit_covers_anchor';
  if (unreadable) return 'anchor_reconciliation';
  if (held) {
    logger.info(`[customer-dunning] anchor ${anchorRow.id} fenced (${verdict.code || verdict.reason})`);
    return held;
  }
  return null;
}

// combinedEligibleSiblings with its degrade reason captured. `reason` is null
// when the combined flow engaged (siblings is an array); 'none' = genuinely
// single; anything else is a degrade the caller must hold on.
async function readSiblings(anchorRow, database) {
  let reason = null;
  const siblings = await PayCombined.combinedEligibleSiblings(anchorRow, {
    database,
    // Same as pay-v2's GET preview: a sibling stamped with the anchor's own
    // PaymentIntent stays included, or a page reload would shed it.
    reusePaymentIntentId: anchorRow.stripe_payment_intent_id || null,
    onDegrade: (r) => { reason = r; },
    // Pure read: the sibling reconciliation fence must not release or
    // promote stale saved-card claims from here (pre-push P1).
    readOnly: true,
  });
  return { siblings: siblings || [], reason: siblings ? null : (reason || 'incomplete') };
}

// A sibling the open read did not see (race) needs its own sequence status.
async function sequencesForSiblings(siblings, seqMap, database) {
  const missing = siblings.map((s) => String(s.id)).filter((id) => !seqMap.has(id));
  if (!missing.length) return seqMap;
  const extra = await readSequences(missing, database);
  return new Map([...seqMap, ...extra]);
}

function anchorSummary(anchorRow) {
  return {
    id: String(anchorRow.id),
    token: anchorRow.token,
    invoice_number: anchorRow.invoice_number,
    title: anchorRow.title,
    service_date: anchorRow.service_date,
    due_date: anchorRow.due_date,
  };
}

function result(kind, reason, parts = {}) {
  return {
    kind,
    reason: reason || null,
    anchor: null,
    members: [],
    totalCents: 0,
    digest: null,
    activeCount: 0,
    excluded: { stopped: [], md: [] },
    ...parts,
  };
}

function memberHolds(members) {
  const holds = [];
  if (members.some((m) => m.seqStatus === 'paused')) holds.push('member_paused');
  if (members.some((m) => m.seqStatus === 'autopay_hold')) holds.push('member_autopay_hold');
  return holds;
}

// Steps 5-6: the anchor's predicates, then the page's sibling set. Returns
// the anchor's hold reasons and the sibling rows.
async function anchorAndSiblings(anchorRow, database) {
  const holds = [];
  const problem = await anchorProblem(anchorRow, database);
  if (problem) holds.push(problem);
  // A non-collectible / payer-owned / credit-covered anchor: the page would
  // not combine, so there is no sibling set to compute.
  if (problem) return { holds, siblings: [] };
  const { siblings, reason } = await readSiblings(anchorRow, database);
  if (reason && reason !== 'none') holds.push(reason);
  return { holds, siblings };
}

async function resolveUnguarded(customerId, database, now) {
  let incomplete = false;
  // Oldest first with a total order (created_at, then id): the open read sorts
  // on created_at alone, so two invoices with equal timestamps could swap
  // anchor (and member order) between runs. Sorted here so the anchor and the
  // digest depend only on the data, never on the order the rows came back in.
  const open = sortOldestFirst(await openBalanceInvoices(customerId, {
    database,
    onResolveFailure: () => { incomplete = true; },
    onTruncation: () => { incomplete = true; },
  }));
  if (incomplete) return result('hold', 'balance_incomplete');
  if (!open.length) return result('empty', 'no_open_invoices');

  const seqMap = await readSequences(open.map((i) => i.id), database);
  const mdIds = await microdepositPendingIds(open, seqMap);
  const { members: candidates, excluded } = classifyOpen(open, seqMap, mdIds);
  if (!candidates.length) return result('empty', 'all_excluded', { excluded });

  const anchorId = candidates[0].invoice_id;
  // The open read carries no token/title/payer columns; the anchor needs the
  // full row (also what combinedEligibleSiblings and the credit probe read).
  const anchorRow = await database('invoices').where({ id: anchorId }).first();
  if (!anchorRow) return result('hold', 'balance_incomplete', { excluded });

  const { holds, siblings } = await anchorAndSiblings(anchorRow, database);
  const fullSeq = await sequencesForSiblings(siblings, seqMap, database);
  // The anchor's cents come from the FRESH full row (the same one the credit
  // probe read), so a credit landing between the two reads cannot leave a
  // stale figure in the digest.
  const members = [
    memberOf(anchorRow, seqMap.get(anchorId)),
    ...sortOldestFirst(siblings).map((s) => memberOf(s, fullSeq.get(String(s.id)))),
  ];
  const parts = {
    anchor: anchorSummary(anchorRow),
    members,
    totalCents: members.reduce((sum, m) => sum + m.cents, 0),
    digest: setDigest(String(anchorRow.id), members),
    activeCount: members.filter((m) => m.seqStatus === 'active').length,
    excluded,
    asOf: now.toISOString(),
  };
  const allHolds = [...memberHolds(members), ...holds];
  if (allHolds.length) return result('hold', pickHold(allHolds), parts);
  return result(members.length >= 2 ? 'multi' : 'single', null, parts);
}

/**
 * @param {string} customerId
 * @param {{ database?: object, now?: Date }} [opts]
 * @returns {Promise<{
 *   kind: 'multi'|'single'|'empty'|'hold',
 *   reason: string|null,
 *   anchor: {id, token, invoice_number, title, service_date, due_date}|null,
 *   members: Array<{invoice_id, cents, seqStatus, quiet, seq_id}>,
 *   totalCents: number, digest: string|null, activeCount: number,
 *   excluded: {stopped: string[], md: string[]},
 * }>}
 */
async function resolveDunnableSet(customerId, { database = db, now = new Date() } = {}) {
  try {
    return await resolveUnguarded(customerId, database, now);
  } catch (err) {
    logger.warn(`[customer-dunning] set resolve failed for customer ${customerId}: ${err.message} — holding`);
    return result('hold', 'balance_incomplete');
  }
}

/**
 * RUNNER ONLY, never at the boundary. Draws the customer's account credit
 * onto their open invoices (oldest first) before the set is resolved, the
 * same auto-apply fireTouch runs per invoice today, so the reminder's total is
 * net of credit. Only invoices whose sequence is active or absent are drawn
 * (not stopped, paused, autopay-held, completed or microdeposit-pending).
 * Returns the draws `[{ invoiceId, amount }]` so the caller can reverse them
 * (customer-credit.reverseAppliedCredit) when nothing was delivered.
 *
 * Deliberately takes NO database handle: every draw is its own transaction,
 * committed here. autoApplyAccountCreditIfEnabled only runs the full-coverage
 * side effects (stop dunning, activate an annual-prepay term) when it owns the
 * transaction; handed a caller's `trx` it skips them and leaves them to that
 * caller, so threading a handle in would strand a credit-covered invoice with
 * dunning still armed. The reads below use the shared pool for the same reason
 * (a draw must never be visible only inside an uncommitted caller handle).
 *
 * The reads below only choose CANDIDATES. Every eligibility decision that
 * matters is re-made inside each draw's own locked transaction (`dunningDraw`
 * in customer-credit.js): collection fence, sequence active/none and live payer.
 * The apply's own unconditional locked guard 'has_payment_intent' (any
 * attached PaymentIntent, checked on the locked invoice row for EVERY caller)
 * also covers what the microdeposit pre-check below looks for: a microdeposit
 * wait needs an attached PI, so the unlocked Stripe read is only an early skip.
 */
async function applyCreditBeforeResolve(customerId) {
  const { autoApplyAccountCreditIfEnabled } = require('../customer-credit');
  const draws = [];
  const open = await openBalanceInvoices(customerId, { database: db });
  const seqMap = await readSequences(open.map((i) => i.id), db);
  for (const inv of open) {
    const status = seqMap.get(String(inv.id))?.status || 'none';
    if (status !== 'active' && status !== 'none') continue;
    let mdPending = true; // unreadable = do not draw
    try { mdPending = await isMicrodepositPending(inv); } catch (err) {
      logger.warn(`[customer-dunning] credit draw skipped for invoice ${inv.id}: microdeposit state unreadable: ${err.message}`);
    }
    if (mdPending) continue;
    // dunningDraw: the pre-read above only chose this invoice as a CANDIDATE.
    // Inside the draw's own transaction, under the invoice lock, it re-decides
    // the collection fence, the sequence status (active / none) and the live
    // payer — a decision made from this earlier read could race a saved-card
    // submit, a stop / pause, or a payer assignment landing in between.
    const drawn = await autoApplyAccountCreditIfEnabled(inv.id, { dunningDraw: true });
    if (drawn?.applied > 0) draws.push({ invoiceId: String(inv.id), amount: drawn.applied });
  }
  return draws;
}

module.exports = {
  resolveDunnableSet,
  applyCreditBeforeResolve,
  setDigest,
  HOLD_PRECEDENCE,
};
