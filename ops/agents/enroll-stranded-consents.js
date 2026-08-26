// MUTATES (dry-run default; pass --execute to write)
//
// Backfill-enroll stranded enrollment-qualifying consents (owner ruling
// 2026-08-26, "enroll those 9"): the pay page shipped v8 consent copy on
// 2026-06-17 — the version whose text first authorizes recurring charges —
// but the enrollment wiring only landed ~2026-07-23. Customers who ticked
// the box in that window have an immutable payment_method_consents
// authorization artifact and were never enrolled in Auto Pay.
//
// This script finds that stranded cohort and enrolls each through the
// CANONICAL path — enrollConsentedMethod (autopay-enrollment.js) — never a
// raw flag flip. That path re-asserts everything under its own
// transaction: consent artifact semantics, expired-card refusal, incumbent
// method arbitration, idempotency, autopay_log audit, and (standalone
// mode) the gated enrollment-confirmation email. Crucially it is passed
// authorizedAt = the CONSENT row's created_at, so a customer who
// explicitly disabled Auto Pay at any point AFTER consenting is refused —
// a stale authorization never silently re-enrolls anyone.
//
// Cohort definition (all conditions):
//  - source = 'pay_page' AND consented inside the stranded window
//    (2026-06-17 copy ship → 2026-07-24, after the ~07-23 wiring landed) —
//    the query itself enforces the owner-approved historical cohort, not
//    just the JS taxonomy filter
//  - payment_method_consents row whose consent_text_version qualifies for
//    enrollment (v8+, judged by the runtime
//    consentVersionQualifiesForEnrollment — the only version taxonomy)
//  - source is enrollment-scoped (never 'estimate_card_hold' — the runtime
//    NON_ENROLLMENT_CONSENT_SOURCES set is the authority: hold-capture
//    consent authorizes one visit, not Auto Pay)
//  - the consented method still exists in payment_methods for the SAME
//    customer (matched by stripe_payment_method_id) and is NOT an expired
//    card (runtime isExpiredCardMethod; expired-card customers print as
//    SKIPPED for a manual nudge)
//  - customers.autopay_enabled IS NOT true (column default false — an
//    un-flipped flag is exactly the stranded state; explicit later
//    disables are re-checked by the enrollment path via authorizedAt)
//  - customer not soft-deleted (deleted_at IS NULL)
//
// Dry run (default): prints the cohort (ids + consent version/date/source
// only — no names, no emails) and the exact --execute command including
// the --expect count + --pin membership hash. --execute REQUIRES both:
// the run re-derives the cohort and refuses if the count OR the sorted
// consent-id membership changed — the owner's GO was for a specific,
// reviewed set, not for whatever the query returns later.
//
// No customer identifiers live in this file; results print to stdout.
//
// Run (repo root):
//   railway run --service Postgres node ops/agents/enroll-stranded-consents.js
//   railway run --service Postgres node ops/agents/enroll-stranded-consents.js --execute --expect=<N> --pin=<hash>

const path = require('path');
const crypto = require('crypto');

// Server modules and the pg client must both reach prod through the public
// proxy when run locally (the internal hostname is unreachable) — set the
// env BEFORE any server require so the shared knex pool is born pointing
// at the right place.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  process.env.PGSSLMODE = process.env.PGSSLMODE || 'no-verify';
}

const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const {
  consentVersionQualifiesForEnrollment,
  NON_ENROLLMENT_CONSENT_SOURCES,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'payment-method-consents'));
const { isExpiredCardMethod } = require(path.join(__dirname, '..', '..', 'server', 'services', 'autopay-eligibility'));

const EXECUTE = process.argv.includes('--execute');
const expectArg = process.argv.find((a) => a.startsWith('--expect='));
const EXPECT = expectArg ? Number(expectArg.slice('--expect='.length)) : null;
const pinArg = process.argv.find((a) => a.startsWith('--pin='));
const PIN = pinArg ? pinArg.slice('--pin='.length) : null;

// Content pin (pre-push P1): a bare count cannot prove the cohort is the
// reviewed one — one customer leaving and another entering keeps N stable
// while enrolling someone the owner never saw. The pin is a hash of the
// sorted consent ids, so ANY membership change refuses.
// The owner-approved cohort is the pay page's stranded WINDOW: v8 consent
// copy shipped 2026-06-17; the enrollment wiring landed 2026-07-23 (after
// which /consent + /setup-complete enroll live and nothing new strands).
// Bounds are half-open UTC instants; source is pay_page only (pre-push r3
// P1 — the JS taxonomy filter alone admitted every later source).
const WINDOW_START_UTC = '2026-06-17T00:00:00Z';
const WINDOW_END_UTC = '2026-07-24T00:00:00Z';

function cohortPin(cohort) {
  const ids = cohort.map((r) => String(r.consent_id)).sort().join(',');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 12);
}

async function deriveCohort(client) {
  const { rows } = await client.query(
    `SELECT c.id AS consent_id, c.customer_id, c.payment_method_id,
            c.stripe_payment_method_id, c.source, c.consent_text_version,
            c.created_at AT TIME ZONE 'UTC' AS consented_at,
            pm.id AS pm_row_id, pm.method_type, pm.exp_month, pm.exp_year
     FROM payment_method_consents c
     JOIN customers cu ON cu.id = c.customer_id
     JOIN payment_methods pm
       ON pm.customer_id = c.customer_id
      AND pm.stripe_payment_method_id = c.stripe_payment_method_id
     WHERE cu.autopay_enabled IS DISTINCT FROM true
       AND cu.deleted_at IS NULL
       AND c.source = 'pay_page'
       AND c.created_at >= ($1::timestamptz AT TIME ZONE 'UTC')
       AND c.created_at <  ($2::timestamptz AT TIME ZONE 'UTC')
     ORDER BY c.customer_id, c.created_at DESC`, [WINDOW_START_UTC, WINDOW_END_UTC]);
  // Version + source scoping through the RUNTIME taxonomy, then one row per
  // customer: the newest qualifying consent is the authorization of record.
  const perCustomer = new Map();
  const decided = new Set();
  for (const r of rows) {
    if (!consentVersionQualifiesForEnrollment(r.consent_text_version)) continue;
    if (NON_ENROLLMENT_CONSENT_SOURCES.has(r.source)) continue;
    // Rows arrive newest-first per customer, so the FIRST qualifying row
    // is the authorization of record — decided once, no fallback to an
    // older card (pre-push r4 P1: silently enrolling an older card when
    // the newest consented one is expired would make a card the customer
    // may have replaced the default for future charges).
    if (decided.has(r.customer_id)) continue;
    decided.add(r.customer_id);
    // Expired-card refusal at the TARGET (pre-push P1): enrollConsentedMethod
    // rejects an expired incumbent but not an expired target, so enrolling
    // one would enable Auto Pay on a card collection will refuse. Judged by
    // the runtime isExpiredCardMethod utility (ET calendar, missing expiry
    // = expired). The customer is skipped VISIBLY, never falls back.
    if (isExpiredCardMethod({ method_type: r.method_type, exp_month: r.exp_month, exp_year: r.exp_year })) {
      console.log(`SKIPPED (newest consented card is expired) customer=${r.customer_id} consent=${r.consent_id} — nudge for a fresh card instead`);
      continue;
    }
    perCustomer.set(r.customer_id, r);
  }
  return [...perCustomer.values()];
}

async function main() {
  const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!conn) throw new Error('DATABASE_PUBLIC_URL/DATABASE_URL not set — run via `railway run --service Postgres`');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let cohort;
  try {
    cohort = await deriveCohort(client);
  } finally {
    await client.end();
  }

  console.log(`stranded enrollment-qualifying consents (one per customer): ${cohort.length}`);
  for (const r of cohort) {
    console.log(JSON.stringify({
      customer_id: r.customer_id,
      consent_id: r.consent_id,
      version: r.consent_text_version,
      source: r.source,
      consented_at: r.consented_at,
      pm_row_id: r.pm_row_id,
    }));
  }

  if (!EXECUTE) {
    if (cohort.length) {
      console.log(`DRY RUN — no writes. To enroll exactly this cohort:`);
      console.log(`  railway run --service Postgres node ops/agents/enroll-stranded-consents.js --execute --expect=${cohort.length} --pin=${cohortPin(cohort)}`);
    } else {
      console.log('DRY RUN — cohort is empty; nothing to enroll.');
    }
    return;
  }

  if (!Number.isInteger(EXPECT) || EXPECT <= 0) throw new Error('--execute requires --expect=<N> (copy it from the dry run)');
  if (!PIN) throw new Error('--execute requires --pin=<hash> (copy it from the dry run)');
  if (cohort.length !== EXPECT) {
    throw new Error(`cohort is now ${cohort.length}, not the expected ${EXPECT} — refusing; re-run the dry run and review`);
  }
  if (cohortPin(cohort) !== PIN) {
    throw new Error('cohort MEMBERSHIP changed since the reviewed dry run (pin mismatch) — refusing; re-run the dry run and review');
  }

  const { enrollConsentedMethod } = require(path.join(__dirname, '..', '..', 'server', 'services', 'autopay-enrollment'));
  const dbHandle = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  let enrolled = 0;
  let refused = 0;
  for (const r of cohort) {
    // Savepoint mode (dbh = an explicit transaction) rather than
    // standalone: standalone fires the gated enrollment-confirmation email
    // as an UNAWAITED promise, and a short-lived script destroying the
    // pool right after the loop could abort those sends mid-read (pre-push
    // r4 P1). In savepoint mode the service defers the email to the
    // caller's post-commit, so this script AWAITS the same canonical
    // sender (card-enrollment-email, still gated by
    // GATE_CARD_ENROLLMENT_EMAILS) before moving on — every send settles
    // before the pool is destroyed. authorizedAt = the consent instant
    // hydrated AS UTC (the column is a naive timestamp storing UTC;
    // without AT TIME ZONE 'UTC' a local ET run would shift it 4h forward
    // and could miss an opt-out in that interval — pre-push r3 P0), so an
    // explicit disable recorded after it wins and refuses.
    let result;
    try {
      result = await dbHandle.transaction((trx) => enrollConsentedMethod({
        customerId: r.customer_id,
        paymentMethodId: r.pm_row_id,
        source: 'consent_backfill',
        details: { consent_id: r.consent_id, consent_version: r.consent_text_version, script: 'ops/agents/enroll-stranded-consents.js' },
        authorizedAt: r.consented_at,
        dbh: trx,
      }));
    } catch (err) {
      refused += 1;
      console.log(`REFUSED ${r.customer_id}: transaction failed (${err.message}) — left as-is for review`);
      continue;
    }
    if (result?.enrolled || result?.reason === 'already_enrolled') {
      enrolled += 1;
      console.log(`ENROLLED ${r.customer_id} (${result.reason || 'ok'})`);
      if (result?.sendEnrollmentConfirmation) {
        try {
          const { sendAutopayEnrollmentConfirmation } = require(path.join(__dirname, '..', '..', 'server', 'services', 'card-enrollment-email'));
          await sendAutopayEnrollmentConfirmation({ customerId: r.customer_id, paymentMethodRowId: result.methodId });
        } catch (e) {
          console.log(`  (enrollment-confirmation email failed for ${r.customer_id}: ${e.message} — enrollment stands)`);
        }
      }
    } else {
      refused += 1;
      console.log(`REFUSED ${r.customer_id}: ${result?.reason || 'unknown'} — left as-is for review`);
    }
  }
  console.log(`done: ${enrolled} enrolled, ${refused} refused`);
  await dbHandle.destroy().catch(() => {});
  if (refused > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
