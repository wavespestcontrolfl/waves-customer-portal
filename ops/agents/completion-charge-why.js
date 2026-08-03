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
 * Why this exists: three of the failure modes are silent (gate off, no lane
 * row, lane excluded) and two ring the office bell ("Auto Pay charge skipped —
 * no accepted amount on file" / "... above accepted amount — review"). Telling
 * them apart by hand means six joins across five tables, and the remedy is
 * different for each.
 *
 * CHECK ORDER MIRRORS PRODUCTION'S NESTING, not convenience. Auto Pay is an
 * OUTER condition on the charge block (admin-dispatch.js:8217-8220), so the cap
 * comparison and its office bell are only reachable once Auto Pay passes —
 * reporting an over-cap blocker to an operator whose Auto Pay was off would
 * send them to adjust an invoice that was never the problem.
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

  // Ordered findings. The first BLOCK is the verdict; any UNKNOWN prevents a
  // clean verdict even when nothing blocked.
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

    console.log('=== lane replay, in production nesting order (first BLOCK is the cause) ===');

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

    // 4. Invoices. `alreadyPaid` is set by a SEPARATE search for ANY paid
    //    invoice on the visit (admin-dispatch.js:7110-7115) — a newer open
    //    invoice does not clear it, so the whole result set has to be scanned
    //    before picking one to describe.
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
    const paidRow = invRows.find((r) => ['paid', 'prepaid'].includes(String(r.status).toLowerCase()));
    const openRow = invRows.find((r) => !['paid', 'prepaid', 'processing'].includes(String(r.status).toLowerCase()));
    for (const r of invRows) {
      const st = String(r.status);
      console.log(`         invoice ${r.id} status=${st} subtotal=${money(r.subtotal ?? r.total)} discount=${money(r.discount_amount)} payer_id=${r.payer_id || 'none'}`);
    }
    if (!invRows.length) {
      say(BLOCK, 'no non-void invoice for this visit', 'nothing to charge.');
    } else if (paidRow) {
      say(BLOCK, `a paid/prepaid invoice exists for this visit (${paidRow.id}, ${paidRow.status})`,
        'the route sets alreadyPaid from ANY paid invoice on the visit — a newer open invoice does NOT clear it, so the completion charge is suppressed. Remedy: reconcile the duplicate invoices before expecting an auto-charge.');
    } else {
      say(OK, 'no paid/prepaid invoice suppressing the lane');
    }

    // The invoice the cap would be compared against.
    const inv = openRow || invRows[0] || null;
    if (inv) {
      const subtotal = inv.subtotal != null ? Number(inv.subtotal) : Number(inv.total || 0);
      inv._net = Math.round((subtotal - Math.max(0, Number(inv.discount_amount) || 0)) * 100) / 100;
      if (inv.payer_id) {
        say(BLOCK, `invoice ${inv.id} has a payer_id`, 'third-party-billed invoices never auto-charge the homeowner.');
      }
    }

    // 5. LIVE payer at the charge boundary. A payer assigned after the invoice
    //    was pre-minted lives only on scheduled_services / customers — the
    //    reused invoice's payer_id stays null, and the route re-resolves it
    //    (admin-dispatch.js:8361-8377 via services/payer resolveForInvoice).
    //    Mirrored here: per-visit payer wins; self_pay_override blocks the
    //    account-default fallback; otherwise the customer's payer applies.
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
    if (livePayerId) {
      say(BLOCK, `live payer resolves to ${livePayerId}`,
        `the charge boundary re-resolves the payer and refuses to charge when one exists, even with invoices.payer_id null (source: ${v.visit_payer_id ? 'visit' : 'customer default'}). The payer flows own this bill.`);
    } else {
      say(OK, 'live payer resolution = self-pay');
    }

    // 6. AUTO PAY — an OUTER condition on the charge block, so it is evaluated
    //    BEFORE the cap. With Auto Pay off the route never reaches the cap
    //    comparison and never raises the above-amount bell.
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

    // 7. The lane row itself — appointment_card_requests, completed/satisfied.
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

      // 8. accepted_amount — the frozen cap. Only meaningful once Auto Pay has
      //    passed: production evaluates the cap INSIDE the Auto Pay-gated
      //    block, so an over-cap report while Auto Pay is down would send the
      //    operator to fix the wrong thing.
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

    // 9. A recorded charge FAILURE. Every predicate can pass and the charge
    //    still throw (processor decline, Stripe/config error, DB failure) —
    //    the route logs charge_failed with this visit id.
    let chargeFailure = null;
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
        chargeFailure = logRows.find((l) => String(l.event_type).includes('failed')) || null;
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
    }

    // 10. Office bells — the free discriminator between "lane never engaged"
    //     (silent) and "cap blocked it" (bell).
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
      console.log('  none — the lane never reached the cap checks (gate off, no lane row, or lane excluded).');
    } else {
      for (const n of notifRows) console.log(`  ${n.created_at.toISOString()}  ${n.title}`);
    }

    // 11. What the customer actually received.
    console.log('\n=== completion SMS actually sent ===');
    if (!recRows.length) {
      console.log('  no service_records row.');
    } else {
      for (const r of recRows) {
        const n = parseNotes(r.structured_notes);
        console.log(`  record ${r.id}  template_version=${r.report_template_version || 'none'}  sms=${n.completionSmsType || 'none'} (${n.completionSmsStatus || 'n/a'})`);
      }
    }

    // Verdict. A BLOCK wins; otherwise any UNKNOWN makes the run inconclusive.
    console.log('\n=== verdict ===');
    const firstBlock = findings.find((f) => f.level === BLOCK);
    const unknowns = findings.filter((f) => f.level === UNKNOWN);
    if (firstBlock) {
      console.log(`  BLOCKED: ${firstBlock.label}`);
      if (firstBlock.detail) console.log(`  ${firstBlock.detail}`);
      const laterBlocks = findings.filter((f) => f.level === BLOCK && f !== firstBlock);
      if (laterBlocks.length) {
        console.log(`  (${laterBlocks.length} further blocker(s) downstream — fix this one first, then re-run.)`);
      }
      if (unknowns.length) {
        console.log(`  (${unknowns.length} condition(s) unverified — see above.)`);
      }
      process.exitCode = 1;
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
