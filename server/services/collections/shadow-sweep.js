/**
 * Collections SHADOW sweep (PR A) — observation only, by construction.
 *
 * Daily (weekday, in-window) cron: for every customer whose open self-pay
 * balance passes the voice contact policy (channel 'voice', purpose
 * 'late_payment'), upsert a collection_cases row in state 'shadow' and file
 * ONE admin proposal card describing the call that WOULD be placed.
 *
 * HARD LINE: this module never dials, never texts, never emails, never
 * touches any customer-facing surface. It deliberately imports NO messaging
 * module (no send-customer-message, no Twilio client, no TwiML) — tests pin
 * that with spies. DARK unless GATE_COLLECTIONS_SHADOW === 'true'.
 *
 * Card language rule (owner): "open balance" / "billing follow-up" — never
 * "collections" or "delinquent" in anything an eventual script would say or
 * the card displays as script text. No emojis.
 */

const db = require('../../models/db');
const logger = require('../logger');
const ContactPolicy = require('./contact-policy');
const { invoiceAmountDue } = require('../invoice-helpers');
const { etCalendarDayOf, etDateString } = require('../../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;

function shadowGateEnabled() {
  return process.env.GATE_COLLECTIONS_SHADOW === 'true';
}

// Same escalation boundaries as the late-payment tiers (7/14/30/60/90); the
// pilot window (14–60 days) means shadow cases land on 14/30/60.
function dunningTierForOverdue(daysSince) {
  if (daysSince < 14) return 7;
  if (daysSince < 30) return 14;
  if (daysSince < 60) return 30;
  if (daysSince < 90) return 60;
  return 90;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `***-***-${digits.slice(-4)}` : 'unknown';
}

function daysOverdueOn(now, dueValue) {
  const dueStr = etCalendarDayOf(dueValue);
  const nowStr = etDateString(now);
  const [dy, dm, dd] = dueStr.split('-').map(Number);
  const [ny, nm, nd] = nowStr.split('-').map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / DAY_MS);
}

function normalizedIdSet(value) {
  const arr = Array.isArray(value)
    ? value
    : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })();
  return arr.map(String).sort();
}

// The opening line a live agent/automation WOULD read — surfaced on the card
// so Adam reviews the exact words before anything ever dials in a later PR.
function predictedOpeningScript({ firstName, amountDollars, invoiceTitle }) {
  const name = firstName || 'there';
  const title = invoiceTitle || 'recent';
  return `Hi ${name}, this is Waves Pest Control with a quick billing follow-up. `
    + `Our records show an open balance of $${amountDollars} for your ${title} service. `
    + `Do you have a moment to take care of that today, or would a payment link by text be easier?`;
}

// Candidate pool: customers with any delivered, self-pay, positive-remainder
// invoice (the same broad-phase shape as the open-balance authority — the
// policy's evaluate() then applies the authoritative per-row rules).
async function candidateCustomerIds() {
  const rows = await db('invoices')
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .distinct('customer_id');
  return rows.map((r) => r.customer_id).filter(Boolean);
}

// One admin card per case version, deduped restart-safely on the case's
// idempotency key via the notifications metadata dedupeKey pattern
// (call-ingest-watchdog convention).
async function fileProposalCard({ dedupeKey, customer, caseRow, invoice, daysOverdue, verdict }) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('id')
    .catch(() => null);
  if (existing) return false;

  const amountDollars = (caseRow.eligible_balance_snapshot / 100).toFixed(2);
  const invoiceRef = invoice?.invoice_number || invoice?.id || 'unknown';
  const script = predictedOpeningScript({
    firstName: customer.first_name,
    amountDollars,
    invoiceTitle: invoice?.title || invoice?.service_type,
  });

  const NotificationService = require('../notification-service');
  await NotificationService.notifyAdmin(
    'billing',
    `Billing follow-up proposal - $${amountDollars} open balance`,
    [
      'Shadow mode: no call will be placed. This is what the policy would propose.',
      `Phone: ${maskPhone(customer.phone)}`,
      `Invoice: ${invoiceRef} - $${amountDollars} open balance, ${daysOverdue} days past due.`,
      `Consent evidence: ${verdict.consentEvidence?.source || 'unknown'}.`,
      `Predicted opening: "${script}"`,
    ].join('\n'),
    {
      link: `/admin/customers/${customer.id}`,
      metadata: {
        dedupeKey,
        customerId: customer.id,
        collectionCaseId: caseRow.id,
        caseVersion: caseRow.case_version,
      },
    },
  );
  return true;
}

async function runShadowSweep({ now = new Date() } = {}) {
  if (!shadowGateEnabled()) return { skipped: true, reason: 'gated_off' };

  const candidates = await candidateCustomerIds();
  let considered = 0;
  let casesCreated = 0;
  let casesUpdated = 0;
  let cardsFiled = 0;

  for (const customerId of candidates) {
    considered++;
    try {
      const verdict = await ContactPolicy.evaluate(customerId, {
        channel: 'voice', purpose: 'late_payment', now,
      });
      if (!verdict.allowed) continue;

      const customer = await db('customers').where({ id: customerId }).first();
      if (!customer) continue;

      const invoiceIds = normalizedIdSet(verdict.eligibleInvoiceIds);
      const invoice = await db('invoices')
        .whereIn('id', verdict.eligibleInvoiceIds)
        .orderBy('created_at', 'asc')
        .first();
      if (!invoice) continue;

      const dueValue = invoice.due_date || invoice.created_at;
      const daysOverdue = daysOverdueOn(now, dueValue);
      const tier = dunningTierForOverdue(daysOverdue);

      const existing = await db('collection_cases')
        .where({ customer_id: customerId, current_state: 'shadow' })
        .orderBy('case_version', 'desc')
        .first();

      const unchanged = existing
        && Number(existing.eligible_balance_snapshot) === verdict.eligibleBalanceCents
        && JSON.stringify(normalizedIdSet(existing.eligible_invoice_ids)) === JSON.stringify(invoiceIds);
      if (unchanged) continue; // idempotent re-run — same proposal, no new row/card

      const caseVersion = existing ? existing.case_version + 1 : 1;
      const idempotencyKey = `collections:${customerId}:${caseVersion}:${tier}`;
      const patch = {
        eligible_invoice_ids: JSON.stringify(invoiceIds),
        eligible_balance_snapshot: verdict.eligibleBalanceCents,
        earliest_due_date: etCalendarDayOf(dueValue),
        case_version: caseVersion,
        consent_evidence: verdict.consentEvidence
          ? JSON.stringify({
              source: verdict.consentEvidence.source,
              evidence_ref: verdict.consentEvidence.evidenceRef,
              evidence_at: verdict.consentEvidence.evidenceAt,
            })
          : null,
        current_state: 'shadow',
        idempotency_key: idempotencyKey,
      };

      let caseRow;
      if (existing) {
        // Version-guarded update: a concurrent sweep that already bumped the
        // version no-ops here (and the unique idempotency_key backstops it).
        const [updated] = await db('collection_cases')
          .where({ id: existing.id, case_version: existing.case_version })
          .update({ ...patch, updated_at: db.fn.now() })
          .returning('*');
        if (!updated) continue;
        caseRow = updated;
        casesUpdated++;
      } else {
        const [inserted] = await db('collection_cases')
          .insert({
            customer_id: customerId,
            ...patch,
            proposal_created_at: now,
          })
          .returning('*');
        caseRow = inserted;
        casesCreated++;
      }

      const filed = await fileProposalCard({
        dedupeKey: idempotencyKey, customer, caseRow, invoice, daysOverdue, verdict,
      });
      if (filed) cardsFiled++;
    } catch (err) {
      // One customer's failure never kills the sweep; nothing customer-facing
      // happened, so plain log-and-continue is safe.
      logger.error(`[collections-shadow] sweep failed for customer ${customerId}: ${err.message}`);
    }
  }

  logger.info(`[collections-shadow] sweep done: ${considered} considered, ${casesCreated} created, ${casesUpdated} updated, ${cardsFiled} cards`);
  return { skipped: false, considered, casesCreated, casesUpdated, cardsFiled };
}

module.exports = { runShadowSweep, dunningTierForOverdue, predictedOpeningScript };
