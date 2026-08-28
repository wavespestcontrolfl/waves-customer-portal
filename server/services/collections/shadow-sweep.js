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
const { etCalendarDayOf } = require('../../utils/datetime-et');
const { invoiceAmountDue } = require('../invoice-helpers');
const { orderByDue, dueValueOf, daysOverdueOn, dunningTierForOverdue } = require('./account-anchor');
const { withCaseLock } = require('./case-lock');

function shadowGateEnabled() {
  return process.env.GATE_COLLECTIONS_SHADOW === 'true';
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `***-***-${digits.slice(-4)}` : 'unknown';
}

// jsonb {id: cents} (object or string) → sorted [[id, cents]] for compare.
function normalizedCents(value) {
  let map = value;
  if (typeof map === 'string') { try { map = JSON.parse(map); } catch { map = null; } }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map).map(([id, c]) => [String(id), Number(c)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function normalizedIdSet(value) {
  const arr = Array.isArray(value)
    ? value
    : (() => { try { return JSON.parse(value || '[]'); } catch { return []; } })();
  return arr.map(String).sort();
}

// The opening line a live agent/automation WOULD read — surfaced on the card
// so Adam reviews the exact words before anything ever dials in a later PR.
function predictedOpeningScript({ firstName, amountDollars, invoiceTitle, invoiceCount = 1 }) {
  const name = firstName || 'there';
  const title = invoiceTitle || 'recent';
  const balance = invoiceCount > 1
    ? `an open balance of $${amountDollars} across ${invoiceCount} invoices, the oldest for your ${title} service`
    : `an open balance of $${amountDollars} for your ${title} service`;
  return `Hi ${name}, this is Waves Pest Control with a quick billing follow-up. `
    + `Our records show ${balance}. `
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
// `invoices` = EVERY open invoice behind the snapshot, oldest-due first
// (hook r3 P1: the total is the account's, never one invoice's).
async function fileProposalCard({ dedupeKey, customer, caseRow, invoice, invoices = [invoice], daysOverdue, verdict, now = new Date() }) {
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
    invoiceCount: invoices.length,
  });
  const invoiceLines = invoices.length > 1
    ? [
        `Invoices (${invoices.length}) - $${amountDollars} open balance; the oldest is ${daysOverdue} days past due:`,
        ...invoices.map((inv) => {
          const days = daysOverdueOn(now, dueValueOf(inv));
          return `  ${inv.invoice_number || inv.id} - $${Number(invoiceAmountDue(inv)).toFixed(2)} (${days > 0 ? `${days} days past due` : 'not yet due'})`;
        }),
      ]
    : [`Invoice: ${invoiceRef} - $${amountDollars} open balance, ${daysOverdue} days past due.`];

  const NotificationService = require('../notification-service');
  const notified = await NotificationService.notifyAdmin(
    'billing',
    `Billing follow-up proposal - $${amountDollars} open balance`,
    [
      'Shadow mode: no call will be placed. This is what the policy would propose.',
      `Phone: ${maskPhone(customer.phone)}`,
      ...invoiceLines,
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
      // ONE clock per customer: the anchor is the OLDEST-DUE open invoice
      // (owner ruling 2026-08-28), not the first-created row.
      const invoiceRows = orderByDue(await db('invoices').whereIn('id', verdict.eligibleInvoiceIds).select('*'));
      const invoice = invoiceRows[0] || null;
      if (!invoice) continue;

      const dueValue = dueValueOf(invoice);
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
      // ONE read covers both concerns (codex gh-r4), UNDER the customer
      // lock (codex gh-r9): the self-heal snapshot+lapse must not
      // interleave with a promote — with the lock, a promoted duplicate is
      // seen as a live row and the customer is skipped entirely, so a
      // retained shadow sibling can never be dialed past a dial_failed
      // park's review requirement.
      const heal = await withCaseLock(customerId, async (trx) => {
        const liveRows = await trx('collection_cases')
          .where({ customer_id: customerId })
          .whereIn('current_state', ['shadow', 'approved', 'dialing', 'held'])
          .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'case_version', order: 'desc' }])
          .select('id', 'idempotency_key', 'current_state');
        if (liveRows.some((r) => r.current_state !== 'shadow')) return { skip: true };
        if (liveRows.length > 1) {
          const extras = liveRows.slice(1);
          // Fenced to still-shadow rows (codex gh-r5) — with the lock this
          // is belt-and-braces.
          await trx('collection_cases')
            .whereIn('id', extras.map((c) => c.id))
            .where({ current_state: 'shadow' })
            .update({ current_state: 'lapsed', updated_at: trx.fn.now() });
          return {
            liveShadow: [liveRows[0]],
            extraKeys: extras.map((c) => c.idempotency_key).filter(Boolean),
          };
        }
        return { liveShadow: liveRows };
      });
      if (heal.skip) continue;
      const liveShadow = heal.liveShadow;
      if (heal.extraKeys && heal.extraKeys.length) {
        await db('notifications')
          .where({ recipient_type: 'admin' })
          .whereNull('read_at')
          .whereIn(db.raw("metadata->>'dedupeKey'"), heal.extraKeys)
          .update({ read_at: db.fn.now() })
          .catch((err) => logger.warn(`[collections-shadow] duplicate-case card retirement failed: ${err.message}`));
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
        // 'held' stays out too (codex gh-r3): a dispute hold is a HUMAN
        // release state — the outcome writer deliberately leaves the case
        // held as the remaining stop when the durable flag write failed,
        // and automatic rotation would re-dial a disputing customer once
        // the 7-day ledger suppression lapses.
        existing = await db('collection_cases')
          .where({ customer_id: customerId })
          .whereNotIn('current_state', ['approved', 'dialing', 'held'])
          .orderBy('case_version', 'desc')
          .first();
      }

      // TOCTOU suspenders (codex gh-r4 P0): the reread above races a
      // promote/claim — if the row we now hold is already in the live
      // pipeline (or held), skip; the write-time state fence is the belt.
      if (existing && ['approved', 'dialing', 'held'].includes(existing.current_state)) {
        continue;
      }
      const unchanged = existing
        && existing.current_state === 'shadow'
        && Number(existing.eligible_balance_snapshot) === verdict.eligibleBalanceCents
        && JSON.stringify(normalizedIdSet(existing.eligible_invoice_ids)) === JSON.stringify(invoiceIds)
        // The LINE ITEMS are the proposal (gh r3): offsetting per-invoice
        // changes keep the aggregate but the operator would approve stale
        // amounts origination then cancels on. (A pre-column shadow case
        // rotates once to gain its snapshot.)
        && JSON.stringify(normalizedCents(existing.eligible_invoice_cents)) === JSON.stringify(normalizedCents(verdict.eligibleInvoiceCents))
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
            invoices: invoiceRows,
            daysOverdue,
            verdict,
            now,
          });
          if (refiled) cardsFiled++;
        }
        continue; // idempotent re-run — same proposal, no new row
      }

      const caseVersion = existing ? existing.case_version + 1 : 1;
      const idempotencyKey = `collections:${customerId}:${caseVersion}:${tier}`;
      const patch = {
        eligible_invoice_ids: JSON.stringify(invoiceIds),
        // The per-invoice remainder the operator approves (origination holds
        // the dial to exactly these line items).
        eligible_invoice_cents: JSON.stringify(verdict.eligibleInvoiceCents || {}),
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
        // Version-guarded update — AND state-guarded (codex gh-r3 P0): with
        // proposed rows now rotation-eligible, a concurrent promote/claim
        // (admin dial, auto-dial sweep) can move the row between our read
        // and this write; a fence on id+version alone would overwrite an
        // approved/dialing row back to shadow with a bumped version, and a
        // claimed origination's callbacks could no longer update the case.
        // The concurrent promotion wins cleanly; the unique idempotency_key
        // backstops the race either way.
        const updated = await withCaseLock(customerId, async (trx) => {
          // Owner re-read IN the lock (codex gh-r8): a merge committed
          // since our read may have repointed this row to another
          // customer — rotating it under the stale owner's lock would
          // bypass the real owner's live/held check.
          const currentOwner = await trx('collection_cases')
            .where({ id: existing.id })
            .first('customer_id');
          if (!currentOwner || String(currentOwner.customer_id) !== String(customerId)) return null;
          // In-lock live re-check (codex gh-r5): the promote paths take
          // this same customer lock, so a live/held row seen here is
          // committed truth — a 'proposed' row promoted between our reads
          // can no longer slip past the customer-level decision.
          const live = await trx('collection_cases')
            .where({ customer_id: customerId })
            .whereIn('current_state', ['approved', 'dialing', 'held'])
            .first('id');
          if (live) return null;
          const [row] = await trx('collection_cases')
            .where({ id: existing.id, customer_id: customerId, case_version: existing.case_version, current_state: existing.current_state })
            .update({ ...patch, updated_at: trx.fn.now() })
            .returning('*');
          return row || null;
        });
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
        dedupeKey: idempotencyKey, customer, caseRow, invoice, invoices: invoiceRows, daysOverdue, verdict, now,
      });
      if (filed) {
        cardsFiled++;
        // The card is filed OUTSIDE the state lock (codex gh-r10 P2): a
        // promote+dial can land between the rotation commit and this
        // insert, and the dial path's retirement then ran before the card
        // existed — leaving a fresh "no call will be placed" card for a
        // case that just dialed. Re-check and self-retire; best-effort.
        // Retire ONLY on an actual standing call record (codex gh-r11 +
        // gh-r12): case state is not proof — 'dialing' is entered before
        // the provider request and is released on a pre-provider failure,
        // and a refused attempt settles back to 'proposed'; in both cases
        // the card is the supervised retry surface. The predicate mirrors
        // origination's own idempotency probe: a call_log row under this
        // case's key whose status is not a terminal non-contact.
        // twilio_call_sid is backfilled only AFTER calls.create succeeds
        // (codex gh-r13): the row is inserted 'initiated' BEFORE the
        // provider is touched, so status alone still counts a dial that
        // never happened. Provider-confirmed or the card stays.
        const recheck = await db('call_log')
          .where({ source: 'collections_voice' })
          .whereRaw("metadata->>'collectionsIdempotencyKey' = ?", [idempotencyKey])
          .whereRaw("COALESCE(status, '') NOT IN ('failed', 'busy', 'no-answer', 'canceled')")
          .whereNotNull('twilio_call_sid')
          .first('id')
          .catch(() => null);
        if (recheck) {
          await db('notifications')
            .where({ recipient_type: 'admin' })
            .whereNull('read_at')
            .whereRaw("metadata->>'dedupeKey' = ?", [idempotencyKey])
            .update({ read_at: db.fn.now() })
            .catch((err) => logger.warn(`[collections-shadow] post-file card recheck retirement failed: ${err.message}`));
        }
      }
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
      // Fenced to still-shadow rows (codex gh-r6 P0): a dial surface can
      // promote one of these between the select and this update — the
      // fence makes the promotion win cleanly (no lock needed here: this
      // is a single conditional write, not a read-then-write decision).
      // Card keys come from the rows the fenced update ACTUALLY lapsed
      // (codex gh-r11): a case promoted between the select and this update
      // survives the fence, and retiring its card from the stale snapshot
      // would strip the supervised retry surface if the attempt then
      // refuses or dial_fails back to review.
      const lapsedRows = await db('collection_cases')
        .whereIn('id', toLapse.map((c) => c.id))
        .where({ current_state: 'shadow' })
        .update({ current_state: 'lapsed', updated_at: db.fn.now() })
        .returning(['id', 'idempotency_key']);
      casesLapsed = lapsedRows.length;
      // The proposal card must retire WITH its case (codex r5): a frozen
      // actionable card for an ineligible customer misleads, and a later
      // requalification would stack a second card beside it. Marking read
      // uses the bell's own dismissal mechanism; best-effort — a missed
      // stamp only leaves a stale card, never sends anything.
      const keys = lapsedRows.map((c) => c.idempotency_key).filter(Boolean);
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
