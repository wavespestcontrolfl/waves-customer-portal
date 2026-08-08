/**
 * Reverse the account credits minted by the self-referential pending-window
 * completion bug (fixed in the same PR, annual-prepay-renewals.js).
 *
 * reconcilePendingWindowCompletions returns a visit's prepay slice as account
 * credit when the visit completed BEFORE the annual was paid and was therefore
 * billed separately — the customer would otherwise pay for it twice. It finds
 * "the visit's invoice" via `invoices.scheduled_service_id`. On a same-day
 * close that lookup finds the term's OWN prepay invoice (one invoice bills the
 * completed first visit AND sells the annual), reads its 'paid' status as a
 * second collection, and credits a slice against money that was only ever
 * collected once.
 *
 * Verified read-only against prod 2026-08-08: all 3 credits this mechanism has
 * EVER written are this artifact, totalling $265.00 across 3 live accounts,
 * none of it spent. Each of those accounts has exactly one paid invoice and one
 * payment equal to its prepay amount, so nothing was ever double-collected.
 * Zero reversals exist. The mechanism has never once fired on the genuine
 * double-billing case it was built for.
 *
 * Scope is re-derived at run time from the artifact SHAPE, not the three known
 * ids — the bug is live until this deploy, so a fourth could land first.
 * Matching keys on `term.prepay_invoice_id`, NOT `invoices.annual_prepay_term_id`:
 * that column is null on some prepay invoices (verified against prod), so the
 * invoice-side check would miss a real artifact.
 *
 * Writes ledger + balance only. NO customer communication: postCreditMovement's
 * seam is pure DB, and this migration touches neither invoices nor visits nor
 * any notification table.
 */

const CREDIT_BY = 'system:annual_prepay_pending_completion';
const RUNTIME_REVERSAL_BY = 'system:annual_prepay_pending_completion_reversal';
// Must stay byte-identical to PENDING_COMPLETION_BACKFILL_BY in
// services/annual-prepay-renewals.js: the runtime refund claw-back treats this
// identity as "already reversed", and if the two drift a later refund would
// claw the same slice back a second time. A migration is frozen and must not
// import service code, so the literal is duplicated and pinned by a test.
const BACKFILL_BY = 'system:annual_prepay_self_referential_credit_backfill';

// The runtime grant embeds "(term <uuid>, visit <uuid>)"; its reversal copies
// that substring verbatim. Same extraction both places so the dedupe can't drift.
const MARKER_RE = /\(term [^)]*\)/;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Terminal statuses are excluded exactly as the runtime lookup excludes them,
// so this migration classifies a credit the same way the buggy code did.
const NON_TERMINAL = ['void', 'canceled', 'cancelled', 'refunded'];

async function artifactCredits(knex) {
  const credits = await knex('customer_credit_ledger')
    .where({ created_by: CREDIT_BY })
    .where('delta', '>', 0)
    .select('*');

  const out = [];
  for (const credit of credits) {
    const markerMatch = MARKER_RE.exec(String(credit.note || ''));
    if (!markerMatch) continue;
    const marker = markerMatch[0];
    const ids = /\(term ([^,]+), visit ([^)]+)\)/.exec(marker);
    if (!ids) continue;
    const [, termId, visitId] = ids;

    const term = await knex('annual_prepay_terms')
      .where({ id: termId.trim() })
      .first('id', 'prepay_invoice_id');
    if (!term || !term.prepay_invoice_id) continue;

    // The invoice the buggy lookup would have found for this visit.
    const invoice = await knex('invoices')
      .where({ scheduled_service_id: visitId.trim() })
      .whereNotIn('status', NON_TERMINAL)
      .orderBy('created_at', 'desc')
      .first('id');
    if (!invoice) continue;

    // The artifact signature: that invoice IS the term's own prepay invoice.
    if (String(invoice.id) !== String(term.prepay_invoice_id)) continue;

    out.push({ credit, marker });
  }
  return out;
}

exports.up = async function up(knex) {
  const hasLedger = await knex.schema.hasTable('customer_credit_ledger');
  const hasTerms = await knex.schema.hasTable('annual_prepay_terms');
  if (!hasLedger || !hasTerms) return;

  const targets = await artifactCredits(knex);
  if (targets.length === 0) return;

  for (const { credit, marker } of targets) {
    await knex.transaction(async (trx) => {
      // Same customer row lock the grant path takes, so a concurrent credit
      // movement can't interleave between the balance read and the write.
      const customer = await trx('customers')
        .where({ id: credit.customer_id })
        .forUpdate()
        .first('id', 'account_credits');
      if (!customer) return;

      // Already reversed — by the runtime refund path or a prior run of this
      // migration. Checked INSIDE the lock so two runners can't both pass.
      const existing = await trx('customer_credit_ledger')
        .whereIn('created_by', [RUNTIME_REVERSAL_BY, BACKFILL_BY])
        .where({ customer_id: credit.customer_id })
        .where('note', 'like', `%${marker}%`)
        .first('id');
      if (existing) return;

      const balance = round2(customer.account_credits);
      const creditAmount = round2(credit.delta);
      // Cap at the balance still available: credit the customer already spent
      // cannot be pulled out of a non-negative balance. Mirrors the runtime
      // reversal's shortfall handling — reverse what remains, and still write
      // the dedupe row so a later pass can never claw back more.
      const reverseAmount = round2(Math.min(balance, creditAmount));

      if (!(reverseAmount > 0)) {
        await trx('customer_credit_ledger').insert({
          customer_id: credit.customer_id,
          delta: 0,
          balance_after: balance,
          source: 'adjustment',
          invoice_id: credit.invoice_id || null,
          note: 'Self-referential annual-prepay credit (issued in error, never double-collected) '
            + `was already spent — nothing reversed, operator follow-up needed ${marker}`,
          created_by: BACKFILL_BY,
        });
        return;
      }

      const balanceAfter = round2(balance - reverseAmount);
      await trx('customers').where({ id: credit.customer_id }).update({
        account_credits: balanceAfter,
        updated_at: trx.fn.now(),
      });
      await trx('customer_credit_ledger').insert({
        customer_id: credit.customer_id,
        delta: -reverseAmount,
        balance_after: balanceAfter,
        source: 'adjustment',
        invoice_id: credit.invoice_id || null,
        note: 'Reversing an annual-prepay credit issued in error — the visit was billed on the '
          + "term's own prepay invoice, so its slice was never collected twice "
          + `${marker}`
          + (reverseAmount < creditAmount
            ? ` (partial: $${reverseAmount.toFixed(2)} of $${creditAmount.toFixed(2)}, balance exhausted)`
            : ''),
        created_by: BACKFILL_BY,
      });
    });
  }
};

exports.down = async function down(knex) {
  const hasLedger = await knex.schema.hasTable('customer_credit_ledger');
  if (!hasLedger) return;

  const rows = await knex('customer_credit_ledger')
    .where({ created_by: BACKFILL_BY })
    .select('*');

  for (const row of rows) {
    await knex.transaction(async (trx) => {
      const customer = await trx('customers')
        .where({ id: row.customer_id })
        .forUpdate()
        .first('id', 'account_credits');
      // Give the reversed amount back before dropping the audit row, so the
      // cached balance and the ledger stay in agreement in both directions.
      if (customer && Number(row.delta) < 0) {
        await trx('customers').where({ id: row.customer_id }).update({
          account_credits: round2(round2(customer.account_credits) + Math.abs(round2(row.delta))),
          updated_at: trx.fn.now(),
        });
      }
      await trx('customer_credit_ledger').where({ id: row.id }).del();
    });
  }
};
