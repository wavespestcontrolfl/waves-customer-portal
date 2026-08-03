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
 * different for each — the sticky `accepted_amount = 0` sentinel in particular
 * is NOT fixed by flipping the charge gate.
 *
 * A CLEAN verdict is only ever printed when every condition was actually
 * verified. Anything this script cannot see from the DB (most importantly the
 * charge gate, which lives on the portal service) is reported as INCONCLUSIVE
 * and exits nonzero — a diagnostic that says "all conditions passed" when it
 * simply could not check one of them is worse than no diagnostic at all.
 *
 * Auto Pay eligibility is evaluated with the PRODUCTION helpers
 * (server/services/autopay-eligibility.js) rather than a re-implementation, so
 * the ET pause window and the card-expiry semantics cannot drift from the rail
 * the route actually runs.
 *
 * Reads only. Prints IDs, amounts and statuses — never names, phones, or card
 * details.
 *
 * Exit codes:  0 = every condition verified and passing
 *              1 = a blocking condition found (the verdict names it)
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
              c.billing_mode, c.autopay_enabled, c.autopay_paused_until, c.ach_status
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

    // The completion record carries the frozen outcome + backfill marker the
    // route branched on. Without it several guards are unverifiable.
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

    console.log('=== lane replay (first BLOCK is the cause) ===');

    // 1. Gate. Lives on the portal service; usually invisible from here, and
    //    an unknown gate must never yield a clean verdict.
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

    // 4. Invoice.
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
    if (!invRows.length) {
      say(BLOCK, 'no non-void invoice for this visit', 'nothing to charge.');
    }
    const inv = invRows[0] || null;
    if (inv) {
      const subtotal = inv.subtotal != null ? Number(inv.subtotal) : Number(inv.total || 0);
      const netSubtotal = Math.round((subtotal - Math.max(0, Number(inv.discount_amount) || 0)) * 100) / 100;
      console.log(`         invoice ${inv.id} status=${inv.status} subtotal=${money(subtotal)} discount=${money(inv.discount_amount)} net=${money(netSubtotal)} payer_id=${inv.payer_id || 'none'}`);
      if (['paid', 'prepaid', 'processing'].includes(String(inv.status).toLowerCase())) {
        say(INFO, `invoice is now ${inv.status}`,
          'it may have been settled AFTER the completion — this script reads current state, not the state the route saw.');
      }
      if (inv.payer_id) {
        say(BLOCK, 'invoice has a payer_id', 'third-party-billed invoices never auto-charge the homeowner.');
      }
      inv._net = netSubtotal;
    }

    // 5. The lane row itself — appointment_card_requests, completed/satisfied.
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

      // 6. Hold-rail exclusion.
      const { rows: holdRows } = await client.query(
        'SELECT id FROM estimate_card_holds WHERE scheduled_service_id = $1',
        [visitId],
      );
      if (holdRows.length) {
        say(BLOCK, `estimate_card_holds row ${holdRows[0].id} exists`,
          'the hold rail owns estimate-flow one-time bookings; the appointment-card lane stands down by design.');
      } else {
        say(OK, 'no estimate_card_holds row');
      }

      // 7. Consent must belong to the visit's CURRENT customer.
      if (String(lane.customer_id) !== String(v.customer_id)) {
        say(BLOCK, `lane customer ${lane.customer_id} != visit customer ${v.customer_id}`,
          'a reassigned visit never rides a prior customer consent into automatic collection.');
      } else {
        say(OK, 'lane customer matches visit customer');
      }

      // 8. accepted_amount — the frozen cap. 0 is a STICKY sentinel.
      const accepted = lane.accepted_amount == null ? null : Number(lane.accepted_amount);
      if (accepted == null) {
        say(BLOCK, 'accepted_amount IS NULL',
          'pre-migration row or unstamped render — the lane routes to office review. Expect the "no accepted amount on file" bell.');
      } else if (accepted === 0) {
        say(BLOCK, 'accepted_amount = 0 (STICKY sentinel)',
          'the /secure page never DISPLAYED a price, so nothing was stamped. Causes: GATE_SECURE_PLAN_CHOICE off, estimated_price null/0 at render, a commercial property, or a source_estimate_id visit. '
          + 'This row is now PERMANENTLY unchargeable — the stamp is CASE WHEN accepted_amount = 0 THEN 0, so flipping the charge gate alone changes nothing. '
          + 'Remedy: flip GATE_SECURE_PLAN_CHOICE first, confirm the visit has estimated_price > 0, then re-secure the card so a FRESH row stamps a real cap.');
      } else {
        say(OK, `accepted_amount = ${money(accepted)}`);
        // 9. Cap comparison.
        if (inv && inv._net > accepted + 0.005) {
          say(BLOCK, `invoice net ${money(inv._net)} exceeds cap ${money(accepted)}`,
            'over-cap invoices route to office review and keep the pay link. Expect the "above accepted amount" bell. Remedy: adjust the invoice to the accepted amount or collect manually.');
        } else if (inv) {
          say(OK, `invoice net ${money(inv._net)} within cap ${money(accepted)}`);
        }
      }
    }

    // 10. Auto Pay at the charge boundary — evaluated with the production
    //     helpers so the ET pause window and expiry rules match the rail.
    const { rows: pmRows } = await client.query(
      `SELECT id, processor, method_type, is_default, autopay_enabled,
              stripe_payment_method_id, exp_month, exp_year
         FROM payment_methods
        WHERE customer_id = $1 AND processor = 'stripe'
          AND is_default = true AND autopay_enabled = true`,
      [v.customer_id],
    );
    if (v.autopay_enabled === false) {
      say(BLOCK, 'customer.autopay_enabled = false', 'Auto Pay is off — the charge condition never runs.');
    }
    if (isPaused(v)) {
      say(BLOCK, `Auto Pay paused through ${String(v.autopay_paused_until).slice(0, 10)} (ET)`,
        'a pause covering today blocks the charge. NOTE: this compares against TODAY, not the completion date — re-check if the visit is older.');
    } else if (v.autopay_paused_until) {
      say(OK, `Auto Pay pause expired (${String(v.autopay_paused_until).slice(0, 10)})`);
    }
    if (!pmRows.length) {
      say(BLOCK, 'no default Stripe payment method with autopay_enabled',
        'nothing chargeable on file at the charge boundary.');
    } else {
      const pm = pmRows[0];
      if (!pm.stripe_payment_method_id) {
        say(BLOCK, `payment method ${pm.id} has no stripe_payment_method_id`, 'not chargeable.');
      } else if (isExpiredCardMethod(pm)) {
        say(BLOCK, `default card expired or malformed expiry (${pm.exp_month || '--'}/${pm.exp_year || '----'})`,
          'isExpiredCardMethod treats a malformed expiry as expired — the charge rail refuses it. NOTE: evaluated against TODAY, not the completion date.');
      } else {
        say(OK, `chargeable ${pm.method_type} method on file (exp ${pm.exp_month || '--'}/${pm.exp_year || '----'})`);
      }
      if (v.ach_status && v.ach_status !== 'active' && isBankMethodType(pm.method_type)) {
        say(BLOCK, `ach_status=${v.ach_status} with a bank default method`, 'the lane forces card-only when ACH is unhealthy.');
      }
    }

    // 11. Did the office get belled? This is the free discriminator between
    //     "lane never engaged" (silent) and "cap blocked it" (bell).
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

    // 12. What the customer actually received.
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
      if (unknowns.length) {
        console.log(`  (${unknowns.length} further condition(s) unverified — the block above is the first one found, not necessarily the only one.)`);
      }
      process.exitCode = 1;
    } else if (unknowns.length) {
      console.log('  INCONCLUSIVE — nothing blocked among the conditions this script could check,');
      console.log('  but the following could not be verified, so the lane is NOT cleared:');
      for (const u of unknowns) console.log(`    - ${u.label}`);
      process.exitCode = 2;
    } else {
      console.log('  Every lane condition was verified and passed on the CURRENT row state.');
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
