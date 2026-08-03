/**
 * completion-charge-why.js — READ-ONLY
 *
 * "The customer got a pay link instead of a receipt — why wasn't the card on
 * file charged?" for a ONE-TIME visit.
 *
 * Replays the appointment-card completion-charge lane
 * (server/routes/admin-dispatch.js, the `apptCardOneTimeCharge` block) against
 * the live row state for one visit and names the FIRST condition that blocked
 * the charge. Every check below mirrors a specific line of that lane; when the
 * lane moves, this script has to move with it.
 *
 * Why this exists: most of the failure modes are silent (gate off, no lane row,
 * lane excluded, Auto Pay down), and the two that ring the office bell ("Auto
 * Pay charge skipped — no accepted amount on file" / "... above accepted amount
 * — review") only ring when the lane got that far. Telling them apart by hand
 * means six joins across five tables, and the remedy differs for each. Note a
 * bell's ABSENCE is not evidence: a within-cap invoice raises none by design,
 * and both notifyAdmin calls swallow their own failures.
 *
 * CHECK ORDER MIRRORS PRODUCTION'S NESTING, not convenience, because the
 * verdict is the FIRST blocker and a wrongly-ordered check sends the operator
 * to fix something that was never the problem:
 *
 *   gate → lane preconditions (billing mode, one-time, performed, not backfill,
 *   invoice + alreadyPaid) → LANE MEMBERSHIP (appointment_card_requests)
 *   → AUTO PAY → CAP → LIVE PAYER → recorded charge failure
 *
 * Lane membership comes first because only a visit on the lane reaches the
 * charge block at all (admin-dispatch.js:8095-8133). Auto Pay is the outer
 * condition on that block (8217-8220), so the cap and its office bell are
 * unreachable until it passes. The live-payer re-resolve happens INSIDE the
 * block, after the cap (8361-8377) — so an over-cap visit reports the cap bell,
 * not the payer.
 *
 * A CLEAN verdict is only ever printed when every condition was actually
 * verified AND no recorded charge failure exists for the visit. Anything this
 * script cannot see from the DB (most importantly the charge gate, which lives
 * on the portal service) is reported as INCONCLUSIVE and exits nonzero — a
 * diagnostic that says "all conditions passed" when it simply could not check
 * one of them is worse than no diagnostic at all.
 *
 * Auto Pay eligibility uses the PRODUCTION helpers
 * (server/services/autopay-eligibility.js) rather than a re-implementation, so
 * the ET pause window and card-expiry semantics cannot drift from the rail.
 * Live payer resolution mirrors services/payer.js `resolveForInvoice`.
 *
 * Reads only. Prints IDs, amounts and statuses — never names, phones, or card
 * details.
 *
 * Exit codes:  0 = every condition verified and passing, no recorded failure
 *              1 = a blocking condition (or a recorded charge failure) found
 *              2 = inconclusive (something could not be verified)
 *
 * Run:  railway run --service Postgres node ops/agents/completion-charge-why.js --visit=<scheduled_service_id>
 *
 * The charge gate lives on the PORTAL service, so under `--service Postgres`
 * it is not visible. Either pass it through explicitly:
 *   GATE_APPT_CARD_COMPLETION_CHARGE=$(railway variables --service waves-customer-portal --kv \
 *     | grep '^GATE_APPT_CARD_COMPLETION_CHARGE=' | cut -d= -f2) \
 *     railway run --service Postgres node ops/agents/completion-charge-why.js --visit=<id>
 * or accept the INCONCLUSIVE verdict and check the gate by hand.
 */

const path = require('path');
const { Client } = require('pg');

// The real predicates — never a local copy. isPaused applies the America/
// New_York date comparison; isExpiredCardMethod treats a malformed expiry as
// expired and exempts bank methods.
const {
  isPaused,
  isExpiredCardMethod,
  isBankMethodType,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'autopay-eligibility.js'));

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const OK = '  ok  ';
const BLOCK = 'BLOCK ';
const UNKNOWN = '  ??  ';
const INFO = ' info ';

function money(v) {
  return v == null ? 'null' : `$${Number(v).toFixed(2)}`;
}

function parseNotes(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

async function main() {
  const visitId = arg('visit');
  if (!visitId) {
    console.error('Usage: railway run --service Postgres node ops/agents/completion-charge-why.js --visit=<scheduled_service_id>');
    process.exit(2);
  }
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/completion-charge-why.js --visit=<id>');
    process.exit(2);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Findings, in production-nesting order — POSITION is load-bearing. The
  // first BLOCK is the verdict only when no UNKNOWN precedes it; an earlier
  // unverified condition could have stopped production before that block was
  // ever reached, so the run is inconclusive instead.
  const findings = [];
  const say = (level, label, detail) => {
    findings.push({ level, label, detail });
    console.log(`[${level}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const { rows: visitRows } = await client.query(
      `SELECT s.id, s.customer_id, s.is_recurring, s.estimated_price, s.status,
              s.recurring_parent_id, s.source_estimate_id, s.completed_at, s.scheduled_date,
              s.payer_id AS visit_payer_id,
              c.billing_mode, c.autopay_enabled, c.autopay_paused_until, c.ach_status,
              c.payer_id AS customer_payer_id
         FROM scheduled_services s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1`,
      [visitId],
    );
    if (!visitRows.length) {
      console.error(`No scheduled_services row for ${visitId}`);
      process.exit(2);
    }
    const v = visitRows[0];

    // self_pay_override is newer than some deployments — resolveForInvoice
    // feature-detects it, so this does too.
    let selfPayOverride = null;
    try {
      const { rows } = await client.query(
        'SELECT self_pay_override FROM scheduled_services WHERE id = $1', [visitId],
      );
      selfPayOverride = rows[0]?.self_pay_override === true;
    } catch { selfPayOverride = null; /* column absent on this deployment */ }

    const { rows: recRows } = await client.query(
      `SELECT id, structured_notes, report_template_version, created_at
         FROM service_records
        WHERE scheduled_service_id = $1
        ORDER BY created_at DESC`,
      [visitId],
    );
    const record = recRows[0] || null;
    const notes = parseNotes(record?.structured_notes);

    console.log('=== visit ===');
    console.log(`  visit           ${v.id}`);
    console.log(`  customer        ${v.customer_id}`);
    console.log(`  status          ${v.status}`);
    console.log(`  scheduled       ${v.scheduled_date}`);
    console.log(`  completed_at    ${v.completed_at}`);
    console.log(`  is_recurring    ${v.is_recurring}`);
    console.log(`  estimated_price ${money(v.estimated_price)}`);
    console.log(`  billing_mode    ${v.billing_mode}`);
    console.log(`  source_estimate ${v.source_estimate_id || 'none'}`);
    console.log(`  visitOutcome    ${notes.visitOutcome || '(not recorded)'}`);
    console.log(`  backfill        ${notes.backfill === true}`);
    console.log('');

    console.log('=== lane replay, in production nesting order ===');

    // 1. Gate. Lives on the portal service; an unknown gate must never yield a
    //    clean verdict.
    const gate = process.env.GATE_APPT_CARD_COMPLETION_CHARGE;
    if (gate === undefined) {
      say(UNKNOWN, 'GATE_APPT_CARD_COMPLETION_CHARGE not visible from this service',
        'the lane cannot be cleared without it — check: railway variables --service waves-customer-portal | grep GATE_APPT_CARD_COMPLETION_CHARGE');
    } else if (gate !== 'true') {
      say(BLOCK, `GATE_APPT_CARD_COMPLETION_CHARGE=${JSON.stringify(gate)}`,
        'lane is dark — completion invoices go out as pay links by design. Remedy: owner flips the gate to true.');
    } else {
      say(OK, 'GATE_APPT_CARD_COMPLETION_CHARGE=true');
    }

    // 2. Lane preconditions — admin-dispatch.js `if (!perApplicationBilling &&
    //    !annualPrepayBilling && !explicitMembershipLane && is_recurring !==
    //    true && visitPerformed && invoice && !alreadyPaid && !payer_id)`.
    if (v.is_recurring === true) {
      say(BLOCK, 'visit is_recurring=true', 'this lane is one-time visits only; recurring visits bill on their own rail.');
    } else {
      say(OK, 'visit is one-time');
    }

    const mode = String(v.billing_mode || '');
    if (mode === 'per_application') {
      say(BLOCK, 'customer billing_mode=per_application',
        'the per-application rail owns this completion — the appointment-card lane never engages. A charge, if any, would be logged as completionChargeSource=per_application_completion.');
    } else if (mode === 'annual_prepay') {
      say(BLOCK, 'customer billing_mode=annual_prepay',
        'annual-prepay visits settle via prepaid stamps, not a completion auto-charge.');
    } else if (mode === 'monthly_membership') {
      say(BLOCK, 'customer billing_mode=monthly_membership',
        'explicit membership lane — dues bill separately, so the completion lane stands down.');
    } else {
      say(OK, `customer billing_mode=${mode || '(none)'} — not an excluded lane`);
    }

    // 3. visitPerformed + backfill, both frozen on the completion record.
    if (!record) {
      say(UNKNOWN, 'no service_records row for this visit',
        'visitOutcome and the backfill marker cannot be read, so "nothing was performed" and "quiet backlog closeout" cannot be ruled out.');
    } else {
      const outcome = notes.visitOutcome;
      if (outcome === undefined) {
        say(UNKNOWN, 'visitOutcome not recorded on the completion record',
          'cannot confirm an application was actually performed.');
      } else if (['inspection_only', 'customer_declined'].includes(String(outcome))) {
        say(BLOCK, `visitOutcome=${outcome}`, 'nothing was performed, so nothing auto-charges.');
      } else {
        say(OK, `visitOutcome=${outcome}`);
      }

      if (notes.backfill === true) {
        say(BLOCK, 'backfill completion',
          'a backlog closeout never moves money automatically — the invoice is left open for explicit operator collection.');
      } else {
        say(OK, 'live completion (not a backfill closeout)');
      }
    }

    // 4. Invoices. `alreadyPaid` comes from a SEPARATE lookup scoped to the
    //    CURRENT completion record (admin-dispatch.js:7110-7115); the invoice
    //    the route then reuses is selected independently. Both are mirrored
    //    below — collapsing them reports the wrong blocker when an older paid
    //    invoice sits alongside a newer open one.
    const { rows: invRows } = await client.query(
      `SELECT id, status, subtotal, total, discount_amount, payer_id, credit_applied,
              service_record_id, created_at
         FROM invoices
        WHERE (scheduled_service_id = $1
               OR service_record_id IN (SELECT id FROM service_records WHERE scheduled_service_id = $1))
          AND status <> 'void'
        ORDER BY created_at DESC`,
      [visitId],
    );
    for (const r of invRows) {
      console.log(`         invoice ${r.id} status=${r.status} subtotal=${money(r.subtotal ?? r.total)} discount=${money(r.discount_amount)} payer_id=${r.payer_id || 'none'} record=${r.service_record_id || 'none'}`);
    }

    // `alreadyPaid` is scoped to the CURRENT completion record only — not to
    // every invoice ever attached to the visit. An older paid invoice on a
    // PRIOR record does not suppress the lane.
    const paidRow = record
      ? invRows.find((r) => String(r.service_record_id) === String(record.id)
        && ['paid', 'prepaid'].includes(String(r.status).toLowerCase()))
      : null;

    // Then the invoice the route would reuse: newest non-void on the current
    // record, else newest non-void on the visit (invRows is already
    // created_at DESC).
    const inv = (record && invRows.find((r) => String(r.service_record_id) === String(record.id)))
      || invRows[0]
      || null;

    if (!invRows.length) {
      say(BLOCK, 'no non-void invoice for this visit', 'nothing to charge.');
    } else if (paidRow) {
      say(BLOCK, `the current completion record already has a ${paidRow.status} invoice (${paidRow.id})`,
        'the route sets alreadyPaid from a paid/prepaid invoice on THIS record, which suppresses the completion charge.');
    } else {
      say(OK, 'no paid/prepaid invoice on the current completion record');
    }

    if (inv) {
      const subtotal = inv.subtotal != null ? Number(inv.subtotal) : Number(inv.total || 0);
      inv._net = Math.round((subtotal - Math.max(0, Number(inv.discount_amount) || 0)) * 100) / 100;
      // The charge condition refuses these statuses outright
      // (admin-dispatch.js:8219). `processing` means an ACH debit is already
      // in flight — money is moving, so this is a legitimate no-charge, not a
      // clean lane.
      const st = String(inv.status || '').toLowerCase();
      if (['paid', 'prepaid', 'void', 'processing'].includes(st)) {
        say(BLOCK, `the invoice the route would reuse is ${st} (${inv.id})`,
          st === 'processing'
            ? 'an ACH debit is already in flight — the route never re-charges a processing invoice; the webhook settles processing→paid and the receipt delivers then.'
            : 'already settled — nothing to collect.');
      }
      if (inv.payer_id) {
        say(BLOCK, `invoice ${inv.id} has a payer_id`, 'third-party-billed invoices never auto-charge the homeowner.');
      }
    }

    // LIVE payer at the charge boundary. Defined here, INVOKED after the cap —
    // production re-resolves the payer inside the charge block, after the cap
    // comparison (admin-dispatch.js:8361-8377 via services/payer
    // resolveForInvoice), so an over-cap visit reports the cap bell, not this.
    // Mirrored: per-visit payer wins; self_pay_override blocks the
    // account-default fallback; otherwise the customer's payer applies.
    async function checkLivePayer() {
    let livePayerId = null;
    if (v.visit_payer_id) {
      livePayerId = v.visit_payer_id;
    } else if (selfPayOverride === true) {
      livePayerId = null;
    } else if (selfPayOverride === null) {
      say(UNKNOWN, 'scheduled_services.self_pay_override not readable',
        'cannot rule out that an account-default payer applies to this visit.');
      livePayerId = v.customer_payer_id || null;
    } else {
      livePayerId = v.customer_payer_id || null;
    }
    // A payer LINK is not a payer. resolveForInvoice loads the row and falls
    // back to self-pay when the payer is missing or `active === false` — a
    // deactivated payer must not be reported as the blocker.
    if (livePayerId) {
      let payerRow = null;
      let payerLookupFailed = false;
      try {
        const { rows } = await client.query('SELECT id, active FROM payers WHERE id = $1', [livePayerId]);
        payerRow = rows[0] || null;
      } catch (e) { payerLookupFailed = true; }
      const src = v.visit_payer_id ? 'visit' : 'customer default';
      if (payerLookupFailed) {
        say(UNKNOWN, `payer ${livePayerId} linked (${src}) but the payers table was not readable`,
          'cannot tell an active payer (blocks the charge) from a deactivated one (falls back to self-pay).');
      } else if (!payerRow) {
        say(OK, `payer link ${livePayerId} (${src}) resolves to nothing — self-pay`);
      } else if (payerRow.active === false) {
        say(OK, `payer ${livePayerId} (${src}) is INACTIVE — resolveForInvoice falls back to self-pay`);
      } else {
        say(BLOCK, `live payer resolves to ACTIVE payer ${livePayerId} (${src})`,
          'the charge boundary re-resolves the payer and refuses to charge when an active one exists, even with invoices.payer_id null. The payer flows own this bill.');
      }
    } else {
      say(OK, 'live payer resolution = self-pay');
    }
    }

    // AUTO PAY — the outer condition on the charge block. Defined here,
    // INVOKED after lane membership is established, because production only
    // reaches it for a visit already on the appointment-card lane.
    async function checkAutoPay() {
    const { rows: pmRows } = await client.query(
      `SELECT id, processor, method_type, is_default, autopay_enabled,
              stripe_payment_method_id, exp_month, exp_year
         FROM payment_methods
        WHERE customer_id = $1 AND processor = 'stripe'
          AND is_default = true AND autopay_enabled = true`,
      [v.customer_id],
    );
    let autopayOk = true;
    const failAutopay = (label, detail) => { autopayOk = false; say(BLOCK, label, detail); };
    if (v.autopay_enabled === false) {
      failAutopay('customer.autopay_enabled = false', 'Auto Pay is off — the charge condition never runs, and the cap is never evaluated.');
    }
    if (isPaused(v)) {
      failAutopay(`Auto Pay paused through ${String(v.autopay_paused_until).slice(0, 10)} (ET)`,
        'a pause covering today blocks the charge. NOTE: compared against TODAY, not the completion date — re-check if the visit is older.');
    } else if (v.autopay_paused_until) {
      say(OK, `Auto Pay pause expired (${String(v.autopay_paused_until).slice(0, 10)})`);
    }
    if (!pmRows.length) {
      failAutopay('no default Stripe payment method with autopay_enabled', 'nothing chargeable on file at the charge boundary.');
    } else {
      const pm = pmRows[0];
      if (!pm.stripe_payment_method_id) {
        failAutopay(`payment method ${pm.id} has no stripe_payment_method_id`, 'not chargeable.');
      } else if (isExpiredCardMethod(pm)) {
        failAutopay(`default card expired or malformed expiry (${pm.exp_month || '--'}/${pm.exp_year || '----'})`,
          'isExpiredCardMethod treats a malformed expiry as expired. NOTE: evaluated against TODAY, not the completion date.');
      } else {
        say(OK, `chargeable ${pm.method_type} method on file (exp ${pm.exp_month || '--'}/${pm.exp_year || '----'})`);
      }
      if (v.ach_status && v.ach_status !== 'active' && isBankMethodType(pm.method_type)) {
        failAutopay(`ach_status=${v.ach_status} with a bank default method`, 'the lane forces card-only when ACH is unhealthy.');
      }
    }
    return autopayOk;
    }

    // 7. Lane membership — appointment_card_requests, completed/satisfied.
    //    Production establishes this FIRST (admin-dispatch.js:8095-8133); only
    //    a visit on this lane reaches the Auto Pay / cap block below.
    const { rows: laneRows } = await client.query(
      `SELECT id, customer_id, status, accepted_amount, selected_plan, created_at
         FROM appointment_card_requests
        WHERE scheduled_service_id = $1
        ORDER BY created_at DESC`,
      [visitId],
    );
    const lane = laneRows.find((r) => ['completed', 'satisfied'].includes(String(r.status)));
    if (!laneRows.length) {
      say(BLOCK, 'no appointment_card_requests row for this visit',
        'the card was never secured through the /secure lane (added in Customer 360 or saved by the customer in the portal). A plain saved card does NOT auto-charge a one-time completion, and no cron sweeps it. Remedy: send the /secure card link for the visit.');
    } else if (!lane) {
      say(BLOCK, `lane row exists but status=${laneRows.map((r) => r.status).join(',')}`,
        'only completed/satisfied rows charge.');
    } else {
      say(OK, `lane row ${lane.id} status=${lane.status}`);

      const { rows: holdRows } = await client.query(
        'SELECT id FROM estimate_card_holds WHERE scheduled_service_id = $1', [visitId],
      );
      if (holdRows.length) {
        say(BLOCK, `estimate_card_holds row ${holdRows[0].id} exists`,
          'the hold rail owns estimate-flow one-time bookings; the appointment-card lane stands down by design.');
      } else {
        say(OK, 'no estimate_card_holds row');
      }

      if (String(lane.customer_id) !== String(v.customer_id)) {
        say(BLOCK, `lane customer ${lane.customer_id} != visit customer ${v.customer_id}`,
          'a reassigned visit never rides a prior customer consent into automatic collection.');
      } else {
        say(OK, 'lane customer matches visit customer');
      }
    }

    // 8. AUTO PAY — the outer condition on the charge block
    //    (admin-dispatch.js:8217-8220). Only a visit that already established
    //    lane membership above reaches it, and the cap below sits inside it.
    const autopayOk = await checkAutoPay();

    // 9. accepted_amount — the frozen cap. Production evaluates it INSIDE the
    //    Auto Pay-gated block, so it is only meaningful once BOTH lane
    //    membership and Auto Pay have passed; otherwise production never got
    //    here and raised no bell.
    if (lane) {
      const accepted = lane.accepted_amount == null ? null : Number(lane.accepted_amount);
      const capLevel = autopayOk ? BLOCK : INFO;
      const capNote = autopayOk ? '' : ' (Auto Pay blocked first — production never reached this comparison and raised NO bell)';
      if (accepted == null) {
        say(capLevel, `accepted_amount IS NULL${capNote}`,
          'pre-migration row or unstamped render — the lane routes to office review.'
          + (autopayOk ? ' Expect the "no accepted amount on file" bell.' : ''));
      } else if (accepted === 0) {
        say(capLevel, `accepted_amount = 0 (STICKY sentinel)${capNote}`,
          'the /secure page never DISPLAYED a price, so nothing was stamped. Causes: GATE_SECURE_PLAN_CHOICE off, estimated_price null/0 at render, a commercial property, or a source_estimate_id visit. '
          + 'This row is PERMANENTLY unchargeable and CANNOT be repaired: appointment_card_requests.scheduled_service_id is UNIQUE (one request per visit, ever), so no re-secure can create a fresh row, and every later stamp preserves zero via CASE WHEN accepted_amount = 0 THEN 0. '
          + 'Remedy for THIS visit: collect manually (send the pay link or charge in admin) — the auto-charge is not recoverable. '
          + 'Remedy for FUTURE visits: flip GATE_SECURE_PLAN_CHOICE and confirm visits carry estimated_price > 0 before the /secure link goes out, so a real cap gets stamped.');
      } else {
        say(OK, `accepted_amount = ${money(accepted)}`);
        if (inv && inv._net > accepted + 0.005) {
          say(capLevel, `invoice net ${money(inv._net)} exceeds cap ${money(accepted)}${capNote}`,
            'over-cap invoices route to office review and keep the pay link.'
            + (autopayOk
              ? ' Expect the "above accepted amount" bell. Remedy: adjust the invoice to the accepted amount or collect manually.'
              : ' Fix the Auto Pay blocker above first — this comparison was never reached.'));
        } else if (inv) {
          say(OK, `invoice net ${money(inv._net)} within cap ${money(accepted)}`);
        }
      }
    }

    // 10. LIVE payer re-resolution — production's LAST gate before the charge
    //     itself, after the cap comparison.
    await checkLivePayer();

    // 11. The recorded charge OUTCOME. Every predicate can pass and the charge
    //    still throw (processor decline, Stripe/config error, DB failure) — the
    //    route logs charge_failed with this visit id. Only the LATEST terminal
    //    outcome decides the verdict: a failure followed by a successful retry
    //    is not a blocker, and reporting it as one would send an operator to
    //    re-collect money already taken. Orphaned / reconciliation-flagged
    //    failures are still surfaced even when superseded — they are a
    //    bookkeeping problem a later success does not undo.
    const TERMINAL = /^(charge|retry|manual_charge)/;
    let chargeFailure = null;
    let chargeSuccess = null;
    let supersededFlags = [];
    try {
      const { rows: logRows } = await client.query(
        `SELECT id, event_type, amount_cents, created_at, details
           FROM autopay_log
          WHERE customer_id = $1
            AND details::jsonb ->> 'scheduled_service_id' = $2
          ORDER BY created_at DESC`,
        [v.customer_id, visitId],
      );
      console.log('\n=== autopay_log for this visit ===');
      if (!logRows.length) {
        console.log('  no charge attempt recorded.');
      } else {
        for (const l of logRows) {
          const d = parseNotes(l.details);
          console.log(`  ${l.created_at.toISOString()}  ${l.event_type}  source=${d.source || '?'}  ${d.error ? `error=${d.error}` : ''}`);
        }
        // logRows is newest-first, so the first terminal row IS the outcome.
        const latest = logRows.find((l) => TERMINAL.test(String(l.event_type)));
        if (latest && String(latest.event_type).includes('failed')) chargeFailure = latest;
        else if (latest) chargeSuccess = latest;
        // Unresolved bookkeeping on any earlier failure still matters.
        supersededFlags = logRows
          .filter((l) => l !== latest && String(l.event_type).includes('failed'))
          .map((l) => ({ l, d: parseNotes(l.details) }))
          .filter(({ d }) => d.orphaned || d.reconciliation_required);
      }
    } catch (e) {
      say(UNKNOWN, `autopay_log not readable (${e.message})`,
        'a recorded charge failure cannot be ruled out.');
    }
    if (chargeFailure) {
      const d = parseNotes(chargeFailure.details);
      say(BLOCK, `charge ATTEMPTED and FAILED (${chargeFailure.event_type}, ${chargeFailure.created_at.toISOString()})`,
        `every eligibility predicate passed and the charge itself failed: ${d.error || 'no error recorded'}`
        + `${d.orphaned ? ' — ORPHANED: Stripe charged but the DB write failed, reconcile immediately.' : ''}`
        + `${d.reconciliation_required ? ' — reconciliation_required flagged.' : ''}`);
    } else if (chargeSuccess) {
      say(INFO, `charge SUCCEEDED (${chargeSuccess.event_type}, ${chargeSuccess.created_at.toISOString()})`,
        'the latest terminal outcome for this visit is a success — the card WAS charged. Any earlier failure above was superseded by a retry.');
    }
    for (const { l, d } of supersededFlags) {
      say(INFO, `superseded failure at ${l.created_at.toISOString()} still carries an unresolved flag`,
        `${d.orphaned ? 'ORPHANED (Stripe charged, DB write failed) ' : ''}${d.reconciliation_required ? 'reconciliation_required ' : ''}— a later success does not clear this; reconcile the ledger.`);
    }

    // 12. Office bells. A bell that IS present is strong evidence the cap
    //     branch ran. Its ABSENCE proves nothing — see below.
    console.log('\n=== office bells for this visit ===');
    const { rows: notifRows } = await client.query(
      `SELECT id, title, created_at
         FROM notifications
        WHERE recipient_type = 'admin'
          AND category = 'billing'
          AND metadata::jsonb ->> 'scheduledServiceId' = $1
        ORDER BY created_at DESC`,
      [visitId],
    );
    if (!notifRows.length) {
      // Absence proves nothing about which branch ran. A within-cap invoice
      // raises no bell by design, and both notifyAdmin calls are best-effort
      // inside a swallowing catch (admin-dispatch.js:8315-8332) — so a bell
      // can be missing from a successful charge AND from a failed
      // notification. Report the absence, never infer the branch.
      console.log('  no cap-review notification recorded for this visit.');
      console.log('  (Not evidence the lane stopped early: a within-cap invoice raises no bell,');
      console.log('   and both notifyAdmin calls are best-effort and swallow their own failures.)');
    } else {
      for (const n of notifRows) console.log(`  ${n.created_at.toISOString()}  ${n.title}`);
    }

    // 13. What the customer actually received.
    console.log('\n=== completion SMS actually sent ===');
    if (!recRows.length) {
      console.log('  no service_records row.');
    } else {
      for (const r of recRows) {
        const n = parseNotes(r.structured_notes);
        console.log(`  record ${r.id}  template_version=${r.report_template_version || 'none'}  sms=${n.completionSmsType || 'none'} (${n.completionSmsStatus || 'n/a'})`);
      }
    }

    // Verdict. `findings` is in production-nesting order, so POSITION decides:
    // an UNKNOWN standing EARLIER than the first BLOCK means production may
    // have stopped before ever reaching that block, and naming it as the cause
    // would recreate the very ordering error this tool exists to prevent —
    // e.g. an unreadable gate plus a missing lane row must not be reported as
    // "no lane row", because a dark gate would have stopped it first.
    console.log('\n=== verdict ===');
    const firstBlockIdx = findings.findIndex((f) => f.level === BLOCK);
    const firstUnknownIdx = findings.findIndex((f) => f.level === UNKNOWN);
    const firstBlock = firstBlockIdx === -1 ? null : findings[firstBlockIdx];
    const unknowns = findings.filter((f) => f.level === UNKNOWN);
    const unknownPrecedesBlock = firstUnknownIdx !== -1
      && (firstBlockIdx === -1 || firstUnknownIdx < firstBlockIdx);

    if (firstBlock && !unknownPrecedesBlock) {
      console.log(`  BLOCKED: ${firstBlock.label}`);
      if (firstBlock.detail) console.log(`  ${firstBlock.detail}`);
      const laterBlocks = findings.filter((f) => f.level === BLOCK && f !== firstBlock);
      if (laterBlocks.length) {
        console.log(`  (${laterBlocks.length} further blocker(s) downstream — fix this one first, then re-run.)`);
      }
      if (unknowns.length) {
        console.log(`  (${unknowns.length} condition(s) unverified, all AFTER this blocker — see above.)`);
      }
      process.exitCode = 1;
    } else if (firstBlock && unknownPrecedesBlock) {
      console.log('  INCONCLUSIVE — a blocker was found, but an EARLIER condition could not be');
      console.log('  verified, so this may not be the cause: production checks the earlier one');
      console.log('  first and would never have reached this point if it failed.');
      console.log(`\n  earliest unverified: ${findings[firstUnknownIdx].label}`);
      if (findings[firstUnknownIdx].detail) console.log(`    ${findings[firstUnknownIdx].detail}`);
      console.log(`\n  first blocker found downstream: ${firstBlock.label}`);
      if (firstBlock.detail) console.log(`    ${firstBlock.detail}`);
      console.log('\n  Resolve the unverified condition above, then re-run for a definitive answer.');
      process.exitCode = 2;
    } else if (unknowns.length) {
      console.log('  INCONCLUSIVE — nothing blocked among the conditions this script could check,');
      console.log('  but the following could not be verified, so the lane is NOT cleared:');
      for (const u of unknowns) console.log(`    - ${u.label}`);
      process.exitCode = 2;
    } else {
      console.log('  Every lane condition was verified and passed, and no charge failure is recorded.');
      console.log('  Either the charge did happen, or a row changed after the completion');
      console.log('  (the lane reads state at completion time, not now).');
      console.log('  Cross-check the Stripe PaymentIntent for the invoice above.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
