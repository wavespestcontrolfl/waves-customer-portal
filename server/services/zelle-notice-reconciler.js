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
 *   3. untrusted sender                 → parked `sender_unverified`, return FALSE
 *                                         (normal classification / spam handling still runs)
 *   4. template not parseable           → parked `parse_failed`
 *   5. same payer + amount applied <14d → parked `possible_duplicate`
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
 * UNIQUE, status 'processing') and only the claimant decides; a second sync
 * of the same message can never apply twice. The notice row + emails.
 * auto_action stamp + the payments ledger row from recordManualPayment are
 * the audit trail. Silent on success (category 'payment' is bell-silent by
 * default); a parked notice raises the same silent feed row for the owner.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const {
  isZelleNoticeCandidate, noticeText, parseZelleNotice, memoInvoiceNumbers, isTrustedZelleSender,
} = require('./zelle-notice');
const { normalizeNamePart, payerNameCorroborates } = require('../utils/name-match');
const { openSelfPayInvoicesByAmountDue, rowIsSelfPayDue } = require('./open-balance');
const { invoiceAmountDue } = require('./invoice-helpers');

const RECORDED_BY = 'zelle-notice-reconciler';
const DUPLICATE_WINDOW_DAYS = 14;
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
// the query's own limit.
async function buildCandidates(parsed, exactRows) {
  const seen = new Set(exactRows.map((r) => r.id));
  const exact = exactRows.map((r) => candidateEntry(r, {
    exactAmount: true,
    nameMatch: payerNameCorroborates(parsed.payerName, { first_name: r.customer_first_name, last_name: r.customer_last_name }),
  }));
  const near = (await openSelfPayInvoicesByAmountDue(parsed.amountCents, { toleranceCents: NEAR_AMOUNT_TOLERANCE_CENTS }))
    .filter((r) => !seen.has(r.id))
    .map((r) => candidateEntry(r, {
      exactAmount: false,
      nameMatch: payerNameCorroborates(parsed.payerName, { first_name: r.customer_first_name, last_name: r.customer_last_name }),
    }));
  return [...exact, ...near];
}

async function stampEmail(emailId, autoAction) {
  await db('emails').where({ id: emailId }).update({
    auto_action: autoAction,
    classification: 'other',
    updated_at: new Date(),
  }).catch((err) => logger.warn(`[zelle-notice] auto_action stamp failed for ${emailId}: ${err.message}`));
}

async function notifyOwner(title, body, noticeId) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin('payment', title, body, {
      link: '/admin/invoices',
      dedupeKey: `zelle-notice:${noticeId}`,
      metadata: { noticeId },
    });
  } catch (err) {
    logger.warn(`[zelle-notice] owner notification failed for ${noticeId}: ${err.message}`);
  }
}

async function finishParked(notice, email, reason, { candidates = null, applyError = null, matchedInvoice = null } = {}) {
  await db('inbound_payment_notices').where({ id: notice.id, status: 'processing' }).update({
    status: 'parked',
    park_reason: reason,
    candidates: candidates ? JSON.stringify(candidates) : null,
    apply_error: applyError,
    matched_invoice_id: null,
    matched_customer_id: matchedInvoice?.customer_id || null,
    updated_at: new Date(),
  });
  await stampEmail(email.id, `zelle_notice_parked:${reason}`);
  const amount = notice.amount_cents != null ? ` $${(notice.amount_cents / 100).toFixed(2)}` : '';
  await notifyOwner(
    'Zelle payment needs review',
    `${notice.payer_name || 'Unknown payer'} sent${amount} — ${reason.replace(/_/g, ' ')}${applyError ? `: ${applyError}` : ''}`,
    notice.id,
  );
  return { status: 'parked', reason };
}

async function finishApplied(notice, email, invoice, matchMethod, receipt) {
  await db('inbound_payment_notices').where({ id: notice.id, status: 'processing' }).update({
    status: 'auto_applied',
    park_reason: null,
    match_method: matchMethod,
    matched_invoice_id: invoice.id,
    matched_customer_id: invoice.customer_id,
    applied_at: new Date(),
    applied_by: RECORDED_BY,
    updated_at: new Date(),
  });
  await stampEmail(email.id, `zelle_notice_applied:${invoice.invoice_number}`);
  const legs = [receipt?.email?.ok && 'email', receipt?.sms?.ok && 'sms'].filter(Boolean).join(' + ') || 'no receipt delivered';
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
// apply_failed for the operator — never re-run the money path blind (if
// recordManualPayment had committed, the invoice is paid and no longer a
// candidate, so a manual Apply is refused; if it had not, the operator can
// apply it).
const STALE_CLAIM_MS = 10 * 60 * 1000;
async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const stale = await db('inbound_payment_notices')
    .where({ status: 'processing' })
    .where('updated_at', '<', cutoff)
    .select('id', 'email_id', 'payer_name', 'amount_cents');
  for (const row of stale) {
    const took = await db('inbound_payment_notices')
      .where({ id: row.id, status: 'processing' })
      .where('updated_at', '<', cutoff)
      .update({
        status: 'parked',
        park_reason: 'apply_failed',
        apply_error: 'The sync was interrupted before this notice was settled — check the invoice, then apply or ignore.',
        updated_at: new Date(),
      });
    if (!took) continue;
    logger.warn(`[zelle-notice] recovered a stale processing claim ${row.id} (email ${row.email_id}) → parked`);
    await stampEmail(row.email_id, 'zelle_notice_parked:apply_failed');
    await notifyOwner('Zelle payment needs review', `${row.payer_name || 'Unknown payer'} sent${row.amount_cents != null ? ` $${(row.amount_cents / 100).toFixed(2)}` : ''} — sync interrupted before settlement`, row.id);
  }
  return stale.length;
}

async function recentlyApplied(parsed) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const dup = await db('inbound_payment_notices')
    .where({ payer_name_norm: normalizeNamePart(parsed.payerName), amount_cents: parsed.amountCents })
    .whereIn('status', ['auto_applied', 'applied'])
    .where('received_at', '>', since)
    .first('id');
  return !!dup;
}

async function exactOpenInvoices(parsed) {
  const rows = await openSelfPayInvoicesByAmountDue(parsed.amountCents);
  const out = [];
  for (const row of rows) {
    if (await rowIsSelfPayDue(row.customer_id, row)) out.push(row);
  }
  return out;
}

// Returns true when the email was a Zelle notice this reconciler owns (the
// sync skips classification); false when the email should flow as today.
async function maybeHandleZelleNotice(email) {
  if (!isZelleReconcileEnabled()) return false;
  if (!email || !isZelleNoticeCandidate(email)) return false;
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

  const exact = await exactOpenInvoices(parsed);
  const candidates = await buildCandidates(parsed, exact);

  if (await recentlyApplied(parsed)) {
    await finishParked(notice, email, 'possible_duplicate', { candidates });
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

  try {
    const { recordManualPayment } = require('./invoice-manual-payment');
    const { invoice, receipt } = await recordManualPayment(match.id, {
      method: 'zelle',
      reference: parsed.payerName,
      note: parsed.memo ? `Zelle memo: ${parsed.memo}` : '',
      recordedBy: RECORDED_BY,
      sendReceipt: true,
      via: 'both',
    });
    await finishApplied(notice, email, invoice || match, matchMethod, receipt);
  } catch (err) {
    logger.error(`[zelle-notice] apply failed for ${match.invoice_number} (email ${email.id}): ${err.message}`);
    await finishParked(notice, email, 'apply_failed', { candidates, applyError: err.message, matchedInvoice: match });
  }
  return true;
}

module.exports = {
  RECORDED_BY,
  STALE_CLAIM_MS,
  recoverStaleClaims,
  DUPLICATE_WINDOW_DAYS,
  NEAR_AMOUNT_TOLERANCE_CENTS,
  isZelleReconcileEnabled,
  maybeHandleZelleNotice,
  buildCandidates,
};
