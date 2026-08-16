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
    // 'unpaid' = legacy status the dunning rails serve (r4): the policy
    // admits it, so the broad phase must too or those customers are never
    // evaluated and their standing cases get wrongly lapsed.
    .whereIn('status', ['sent', 'viewed', 'overdue', 'unpaid'])
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
  const notified = await NotificationService.notifyAdmin(
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
  // notifyAdmin returns null when the insert failed (codex gh-r1): the card
  // is the proposal's only surface, so a failed insert must NOT read as
  // filed — the unchanged-case probe above re-files it next sweep. A
  // bell-policy-suppressed result was a deliberate silence and counts.
  return Boolean(notified && (notified.id || notified.suppressed));
}

async function runShadowSweep({ now = new Date() } = {}) {
  if (!shadowGateEnabled()) return { skipped: true, reason: 'gated_off' };

  const candidates = await candidateCustomerIds();
  let considered = 0;
  let casesCreated = 0;
  let casesUpdated = 0;
  let cardsFiled = 0;

  const stillEligible = new Set();
  for (const customerId of candidates) {
    considered++;
    try {
      const verdict = await ContactPolicy.evaluate(customerId, {
        channel: 'voice', purpose: 'late_payment', now,
      });
      if (!verdict.allowed) {
        // A transient evaluation ERROR is unknown, not a denial (codex r6):
        // during a DB/Stripe blip every customer would read denied and the
        // retirement pass would lapse EVERY valid case + dismiss its card.
        // Preserve the case; only definitive denials lapse.
        if (verdict.denialReasons.includes('policy_evaluation_error')) {
          stillEligible.add(customerId);
        }
        continue;
      }
      stillEligible.add(customerId);

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

      // Latest case across shadow AND lapsed (r4): a retired case that
      // requalifies must advance its version monotonically — treating it
      // as new would reuse the globally-unique version-1 idempotency key,
      // fail the insert, and file no card.
      // Self-heal to ONE live shadow case (codex r6): a customer merge
      // repoints the loser's case onto the winner, leaving two live rows —
      // the lookup would forever update one while the other's stale card
      // stands. Keep the newest (by update recency), lapse the rest and
      // retire their cards through the same read_at mechanism.
      const liveShadow = await db('collection_cases')
        .where({ customer_id: customerId, current_state: 'shadow' })
        .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'case_version', order: 'desc' }])
        .select('id', 'idempotency_key');
      if (liveShadow.length > 1) {
        const extras = liveShadow.slice(1);
        await db('collection_cases')
          .whereIn('id', extras.map((c) => c.id))
          .update({ current_state: 'lapsed', updated_at: db.fn.now() });
        const extraKeys = extras.map((c) => c.idempotency_key).filter(Boolean);
        if (extraKeys.length) {
          await db('notifications')
            .where({ recipient_type: 'admin' })
            .whereNull('read_at')
            .whereIn(db.raw("metadata->>'dedupeKey'"), extraKeys)
            .update({ read_at: db.fn.now() })
            .catch((err) => logger.warn(`[collections-shadow] duplicate-case card retirement failed: ${err.message}`));
        }
      }

      // The retained LIVE row is authoritative (codex r8): the shadow+lapsed
      // version-ordered lookup could select a just-lapsed merge loser with a
      // higher independent version and flip it straight back to shadow —
      // two live cases again. Lapsed history is consulted only when no live
      // shadow row exists (the reactivation path).
      let existing;
      if (liveShadow.length) {
        existing = await db('collection_cases').where({ id: liveShadow[0].id }).first();
      } else {
        // ANY settled prior case is rotation material (PR C / codex gh-r2):
        // limiting this to shadow/lapsed made cancelled (dial-time policy
        // denial, snapshot drift) and post-call proposed rows invisible —
        // the sweep then attempted a version-1 insert whose globally unique
        // idempotency key collided with the old row, permanently blocking
        // regeneration for that customer. Only the LIVE pipeline states
        // (approved, dialing) are excluded; the version bump below mints a
        // fresh key and the unchanged-check's state==='shadow' requirement
        // guarantees non-shadow rows always rotate rather than reuse.
        existing = await db('collection_cases')
          .where({ customer_id: customerId })
          .whereNotIn('current_state', ['approved', 'dialing'])
          .orderBy('case_version', 'desc')
          .first();
      }

      const unchanged = existing
        && existing.current_state === 'shadow'
        && Number(existing.eligible_balance_snapshot) === verdict.eligibleBalanceCents
        && JSON.stringify(normalizedIdSet(existing.eligible_invoice_ids)) === JSON.stringify(invoiceIds)
        // Tier is part of the proposal (codex r3): an unpaid invoice
        // crossing 14→30→60 must rotate the version/key and re-file.
        && String(existing.idempotency_key || '').endsWith(`:${tier}`);
      if (unchanged) {
        // The card is the case's ONLY surface (codex gh-r1): if last
        // sweep's notifyAdmin insert failed after the case row persisted,
        // "unchanged" would bury the proposal forever. Probe for delivery
        // evidence by dedupe key and re-file when it's missing — the
        // voice-lane probe-notifications pattern.
        const cardExists = await db('notifications')
          .whereRaw("metadata->>'dedupeKey' = ?", [existing.idempotency_key])
          .first('id');
        if (!cardExists) {
          const refiled = await fileProposalCard({
            dedupeKey: existing.idempotency_key,
            customer,
            caseRow: existing,
            invoice,
            daysOverdue,
            verdict,
          });
          if (refiled) cardsFiled++;
        }
        continue; // idempotent re-run — same proposal, no new row
      }

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
        // The SUPERSEDED version's card retires with the rotation (codex
        // r8): its copy shows the old amount/tier and its collectionCaseId
        // points at mutated data — an admin must never see it beside the
        // replacement. Same read_at mechanism, best-effort.
        if (existing.idempotency_key && existing.idempotency_key !== idempotencyKey) {
          await db('notifications')
            .where({ recipient_type: 'admin' })
            .whereNull('read_at')
            .whereRaw("metadata->>'dedupeKey' = ?", [existing.idempotency_key])
            .update({ read_at: db.fn.now() })
            .catch((err) => logger.warn(`[collections-shadow] superseded-card retirement failed: ${err.message}`));
        }
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

  // Retire stale shadow cases (codex r3): a customer who paid off, went
  // payer-billed, or gained a hold must not keep a standing shadow
  // proposal. 'lapsed' is terminal-but-auditable; a re-qualifying customer
  // mints a fresh version later. whereNotIn with an empty set retires
  // every shadow case — correct: nobody is eligible.
  let casesLapsed = 0;
  try {
    const toLapse = await db('collection_cases')
      .where({ current_state: 'shadow' })
      .whereNotIn('customer_id', [...stillEligible])
      .select('id', 'idempotency_key');
    if (toLapse.length) {
      casesLapsed = await db('collection_cases')
        .whereIn('id', toLapse.map((c) => c.id))
        .update({ current_state: 'lapsed', updated_at: db.fn.now() });
      // The proposal card must retire WITH its case (codex r5): a frozen
      // actionable card for an ineligible customer misleads, and a later
      // requalification would stack a second card beside it. Marking read
      // uses the bell's own dismissal mechanism; best-effort — a missed
      // stamp only leaves a stale card, never sends anything.
      const keys = toLapse.map((c) => c.idempotency_key).filter(Boolean);
      if (keys.length) {
        await db('notifications')
          .where({ recipient_type: 'admin' })
          .whereNull('read_at')
          .whereIn(db.raw("metadata->>'dedupeKey'"), keys)
          .update({ read_at: db.fn.now() })
          .catch((err) => logger.warn(`[collections-shadow] card retirement failed: ${err.message}`));
      }
    }
  } catch (err) {
    logger.error(`[collections-shadow] stale-case retirement failed: ${err.message}`);
  }

  logger.info(`[collections-shadow] sweep done: ${considered} considered, ${casesCreated} created, ${casesUpdated} updated, ${cardsFiled} cards, ${casesLapsed} lapsed`);
  return { skipped: false, considered, casesCreated, casesUpdated, cardsFiled, casesLapsed };
}

module.exports = { runShadowSweep, dunningTierForOverdue, predictedOpeningScript };
