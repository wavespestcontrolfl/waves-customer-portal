/**
 * Zelle payment-notice reconciler (GATE_ZELLE_NOTICE_RECONCILE).
 *
 * A Capital One "Someone sent you money with Zelle" notice reaches contact@
 * through the owner's Gmail forwarding filter. The email sync calls
 * maybeHandleZelleNotice(email) as a DETERMINISTIC pre-classify step (money
 * never rides an LLM verdict). Decision order — hands-off rule (CLAUDE.md
 * 14): the one exact, corroborated match auto-applies silently with a full
 * audit trail; every exception parks for a human with the candidates it
 * found.
 *
 *   1. gate off                         → false (nothing read, email flows as today)
 *   2. not a notice (marker text)       → false
 *      initial-sync history (backfill)  → false (old notices are never a live
 *                                         money signal against today's invoices)
 *   3. untrusted sender                 → parked `sender_unverified`, return FALSE
 *                                         (normal classification / spam handling still runs)
 *   4. template not parseable           → parked `parse_failed`
 *   5. same payer + amount applied <14d → parked `possible_duplicate`
 *      (re-checked right before settlement; one invoice takes one notice —
 *      partial UNIQUE index — so two copies of one transfer never both settle);
 *      the matched customer already has a Zelle-paid invoice at these cents
 *      <14d (the operator recorded the transfer by hand before the sync saw
 *      the notice)               → parked `possible_duplicate`
 *      notice older than 48h when first decided (a sync outage, an expired
 *      Gmail history cursor)      → parked `stale_notice` — never auto-settled
 *                                   against today's invoices
 *   6. exact-cent open self-pay invoices (services/open-balance.js):
 *        memo carries exactly one of them → apply (memo_invoice_number)
 *        exactly one whose customer name corroborates the payer → apply (amount_name)
 *        none exact                         → parked `no_match`
 *        exact but none corroborate         → parked `name_mismatch`
 *        several corroborate                → parked `multiple_matches`
 *   7. apply = recordManualPayment(..., { method: 'zelle', sendReceipt: true,
 *      via: 'both' }) — the operator's Add-payment path, receipt included
 *      (owner ruling 2026-09-02, recorded on the gate). A refusal (PI in
 *      flight, lost race, …) parks `apply_failed` with the reason.
 *
 * At-most-once: the inbound_payment_notices row is claimed FIRST (email_id
 * UNIQUE, status 'processing', a fresh claim_token) and only the claimant
 * decides; a second sync of the same message can never apply twice. Every
 * settle / close / park update requires the claim_token, so a worker whose
 * claim was swept and RECLAIMED by the operator can never consume the new
 * claim. The notice row + emails.
 * auto_action stamp + the payments ledger row from recordManualPayment are
 * the audit trail. Silent on success (category 'payment' is bell-silent by
 * default); a parked notice raises the same silent feed row for the owner.
 */
const { randomUUID } = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const {
  isZelleNoticeCandidate, noticeText, parseZelleNotice, memoInvoiceNumbers, isTrustedZelleSender,
} = require('./zelle-notice');
const { normalizeNamePart, payerNameCorroborates } = require('../utils/name-match');
const { openSelfPayInvoicesByAmountDue, rowIsSelfPayDue, MAX_AMOUNT_CANDIDATES } = require('./open-balance');
const { invoiceAmountDue } = require('./invoice-helpers');

const RECORDED_BY = 'zelle-notice-reconciler';
// emails.auto_action value the sync hook writes when the reconciler threw
// before its claim row existed — the durable retry record (see
// reofferMarkedEmails). Overwritten by the reconciler's own stamp.
const ZELLE_RETRY_MARK = 'zelle_notice_retry';
const RETRY_BATCH = 25;
const DUPLICATE_WINDOW_DAYS = 14;
const STALE_NOTICE_MS = 48 * 60 * 60 * 1000;
const NEAR_AMOUNT_TOLERANCE_CENTS = 500;

// Same parser as the feature-gates registry entry (call-time, so unsetting
// the Railway var is a live kill switch). Prod: explicit 'true' only.
function isZelleReconcileEnabled(env = process.env) {
  return env.NODE_ENV === 'production'
    ? gateEnvValue('GATE_ZELLE_NOTICE_RECONCILE')
    : env.GATE_ZELLE_NOTICE_RECONCILE !== 'false';
}

function customerName(row) {
  return [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ');
}

function candidateEntry(row, { exactAmount, nameMatch }) {
  return {
    invoice_id: row.id,
    invoice_number: row.invoice_number,
    customer_id: row.customer_id,
    customer_name: customerName(row),
    amount_due_cents: Math.round(invoiceAmountDue(row) * 100),
    status: row.status,
    service_date: row.service_date || null,
    exact_amount: exactAmount,
    name_match: nameMatch,
  };
}

// Exact-cent rows first (in their query order), then near-amount rows the
// exact list did not already contain — the operator's dropdown, capped by
// the query's own limit. Near rows pass the SAME fail-closed self-pay
// predicate as the exact rows (live payer re-resolution): the dropdown
// must never offer third-party debt as a Zelle candidate.
async function buildCandidates(parsed, exactRows) {
  const seen = new Set(exactRows.map((r) => r.id));
  const exact = exactRows.map((r) => candidateEntry(r, {
    exactAmount: true,
    nameMatch: payerNameCorroborates(parsed.payerName, { first_name: r.customer_first_name, last_name: r.customer_last_name }),
  }));
  const near = [];
  for (const r of await openSelfPayInvoicesByAmountDue(parsed.amountCents, { toleranceCents: NEAR_AMOUNT_TOLERANCE_CENTS })) {
    if (seen.has(r.id) || !(await rowIsSelfPayDue(r.customer_id, r))) continue;
    near.push(candidateEntry(r, {
      exactAmount: false,
      nameMatch: payerNameCorroborates(parsed.payerName, { first_name: r.customer_first_name, last_name: r.customer_last_name }),
    }));
  }
  return [...exact, ...near];
}

async function stampEmail(emailId, autoAction) {
  await db('emails').where({ id: emailId }).update({
    auto_action: autoAction,
    classification: 'other',
    updated_at: new Date(),
  }).catch((err) => logger.warn(`[zelle-notice] auto_action stamp failed for ${emailId}: ${err.message}`));
}

// `needsReview`: a PARKED notice is an exception the owner must act on, so
// its feed row defaults ON under the admin bell policy (bellDefault — the
// owner's saved 'payment' override still silences it); the applied FYI keeps
// the policy default (silent).
async function notifyOwner(title, body, noticeId, { needsReview = false } = {}) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin('payment', title, body, {
      link: '/admin/invoices',
      dedupeKey: `zelle-notice:${noticeId}`,
      metadata: { noticeId },
      ...(needsReview ? { bellDefault: true } : {}),
    });
  } catch (err) {
    logger.warn(`[zelle-notice] owner notification failed for ${noticeId}: ${err.message}`);
  }
}

async function finishParked(notice, email, reason, { candidates = null, applyError = null, matchedInvoice = null } = {}) {
  await db('inbound_payment_notices').where({ id: notice.id, status: 'processing', claim_token: notice.claim_token }).update({
    status: 'parked',
    park_reason: reason,
    candidates: candidates ? JSON.stringify(candidates) : null,
    apply_error: applyError,
    matched_invoice_id: null,
    matched_customer_id: matchedInvoice?.customer_id || null,
    applied_by: null,
    updated_at: new Date(),
  });
  await stampEmail(email.id, `zelle_notice_parked:${reason}`);
  const amount = notice.amount_cents != null ? ` $${(notice.amount_cents / 100).toFixed(2)}` : '';
  await notifyOwner(
    'Zelle payment needs review',
    `${notice.payer_name || 'Unknown payer'} sent${amount} — ${reason.replace(/_/g, ' ')}${applyError ? `: ${applyError}` : ''}`,
    notice.id,
    { needsReview: true },
  );
  return { status: 'parked', reason };
}

async function finishApplied(notice, email, invoice, matchMethod, receipt) {
  // The payment has COMMITTED — the notice must say so whatever happened to
  // the claim meanwhile (a stale-claim sweep could have parked it during a
  // settlement slower than STALE_CLAIM_MS). CAS on `processing`; a
  // non-processing row is overwritten and logged, never left contradicting
  // the ledger.
  const moved = await db('inbound_payment_notices').where({ id: notice.id, status: 'processing', claim_token: notice.claim_token }).update({
    status: 'auto_applied',
    park_reason: null,
    match_method: matchMethod,
    matched_invoice_id: invoice.id,
    matched_customer_id: invoice.customer_id,
    applied_at: new Date(),
    applied_by: RECORDED_BY,
    updated_at: new Date(),
  });
  if (!moved) {
    // Either the sweep parked OUR claim (token unchanged — force the row to
    // match the ledger) or an operator RECLAIMED the notice after the sweep
    // (new token — their claim is theirs; never consume it). The reclaim
    // case is surfaced loudly: the transfer settled this invoice while the
    // operator may be applying it elsewhere.
    const current = await db('inbound_payment_notices').where({ id: notice.id }).first('claim_token', 'status');
    if (current && current.claim_token === notice.claim_token) {
      logger.error(`[zelle-notice] notice ${notice.id} was ${current.status} after ${invoice.invoice_number} settled — forcing auto_applied to match the ledger`);
      await db('inbound_payment_notices').where({ id: notice.id, claim_token: notice.claim_token }).update({
        status: 'auto_applied', park_reason: null, apply_error: null, match_method: matchMethod,
        matched_invoice_id: invoice.id, matched_customer_id: invoice.customer_id,
        applied_at: new Date(), applied_by: RECORDED_BY, updated_at: new Date(),
      });
    } else {
      logger.error(`[zelle-notice] notice ${notice.id} was RECLAIMED (${current?.status || 'gone'}) before ${invoice.invoice_number}'s late settlement closed — leaving the new claim alone`);
      await stampEmail(email.id, `zelle_notice_applied:${invoice.invoice_number}`);
      await notifyOwner(
        'Zelle payment needs review',
        `${notice.payer_name} · $${(notice.amount_cents / 100).toFixed(2)} settled ${invoice.invoice_number} in a late sync AFTER the notice was reclaimed — verify the notice was not applied to a second invoice`,
        `${notice.id}:late`,
        { needsReview: true },
      );
      return { status: 'auto_applied', invoiceNumber: invoice.invoice_number, reclaimed: true };
    }
  }
  await stampEmail(email.id, `zelle_notice_applied:${invoice.invoice_number}`);
  const legs = receipt === null ? 'unknown — check the invoice' : ([receipt?.email?.ok && 'email', receipt?.sms?.ok && 'sms'].filter(Boolean).join(' + ') || 'no receipt delivered');
  await notifyOwner(
    'Zelle payment applied',
    `${notice.payer_name} · $${(notice.amount_cents / 100).toFixed(2)} → ${invoice.invoice_number} (${matchMethod.replace(/_/g, ' ')}; receipt: ${legs})`,
    notice.id,
  );
  return { status: 'auto_applied', invoiceNumber: invoice.invoice_number };
}

// Claim the notice row for this email. Returns null when another sync
// already owns it (email_id UNIQUE) — the caller then treats the email as
// handled without deciding anything.
async function claimNotice(email, parsed) {
  const [row] = await db('inbound_payment_notices')
    .insert({
      email_id: email.id,
      source: 'capitalone_zelle',
      payer_name: parsed?.payerName || null,
      payer_name_norm: parsed ? normalizeNamePart(parsed.payerName) : null,
      amount_cents: parsed?.amountCents ?? null,
      memo: parsed?.memo || null,
      received_at: email.received_at || new Date(),
      status: 'processing',
      claim_token: randomUUID(),
      candidates: null,
    })
    .onConflict('email_id')
    .ignore()
    .returning('*');
  return row || null;
}

// A claim the sync never finished (process exit, DB blip after the insert)
// would otherwise sit in `processing` forever: the email row is stored, so
// no later sync re-enters the hook. Park anything older than the window as
// apply_failed for the operator — never re-run the money path blind. An
// in-flight settlement is protected by AGE, not a lock (no transaction is
// held across recordManualPayment): a claim is re-stamped (updated_at) right
// before settling, so only a settlement slower than the window can be
// swept — and then closeIfSettled / finishApplied's forced close still make
// the row match the ledger.
const STALE_CLAIM_MS = 10 * 60 * 1000;
async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const stale = await db('inbound_payment_notices')
    .where({ status: 'processing' })
    .where('updated_at', '<', cutoff)
    .select('id', 'email_id', 'payer_name', 'amount_cents', 'matched_invoice_id', 'applied_by', 'claim_token');
  for (const row of stale) {
    if (await closeIfSettled(row)) continue;
    const took = await db('inbound_payment_notices')
      .where({ id: row.id, status: 'processing', claim_token: row.claim_token })
      .where('updated_at', '<', cutoff)
      .update({
        status: 'parked',
        park_reason: 'apply_failed',
        apply_error: 'The sync was interrupted before this notice was settled — check the invoice, then apply or ignore.',
        matched_invoice_id: null,
        applied_by: null,
        updated_at: new Date(),
      });
    if (!took) continue;
    logger.warn(`[zelle-notice] recovered a stale processing claim ${row.id} (email ${row.email_id}) → parked`);
    await stampEmail(row.email_id, 'zelle_notice_parked:apply_failed');
    await notifyOwner('Zelle payment needs review', `${row.payer_name || 'Unknown payer'} sent${row.amount_cents != null ? ` $${(row.amount_cents / 100).toFixed(2)}` : ''} — sync interrupted before settlement`, row.id, { needsReview: true });
  }
  return stale.length;
}

// The settlement is two commits: recordManualPayment's ledger transaction on
// its own connection, then the notice close. Both settling paths COMMIT the
// match on the claim first (matched_invoice_id + applied_by = the recorder
// the settlement will write onto the invoice, status still processing), so a
// close lost between the two commits leaves a claim that says exactly what
// to look for. The invoice was verified OPEN right before the stamp, so
// "paid, by Zelle, recorded by that recorder" can only be this settlement:
// close the notice to match the ledger instead of parking committed money
// as failed. False otherwise (the caller parks).
async function closeIfSettled(row) {
  if (!row.matched_invoice_id || !row.applied_by) return false;
  const inv = await settledInvoiceFor(row.matched_invoice_id, { recordedBy: row.applied_by, reference: zelleReference(row.payer_name) });
  if (!inv) return false;
  const moved = await db('inbound_payment_notices').where({ id: row.id, status: 'processing', claim_token: row.claim_token }).update({
    status: row.applied_by === RECORDED_BY ? 'auto_applied' : 'applied',
    park_reason: null,
    apply_error: null,
    matched_customer_id: inv.customer_id,
    applied_at: new Date(),
    updated_at: new Date(),
  });
  if (!moved) return true; // closed by its own path meanwhile — nothing to park
  logger.error(`[zelle-notice] claim ${row.id} had settled ${inv.invoice_number} but never closed — closed to match the ledger (receipt unknown)`);
  await stampEmail(row.email_id, `zelle_notice_applied:${inv.invoice_number}`);
  await notifyOwner(
    'Zelle payment applied',
    `${row.payer_name || 'Unknown payer'} · $${((row.amount_cents || 0) / 100).toFixed(2)} → ${inv.invoice_number} (closed after an interrupted sync; receipt unknown — check the invoice)`,
    row.id,
  );
  return true;
}

// Re-offer the emails the sync hook marked after a pre-claim failure —
// oldest first, small batch, NO age cap: a mark stays actionable until it
// is handled (a week of gate-off or sync outage must not silently drop a
// payment). The partial index emails_zelle_notice_retry_idx (same
// migration) makes the read a handful of rows, never an emails scan.
// maybeHandleZelleNotice re-runs the full decision — claim
// (at-most-once), trust, match. When the claim already exists (a prior
// pass got that far before throwing, or the hook's own re-offer won) the
// mark is cleared only if it is still the mark, so a concurrent owner's
// outcome stamp is never nulled.
async function reofferMarkedEmails() {
  const rows = await db('emails')
    .where({ auto_action: ZELLE_RETRY_MARK })
    .orderBy('received_at', 'asc')
    .limit(RETRY_BATCH)
    .select('*');
  let handled = 0;
  for (const email of rows) {
    try {
      await maybeHandleZelleNotice(email);
      await db('emails').where({ id: email.id, auto_action: ZELLE_RETRY_MARK }).update({ auto_action: null, updated_at: new Date() });
      handled += 1;
    } catch (err) {
      logger.error(`[zelle-notice] re-offer of marked email ${email.id} failed again: ${err.message}`);
    }
  }
  return handled;
}

// Cadence entry point for the email sync (every run): gate-aware, cheap
// (two indexed reads when nothing is stale or marked).
async function sweepStaleClaims() {
  if (!isZelleReconcileEnabled()) return 0;
  const recovered = await recoverStaleClaims();
  const reoffered = await reofferMarkedEmails().catch((err) => { logger.warn(`[zelle-notice] marked-email re-offer failed: ${err.message}`); return 0; });
  return recovered + reoffered;
}

// The window starts when the MONEY WAS RECORDED (applied_at — both the
// reconciler and the operator's Apply stamp it), never the email's receipt
// time: a notice applied late would otherwise fall out of the window by its
// old timestamp and let a delayed duplicate settle a second invoice.
async function recentlyApplied(parsed, database = db) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const dup = await database('inbound_payment_notices')
    .where({ payer_name_norm: normalizeNamePart(parsed.payerName), amount_cents: parsed.amountCents })
    .whereIn('status', ['auto_applied', 'applied'])
    .where('applied_at', '>', since)
    .first('id');
  return !!dup;
}

// The operator's own Add-payment tap leaves no notice row: a Zelle-paid
// invoice for the SAME customer at these exact cents inside the window is
// that transfer already recorded by hand — with recurring same-amount
// invoices, auto-applying the notice to the next open one would settle one
// transfer twice.
async function directZelleRecentlyRecorded(match, amountCents) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const row = await db('invoices')
    .where({ customer_id: match.customer_id, status: 'paid', payment_method: 'zelle' })
    .where('paid_at', '>', since)
    .whereRaw('ROUND((total - COALESCE(credit_applied, 0)) * 100) = ?', [amountCents])
    .first('id');
  return !!row;
}

function isRefusal(err) {
  return [400, 404, 409].includes(err?.statusCode);
}
// The payment_reference both settling paths hand recordManualPayment (it
// trims to 200) — part of the settlement's fingerprint below.
function zelleReference(payerName) {
  return String(payerName || 'Zelle').trim().slice(0, 200);
}

// THE ONE predicate for "did this notice's settlement commit?" — used by the
// in-flight recovery of both settling paths and by the stale sweep. A paid
// invoice alone is not enough: the recorder string is not unique (two admins
// with one display name, the same admin recording a check meanwhile), so the
// tender must be Zelle and the ledger's payment_reference must be the
// notice's payer — the fingerprint recordManualPayment wrote FROM this notice.
// Returns the invoice row or null.
async function settledInvoiceFor(invoiceId, { recordedBy, reference }) {
  const row = await db('invoices').where({ id: invoiceId }).first();
  if (!row || row.status !== 'paid' || row.payment_method !== 'zelle') return null;
  if (row.payment_recorded_by !== recordedBy || (row.payment_reference || '') !== reference) return null;
  return row;
}

// { rows, truncated }: the exact-cent query is bounded; a FULL page means
// invoices may exist beyond it, so "exactly one corroborates" cannot be
// decided — the caller parks instead of auto-applying on a partial view.
async function exactOpenInvoices(parsed) {
  const rows = await openSelfPayInvoicesByAmountDue(parsed.amountCents, { limit: MAX_AMOUNT_CANDIDATES });
  const truncated = rows.length >= MAX_AMOUNT_CANDIDATES;
  const out = [];
  for (const row of rows) {
    if (await rowIsSelfPayDue(row.customer_id, row)) out.push(row);
  }
  return { rows: out, truncated };
}

// Returns true when the email was a Zelle notice this reconciler owns (the
// sync skips classification); false when the email should flow as today.
async function maybeHandleZelleNotice(email, { backfill = false } = {}) {
  if (!isZelleReconcileEnabled()) return false;
  if (!email || !isZelleNoticeCandidate(email)) return false;
  if (backfill) {
    logger.info(`[zelle-notice] ${email.id} is initial-sync history — not a live money signal, flowing as ordinary mail`);
    return false;
  }
  await recoverStaleClaims().catch((err) => logger.warn(`[zelle-notice] stale-claim recovery failed: ${err.message}`));

  const trusted = isTrustedZelleSender(email);
  const parsed = parseZelleNotice(noticeText(email));
  if (!trusted && !parsed) return false;

  const notice = await claimNotice(email, parsed);
  if (!notice) return true; // another sync owns this email

  if (!trusted) {
    await finishParked(notice, email, 'sender_unverified');
    return false; // let spam / classifier handling see it too
  }
  if (!parsed) {
    await finishParked(notice, email, 'parse_failed');
    return true;
  }

  const { rows: exact, truncated } = await exactOpenInvoices(parsed);
  const candidates = await buildCandidates(parsed, exact);

  if (await recentlyApplied(parsed)) {
    await finishParked(notice, email, 'possible_duplicate', { candidates });
    return true;
  }
  const receivedAt = new Date(notice.received_at || email.received_at || Date.now()).getTime();
  if (Number.isFinite(receivedAt) && Date.now() - receivedAt > STALE_NOTICE_MS) {
    logger.warn(`[zelle-notice] ${email.id} is ${Math.round((Date.now() - receivedAt) / 3600000)}h old at first decision — parking as stale_notice`);
    await finishParked(notice, email, 'stale_notice', { candidates });
    return true;
  }
  if (truncated) {
    logger.warn(`[zelle-notice] ${exact.length}+ open invoices at ${parsed.amountCents} cents — candidate page full, parking as ambiguous`);
    await finishParked(notice, email, 'multiple_matches', { candidates });
    return true;
  }

  let match = null;
  let matchMethod = null;
  const memoNumbers = new Set(memoInvoiceNumbers(parsed.memo));
  const byMemo = exact.filter((r) => memoNumbers.has(String(r.invoice_number).toUpperCase()));
  if (byMemo.length === 1) {
    [match] = byMemo;
    matchMethod = 'memo_invoice_number';
  } else {
    const byName = exact.filter((r) => payerNameCorroborates(parsed.payerName, { first_name: r.customer_first_name, last_name: r.customer_last_name }));
    if (byName.length === 1) {
      [match] = byName;
      matchMethod = 'amount_name';
    } else if (exact.length === 0) {
      await finishParked(notice, email, 'no_match', { candidates });
      return true;
    } else if (byName.length === 0) {
      await finishParked(notice, email, 'name_mismatch', { candidates });
      return true;
    } else {
      await finishParked(notice, email, 'multiple_matches', { candidates });
      return true;
    }
  }

  // COMMIT the match on the claim before settling (see closeIfSettled): a
  // close lost after the ledger commits is then recoverable by the sweep. The
  // partial UNIQUE index on matched_invoice_id also has the DATABASE refuse
  // two notices settling one invoice — a violation here means another copy
  // of this transfer is already on it.
  let stamped;
  try {
    stamped = await db('inbound_payment_notices').where({ id: notice.id, status: 'processing', claim_token: notice.claim_token }).update({
      matched_invoice_id: match.id,
      matched_customer_id: match.customer_id,
      match_method: matchMethod,
      applied_by: RECORDED_BY,
      updated_at: new Date(),
    });
  } catch (err) {
    if (err.code !== '23505') throw err;
    await finishParked(notice, email, 'possible_duplicate', { candidates });
    return true;
  }
  if (!stamped) {
    logger.warn(`[zelle-notice] notice ${notice.id} was no longer processing at settlement time — not settling`);
    return true;
  }

  // The stamp above returned 0 rows when the claim is no longer processing
  // (the stale sweep parked it) — nothing to settle.
  // NO outer transaction across the settlement: recordManualPayment opens
  // its own, and holding a notice transaction around it would let two
  // concurrent settlements (a sync + an operator Apply) each take one of the
  // two pool connections and wait forever for the inner one. The committed
  // claim IS the serialization: the sweep leaves a fresh processing claim
  // alone for STALE_CLAIM_MS, Apply / Ignore require `parked`, one invoice
  // takes one notice (partial UNIQUE index), and the close below is a CAS
  // on `processing` with a lost close recovered by closeIfSettled.
  //
  // Duplicate re-check right before settling: two copies of one transfer
  // that both matched can only have matched the SAME single invoice, which
  // the index refused above; this catches the copy whose first check ran
  // before the other's close committed.
  if (await recentlyApplied(parsed) || await directZelleRecentlyRecorded(match, parsed.amountCents)) {
    logger.warn(`[zelle-notice] notice ${notice.id}: same transfer already recorded (a copy applied meanwhile, or the operator recorded it by hand) — parking as possible_duplicate`);
    await finishParked(notice, email, 'possible_duplicate', { candidates });
    return true;
  }
  let settled;
  try {
    const { recordManualPayment } = require('./invoice-manual-payment');
    settled = await recordManualPayment(match.id, {
      method: 'zelle',
      reference: zelleReference(parsed.payerName),
      note: parsed.memo ? `Zelle memo: ${parsed.memo}` : '',
      recordedBy: RECORDED_BY,
      sendReceipt: true,
      via: 'both',
      // Fenced under the invoice lock: the ledger records exactly the
      // notice's amount or nothing.
      expectedAmountCents: parsed.amountCents,
      // Re-checks payer / statement / live payer resolution on the locked
      // invoice — a reassignment after exactOpenInvoices() refuses.
      requireSelfPay: true,
      // Nobody is tapping a button: the receipt honors the customer's
      // payment_receipt / email_enabled opt-outs like the automatic queue.
      automated: true,
    });
  } catch (err) {
    // A statusCode-shaped refusal settled nothing. Anything else may have
    // thrown AFTER the ledger committed (a post-commit side effect, the
    // final re-read) — ask the invoice, never label committed money as
    // failed.
    const paid = isRefusal(err) ? null : await settledInvoiceFor(match.id, { recordedBy: RECORDED_BY, reference: zelleReference(parsed.payerName) });
    if (paid) {
      logger.error(`[zelle-notice] ${match.invoice_number} settled but a later step threw (${err.message}) — recording as applied, receipt unknown`);
      await finishApplied(notice, email, paid, matchMethod, null);
      return true;
    }
    logger.error(`[zelle-notice] apply failed for ${match.invoice_number} (email ${email.id}): ${err.message}`);
    await finishParked(notice, email, 'apply_failed', {
      candidates,
      applyError: isRefusal(err) ? err.message : `Settlement outcome uncertain (${err.message}) — check the invoice before applying`,
      matchedInvoice: match,
    });
    return true;
  }
  await finishApplied(notice, email, settled.invoice || match, matchMethod, settled.receipt);
  return true;
}

module.exports = {
  RECORDED_BY,
  ZELLE_RETRY_MARK,
  STALE_CLAIM_MS,
  reofferMarkedEmails,
  recoverStaleClaims,
  sweepStaleClaims,
  closeIfSettled,
  directZelleRecentlyRecorded,
  settledInvoiceFor,
  zelleReference,
  DUPLICATE_WINDOW_DAYS,
  STALE_NOTICE_MS,
  NEAR_AMOUNT_TOLERANCE_CENTS,
  isZelleReconcileEnabled,
  maybeHandleZelleNotice,
  buildCandidates,
};
