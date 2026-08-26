// MUTATES (dry-run default; pass --execute to write)
//
// Reschedule-orphaned card holds (owner lane 2026-08-25): an operator
// reschedule composed as cancel + fresh create leaves an estimate_card_holds
// row status='held' pointing at the DEAD visit id, so the completion charge
// missed and the customer got a pay link despite a consent-backed hold. The
// runtime lane (GATE_CARD_HOLD_RESCHEDULE_ADOPT) only DETECTS and bells the
// office at future completions — this script is the sole mover: the sweep
// for stranded holds, the operator-ruled repoint, and the optional charge.
//
// Modes:
// - No args (default): READ-ONLY scan. Lists every 'held' hold whose linked
//   visit is cancelled/rescheduled, with the same-customer live/completed
//   visits that share the hold's estimate (source_estimate_id lineage) as
//   repoint candidates. Prints the exact repoint command per row.
// - --hold=<id> --to-visit=<id>: plan (dry run) a repoint of that hold to
//   that visit. Preconditions (all re-asserted under FOR UPDATE on
//   --execute, fail closed): hold status still 'held'; target visit exists,
//   belongs to the SAME customer, carries source_estimate_id equal to the
//   hold's estimate_id, is not recurring, and is not cancelled/rescheduled;
//   the hold's current linked visit is dead (or NULL).
// - --charge (with --execute, target visit 'completed'): after the repoint
//   commits, invoke the runtime chargeCardHoldOnCompletion for the visit's
//   own invoice — the canonical claim + frozen accepted_amount cap +
//   surcharge/ledger/receipt rail; nothing is reimplemented here. MOVES
//   REAL MONEY — run only on the owner's explicit go. Requires the
//   completion invoice id via --invoice=<id> (the script prints candidates
//   in the plan); refuses a paid/voided invoice.
//
// No customer identifiers live in this file; ids arrive on the command line.
//
// Run (repo root):
//   railway run --service Postgres node ops/agents/repoint-orphaned-card-hold.js
//   railway run --service Postgres node ops/agents/repoint-orphaned-card-hold.js \
//     --hold=<uuid> --to-visit=<uuid> [--invoice=<uuid>] [--charge] \
//     [--allow-no-lineage] [--execute]
//
// --allow-no-lineage: a recreated visit made through the plain admin create
// form may carry no source_estimate_id; this operator-ruled override lets
// such a visit be the repoint target. A MISMATCHED lineage is always
// refused regardless.

const path = require('path');
const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));

const EXECUTE = process.argv.includes('--execute');
const CHARGE = process.argv.includes('--charge');
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const HOLD_ID = arg('hold');
const ALLOW_NO_LINEAGE = process.argv.includes('--allow-no-lineage');
const TO_VISIT = arg('to-visit');
const INVOICE_ID = arg('invoice');

const DEAD = ['cancelled', 'rescheduled'];
// A repoint target must be a visit that happened or is still going to —
// terminal non-performed statuses (skipped, no_show) are not valid
// carriers for a live consent (pre-push r6 P1). Allow-list, fail closed,
// matching the real scheduled_services.status vocabulary (job-status.js:
// pending/confirmed/en_route/on_site live, plus completed for the
// --charge leg) — pre-push r7 P1.
const LIVE_TARGET = ['pending', 'confirmed', 'en_route', 'on_site', 'completed'];
// Collectibility comes from the SAME authority the runtime charge uses
// (server/services/invoice-helpers) — a hand-rolled list omitted real
// collectible states like viewed/unpaid, which is exactly the state a
// stranded-hold invoice sits in after its pay link was opened (pre-push
// r7 P1).
const { isInvoiceCollectibleStatus } = require(path.join(__dirname, '..', '..', 'server', 'services', 'invoice-helpers'));

async function main() {
  const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!conn) throw new Error('DATABASE_PUBLIC_URL/DATABASE_URL not set — run via `railway run --service Postgres`');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (!HOLD_ID) return await scan(client);
    if (!TO_VISIT) throw new Error('--hold requires --to-visit');
    await repoint(client);
  } finally {
    await client.end();
  }
}

async function scan(client) {
  const { rows } = await client.query(
    `SELECT h.id AS hold_id, h.estimate_id, h.customer_id, h.accepted_amount, h.held_at,
            h.scheduled_service_id AS linked_visit_id, s.status AS linked_visit_status,
            s.scheduled_date AS linked_date, s.service_type AS linked_service_type
     FROM estimate_card_holds h
     LEFT JOIN scheduled_services s ON s.id = h.scheduled_service_id
     WHERE h.status = 'held'
       AND (h.scheduled_service_id IS NULL OR s.status = ANY($1))
     ORDER BY h.held_at DESC`, [DEAD]);
  console.log(`orphaned 'held' holds: ${rows.length}`);
  for (const r of rows) {
    // No LIMIT (PR #3496 review P2): the 1:1 verdict below must see EVERY
    // eligible candidate — a display cap applied before the one-time
    // filter could hide an older one-time visit and print a false
    // ready-made command. Candidate sets are naturally small (visits of
    // one estimate); the print is capped separately.
    const { rows: cands } = await client.query(
      `SELECT id, status, scheduled_date, is_recurring, recurring_parent_id, recurring_pattern, service_type
       FROM scheduled_services
       WHERE customer_id = $1 AND source_estimate_id = $2
         AND id IS DISTINCT FROM $3
         AND status = ANY($4)
       ORDER BY scheduled_date DESC`,
      [r.customer_id, r.estimate_id, r.linked_visit_id, LIVE_TARGET]);
    console.log(JSON.stringify({
      ...r,
      repoint_candidates: cands.slice(0, 10),
      repoint_candidates_total: cands.length,
    }, null, 1));
    // Only print a ready-made command for the UNAMBIGUOUS 1:1 shape —
    // exactly one live one-time candidate whose service identity matches
    // the dead visit's (where both are known). Estimate lineage alone does
    // not prove successor-ship (same P0 as the runtime adoption); anything
    // else stays a human decision on the rows printed above.
    const oneTime = cands.filter((c) => !(c.is_recurring === true || c.recurring_parent_id || c.recurring_pattern));
    const identityOk = (c) => !r.linked_service_type || !c.service_type
      || String(c.service_type) === String(r.linked_service_type);
    if (oneTime.length === 1 && identityOk(oneTime[0])) {
      const best = oneTime[0];
      console.log(`  → railway run --service Postgres node ops/agents/repoint-orphaned-card-hold.js --hold=${r.hold_id} --to-visit=${best.id}${best.status === 'completed' ? ' [--invoice=<id> --charge]' : ''} --execute`);
    } else if (cands.length) {
      console.log('  → ambiguous (multiple/mismatched candidates) — operator picks --to-visit by hand');
    }
  }
  if (!rows.length) console.log('nothing stranded — no writes possible in this mode anyway');
}

async function repoint(client) {
  await client.query('BEGIN');
  let committed = false;
  try {
    const { rows: [hold] } = await client.query(
      `SELECT id, status, estimate_id, customer_id, scheduled_service_id, accepted_amount
       FROM estimate_card_holds WHERE id = $1 FOR UPDATE`, [HOLD_ID]);
    if (!hold) throw new Error('hold not found');
    if (hold.status !== 'held') throw new Error(`hold status is '${hold.status}', not 'held' — refusing`);
    // Idempotent retry (pre-push r10 P1): a hold already pointing at the
    // target — a committed repoint whose charge leg then failed
    // (feature_disabled, decline, operator ran --charge later) — is not an
    // orphan-on-a-dead-visit, it's the intended state. Skip the dead-link
    // check (the "original" visit IS the target) and the UPDATE; every
    // target/invoice guard below still reasserts, and the charge leg runs.
    const alreadyRepointed = String(hold.scheduled_service_id || '') === String(TO_VISIT);
    if (!alreadyRepointed && hold.scheduled_service_id) {
      // FOR UPDATE (pre-push r8 P0): the dead-status verdict on the hold's
      // ORIGINAL visit must hold through the repoint — a concurrent
      // reactivation of that visit between an unlocked read and COMMIT
      // would move the consent off a visit that is live again.
      const { rows: [linked] } = await client.query(
        `SELECT status FROM scheduled_services WHERE id = $1 FOR UPDATE`, [hold.scheduled_service_id]);
      if (linked && !DEAD.includes(linked.status)) {
        throw new Error(`hold's current visit is '${linked.status}' (live) — not an orphan, refusing`);
      }
    }
    // FOR UPDATE (pre-push r5 P0): the target visit and its invoices are
    // locked in the SAME transaction as the repoint so a concurrent
    // reassignment or invoice rebind can't outrun these preconditions.
    // The --charge leg's money move additionally re-verifies the
    // visit↔invoice↔customer binding under the charge authority's OWN
    // locks (chargeCardHoldOnCompletion passes
    // requireSelfPayScheduledServiceId into chargeInvoiceWithSavedCard),
    // so the binding cannot go stale between this COMMIT and the charge.
    const { rows: [visit] } = await client.query(
      `SELECT id, customer_id, source_estimate_id, status, is_recurring, recurring_parent_id, recurring_pattern, scheduled_date
       FROM scheduled_services WHERE id = $1 FOR UPDATE`, [TO_VISIT]);
    if (!visit) throw new Error('target visit not found');
    if (String(visit.customer_id) !== String(hold.customer_id)) throw new Error('target visit belongs to a different customer — refusing');
    // Lineage: a recreated visit made through the plain admin create form
    // may carry NO source_estimate_id at all. A MISMATCHED lineage is
    // always refused; a NULL one is refused unless the operator explicitly
    // rules the successor with --allow-no-lineage (same-customer +
    // one-time + live-target checks still apply, and the runtime cap still
    // bounds any charge).
    if (visit.source_estimate_id) {
      if (String(visit.source_estimate_id) !== String(hold.estimate_id)) throw new Error('target visit is not from the hold\'s estimate — refusing');
    } else if (!ALLOW_NO_LINEAGE) {
      throw new Error('target visit has no source_estimate_id — re-run with --allow-no-lineage if you have ruled it the successor');
    }
    // Canonical recurring-lineage test (pay-v2.js; PR #3496 r3 P1): a
    // series booster carries is_recurring=false with recurring_parent_id
    // set — any of the three markers disqualifies the target.
    if (visit.is_recurring === true || visit.recurring_parent_id || visit.recurring_pattern) {
      throw new Error('target visit has recurring lineage — the hold rail is one-time only, refusing');
    }
    if (!LIVE_TARGET.includes(visit.status)) throw new Error(`target visit is '${visit.status}' — not a live/completed target, refusing`);

    // No OTHER active hold may already sit on the target (pre-push r11
    // P0): scheduled_service_id has no uniqueness constraint, and the
    // runtime charge selects the newest held row for the visit — a second
    // consent row could be charged in place of the one the operator ruled
    // on. Locked so a concurrent insert/transition serializes with this
    // decision.
    const { rows: otherHolds } = await client.query(
      `SELECT id, status FROM estimate_card_holds
       WHERE scheduled_service_id = $1 AND id <> $2 AND status IN ('held','charging')
       FOR UPDATE`, [TO_VISIT, HOLD_ID]);
    if (otherHolds.length) {
      throw new Error(`target visit already carries ${otherHolds.length} other active hold(s) — refusing; resolve those first`);
    }

    // No /secure appointment-card lane row on the target AT ALL (PR #3496
    // review P1 + pre-push r13 P0): a recreated visit later secured
    // through /secure has its own newer consent + card, and both
    // completion rails treat ANY estimate-hold row as owning the lane —
    // repointing would suppress that consent and could draw the OLD card.
    // Locked and refused REGARDLESS of status: a pending/completing
    // request can finish right after this transaction and become newer
    // consent just the same (the table has no dead status to safely
    // exempt). The FOR UPDATE serializes a mid-flight /secure completion
    // against this decision; the operator reconciles which consent should
    // own the visit before any repoint.
    const { rows: apptRows } = await client.query(
      `SELECT id, status FROM appointment_card_requests
       WHERE scheduled_service_id = $1
       FOR UPDATE`, [TO_VISIT]);
    if (apptRows.length) {
      const statuses = apptRows.map((a) => a.status).join(',');
      throw new Error(`target visit carries ${apptRows.length} /secure appointment-card request row(s) (status: ${statuses}) — refusing; reconcile which consent owns the visit first`);
    }

    // Completion-invoice candidates, for the --charge leg and the plan print.
    const { rows: invoices } = await client.query(
      `SELECT id, status, total FROM invoices
       WHERE scheduled_service_id = $1 AND status NOT IN ('void','voided','cancelled')
       ORDER BY created_at DESC LIMIT 5 FOR UPDATE`, [TO_VISIT]);

    // --charge preconditions (pre-push P0): the charge leg is only for a
    // visit that ALREADY completed (an upcoming visit's charge belongs to
    // its own completion flow — never pre-charge it), and the invoice must
    // be one of THAT visit's own collectible invoices — the runtime service
    // checks customer ownership but not visit binding, so an operator typo
    // could otherwise draw the hold against an unrelated bill.
    if (CHARGE) {
      if (visit.status !== 'completed') throw new Error(`--charge requires a completed target visit (status is '${visit.status}') — refusing`);
      if (!INVOICE_ID) throw new Error('--charge requires --invoice=<id> (see invoice_candidates in the plan output)');
      const bound = invoices.find((i) => String(i.id) === String(INVOICE_ID));
      if (!bound) throw new Error('--invoice is not an invoice of the target visit — refusing');
      if (!isInvoiceCollectibleStatus(bound.status)) {
        throw new Error(`--invoice status is '${bound.status}', not collectible — refusing`);
      }
    }

    console.log(JSON.stringify({
      plan: 'repoint',
      hold_id: hold.id,
      from_visit: hold.scheduled_service_id,
      to_visit: visit.id,
      visit_status: visit.status,
      accepted_amount_cap: hold.accepted_amount,
      invoice_candidates: invoices,
      charge_requested: CHARGE,
      already_repointed: alreadyRepointed,
    }, null, 1));

    if (!EXECUTE) {
      console.log('DRY RUN — no writes. Re-run with --execute to repoint.');
      await client.query('ROLLBACK');
      return;
    }
    if (alreadyRepointed) {
      await client.query('ROLLBACK');
      committed = true; // nothing to write; release locks before the charge leg
      console.log('already repointed — no update needed.');
    } else {
      const { rowCount } = await client.query(
        `UPDATE estimate_card_holds SET scheduled_service_id = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'held'`, [TO_VISIT, HOLD_ID]);
      if (rowCount !== 1) throw new Error('CAS repoint did not land — refusing');
      // Durable record of the operator's decision in the SAME transaction
      // (PR #3496 review P2, following stamp-billing-mode.js): the update
      // overwrites the hold's only reference to the original visit, and a
      // later completion charge of the transferred consent must be
      // investigable back to this ruling.
      await client.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ('system', NULL, 'billing.card_hold.repoint', 'estimate_card_hold', $1, $2::jsonb)`,
        [HOLD_ID, JSON.stringify({
          from_scheduled_service_id: hold.scheduled_service_id,
          to_scheduled_service_id: TO_VISIT,
          allow_no_lineage: ALLOW_NO_LINEAGE,
          charge_requested: CHARGE,
          accepted_amount_cap: hold.accepted_amount,
          source: 'ops/agents/repoint-orphaned-card-hold.js',
          ruling: 'owner-ruled reschedule-successor repoint (stranded-hold lane 2026-08-25)',
        })],
      );
      await client.query('COMMIT');
      committed = true;
      console.log('repointed.');
    }
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  if (EXECUTE && CHARGE) {
    // Preconditions (completed visit, target-bound collectible invoice)
    // were asserted inside the repoint transaction above.
    // The charge rides the runtime service — claim, frozen accepted_amount
    // cap, single surcharge authority, ledger, receipt — via the public DB
    // proxy. STRIPE_SECRET_KEY must be in the injected env.
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    process.env.PGSSLMODE = process.env.PGSSLMODE || 'no-verify';
    const CardHolds = require(path.join(__dirname, '..', '..', 'server', 'services', 'estimate-card-holds'));
    const result = await CardHolds.chargeCardHoldOnCompletion({ scheduledServiceId: TO_VISIT, invoiceId: INVOICE_ID, expectedHoldId: HOLD_ID });
    console.log(JSON.stringify({ charge: result }, null, 1));
    const dbHandle = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
    await dbHandle.destroy().catch(() => {});
    if (!result?.charged) process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
