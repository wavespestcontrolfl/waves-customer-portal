#!/usr/bin/env node
// READ-ONLY. This script never writes: there is no --execute, and every
// customer is read inside its own `SET TRANSACTION READ ONLY` transaction
// that is always rolled back, so Postgres itself refuses any write.
//
// Customer-level overdue reminders (dunning consolidation §9 step 1): before
// GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW / GATE_DUNNING_CUSTOMER_SCHEDULE turn
// on, print what the customer schedule WOULD do for every customer with 2+
// active per-invoice follow-up sequences:
//   - the member sequences and their current per-invoice next touches,
//   - the promotion seed (stage + date) the engine would start from,
//   - resolveDunnableSet's verdict (multi / single / empty / hold, count,
//     total, anchor, exclusions),
//   - the per-invoice touches the schedule would absorb (they stop firing
//     while a schedule owns the customer),
//   - the customers that would be HELD (paused / autopay-held members,
//     payer or credit conditions, an incomplete read).
// It applies no account credit, mints no short link, reserves nothing and
// sends nothing (resolveDunnableSet is a pure read and the engine never applies credit;
// a customer holding unused credit is reported as HELD for the office).
//
// Prints invoice / sequence / customer ids only — never a customer name.
//
// Usage (repo root). `railway run --service Postgres` carries neither the web
// service's gates nor STRIPE_SECRET_KEY / NODE_ENV, and the resolver depends on
// all of them: feature-gates.js reads autoApplyAccountCredit and
// divertMicrodepositDunning as `isProd ? env === 'true' : true` (so off-prod
// they read true whatever the env says), and without Stripe the microdeposit
// check throws (every PaymentIntent-stamped customer holds) and PaymentIntent
// retrieval returns null (PI-stamped siblings read as live, so the set
// under-combines). Export NODE_ENV=production and STRIPE_SECRET_KEY (read both
// from the WEB service's Railway variables) alongside the gates:
//   NODE_ENV=production STRIPE_SECRET_KEY=<web service value> \
//   GATE_DUNNING_LADDER_90=true GATE_PAY_INCLUDE_BALANCE=true \
//   GATE_AUTO_APPLY_ACCOUNT_CREDIT=<web value> GATE_MICRODEPOSIT_DUNNING_DIVERSION=<web value> \
//   railway run --service Postgres -- node server/scripts/dunning-customer-schedule-dry-run.js
// The script REFUSES to run (exit 1) when STRIPE_SECRET_KEY is missing or
// NODE_ENV is not production. --allow-degraded overrides that for a rough
// look; the results are then over-held / under-combined and say so loudly.

const path = require('path');

const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as
// dunning-adopt-orphans-dry-run.js).
function prepareDatabaseEnv() {
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
    console.error('[dunning-customer-schedule] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node server/scripts/dunning-customer-schedule-dry-run.js');
    process.exit(1);
  }
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
  // The app's knex reads DATABASE_URL; railway run injects the internal host,
  // unreachable from a local machine — prefer the public proxy, with TLS.
  if (process.env.DATABASE_PUBLIC_URL) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
    if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  }
}

// The run only mirrors production with Stripe reachable and NODE_ENV=production
// (see the usage note). Returns the problems found; empty = faithful.
function fidelityProblems(env = process.env) {
  const problems = [];
  if (!String(env.STRIPE_SECRET_KEY || '').trim()) {
    problems.push('STRIPE_SECRET_KEY is not set (microdeposit checks would throw so every PaymentIntent-stamped customer holds as balance_incomplete, and PaymentIntent retrieval returns null so PI-stamped siblings read as live)');
  }
  if (env.NODE_ENV !== 'production') {
    problems.push(`NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'}, not "production" (feature-gates.js resolves GATE_AUTO_APPLY_ACCOUNT_CREDIT and GATE_MICRODEPOSIT_DUNNING_DIVERSION to true off-prod whatever the env says)`);
  }
  return problems;
}

// The gate values the resolver and cadence ACTUALLY use, not raw env: the
// feature-gates readers (evaluated with NODE_ENV as loaded) and the live
// cadence's step count.
function resolvedGates({ featureGates, followups }) {
  return {
    dunningLadder90: followups.followupSteps().length > 4,
    payIncludeBalance: featureGates.isEnabled('payIncludeBalance') === true,
    autoApplyAccountCredit: featureGates.gates.autoApplyAccountCredit === true,
    divertMicrodepositDunning: featureGates.gates.divertMicrodepositDunning === true,
  };
}

// invoices.status values that end a follow-up (invoice-followups.js
// TERMINAL_INVOICE_STATUSES).
const TERMINAL_INVOICE_STATUSES = ['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'];

// Customers with 2+ active sequences on a live, homeowner-billed, not-withdrawn
// invoice — the promotion candidate query (plan §4).
async function findCandidateCustomerIds(database) {
  const rows = await database('invoice_followup_sequences as s')
    .join('invoices as i', 'i.id', 's.invoice_id')
    .where('s.status', 'active')
    .whereNotIn('i.status', TERMINAL_INVOICE_STATUSES)
    .whereNull('i.payer_id')
    .where(function withdrawnExcluded() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    .groupBy('s.customer_id')
    .havingRaw('count(*) >= 2')
    .orderBy('s.customer_id')
    .select('s.customer_id');
  return rows.map((r) => String(r.customer_id));
}

// The customer's active sequences in the runPending row shape (sequenceAnchor
// reads the invoice_* aliases).
function activeSequenceRows(database, customerId) {
  return database('invoice_followup_sequences as s')
    .join('invoices as i', 'i.id', 's.invoice_id')
    .where({ 's.customer_id': customerId, 's.status': 'active' })
    .orderBy([{ column: 'i.created_at', order: 'asc' }, { column: 'i.id', order: 'asc' }])
    .select(
      's.*',
      'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at',
      'i.created_at as invoice_created_at',
    );
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * One customer's report. `deps` is injectable for tests; production passes the
 * real resolver and seed. `database` must be a read-only handle.
 */
async function buildCustomerReport(customerId, { database, now, resolve, seed, seedRefusal, stepIdAt }) {
  const set = await resolve(customerId, { database, now });
  const rows = await activeSequenceRows(database, customerId);
  const activeIds = new Set(set.members.filter((m) => m.seqStatus === 'active').map((m) => m.invoice_id));
  const memberRows = rows.filter((r) => activeIds.has(String(r.invoice_id)));
  const setPromotable = set.kind === 'multi' && set.activeCount >= 2;
  // A promotable set can still be refused by the seed: past even the final
  // step the per-invoice ladder stale-completes and adoption leaves it for a
  // person, so the engine must not promote it into a final notice.
  const seedResult = setPromotable ? seed(memberRows, now) : null;
  const wouldPromote = setPromotable && !!seedResult;
  const notPromotedReason = setPromotable && !seedResult ? ((seedRefusal && seedRefusal(memberRows, now)) || 'past_final_step') : null;
  return {
    customer_id: customerId,
    kind: set.kind,
    reason: set.reason,
    would_promote: wouldPromote,
    would_hold: set.kind === 'hold',
    not_promoted_reason: notPromotedReason,
    anchor_invoice_id: set.anchor?.id || null,
    member_count: set.members.length,
    total_cents: set.totalCents,
    excluded: set.excluded,
    members: set.members.map((m) => ({
      invoice_id: m.invoice_id, seq_id: m.seq_id, seq_status: m.seqStatus, quiet: m.quiet, cents: m.cents,
    })),
    per_invoice_touches: rows.map((r) => ({
      invoice_id: String(r.invoice_id),
      seq_id: r.id,
      step_index: r.step_index,
      step_id: stepIdAt(r.step_index),
      next_touch_at: iso(r.next_touch_at),
      last_touch_at: iso(r.last_touch_at),
    })),
    seed: wouldPromote ? seedOut(seedResult) : null,
    absorbed: wouldPromote
      ? memberRows.map((r) => ({ invoice_id: String(r.invoice_id), step_id: stepIdAt(r.step_index), next_touch_at: iso(r.next_touch_at) }))
      : [],
  };
}

function seedOut(s) {
  if (!s) return null;
  return {
    step_index: s.step_index,
    step_id: s.step_id,
    next_touch_at: iso(s.next_touch_at),
    last_touch_at: iso(s.last_touch_at),
    touches_sent: s.touches_sent,
    oldest_invoice_id: s.oldest_invoice_id,
  };
}

function printReport(r) {
  const verdict = r.reason ? `${r.kind}:${r.reason}` : r.kind;
  console.log(`customer ${r.customer_id}  set=${verdict}  members=${r.member_count}  total=$${(r.total_cents / 100).toFixed(2)}  anchor=${r.anchor_invoice_id || '-'}  `
    + `excluded stopped=${r.excluded.stopped.length} md=${r.excluded.md.length}  ${r.would_promote ? 'WOULD PROMOTE' : (r.not_promoted_reason === 'past_final_step' ? 'not promoted: past final step' : 'not promoted')}${r.would_hold ? '  WOULD BE HELD' : ''}`);
  for (const m of r.members) {
    console.log(`  member invoice ${m.invoice_id}  seq ${m.seq_id || '-'}  ${m.seq_status}${m.quiet ? ' (quiet)' : ''}  $${(m.cents / 100).toFixed(2)}`);
  }
  for (const t of r.per_invoice_touches) {
    console.log(`  per-invoice touch invoice ${t.invoice_id}  next step ${t.step_id || '-'}  due ${t.next_touch_at || '-'}  last ${t.last_touch_at || '-'}`);
  }
  if (r.seed) {
    console.log(`  seed  step ${r.seed.step_id} (index ${r.seed.step_index})  next ${r.seed.next_touch_at}  last ${r.seed.last_touch_at || '-'}  touches_sent ${r.seed.touches_sent}  driven by invoice ${r.seed.oldest_invoice_id}`);
    for (const a of r.absorbed) console.log(`  absorbs invoice ${a.invoice_id}  step ${a.step_id || '-'}  was due ${a.next_touch_at || '-'}`);
  }
}

// One customer, one READ ONLY transaction, always rolled back.
async function inReadOnlyTransaction(db, fn) {
  const trx = await db.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    return await fn(trx);
  } finally {
    await trx.rollback();
  }
}

async function main() {
  const allowDegraded = process.argv.includes('--allow-degraded');
  const problems = fidelityProblems(process.env);
  if (problems.length && !allowDegraded) {
    console.error('[dunning-customer-schedule] REFUSING to run: this environment does not mirror production, so the report would be wrong:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Export NODE_ENV=production and STRIPE_SECRET_KEY (from the web service\'s Railway variables) alongside the gates; see the usage note at the top of this script. Pass --allow-degraded for a rough, over-held look.');
    process.exit(1);
  }
  prepareDatabaseEnv();
  if (problems.length) {
    console.warn('[dunning-customer-schedule] WARNING (--allow-degraded): results are DEGRADED and over-held / under-combined; do NOT use them to judge production:');
    for (const p of problems) console.warn(`  - ${p}`);
  }
  // Required only now: feature-gates.js reads NODE_ENV once, at load.
  const featureGates = require(path.join(__dirname, '..', 'config', 'feature-gates'));
  const db = require(path.join(__dirname, '..', 'models', 'db'));
  const Followups = require(path.join(__dirname, '..', 'services', 'invoice-followups'));
  const { resolveDunnableSet } = require(path.join(__dirname, '..', 'services', 'customer-dunning', 'balance-set'));
  const { promotionSeed, seedRefusal } = require(path.join(__dirname, '..', 'services', 'customer-dunning', 'seed'));
  try {
    const g = resolvedGates({ featureGates, followups: Followups });
    console.log(`[dunning-customer-schedule] resolved gates in this run: dunningLadder90=${g.dunningLadder90} payIncludeBalance=${g.payIncludeBalance} autoApplyAccountCredit=${g.autoApplyAccountCredit} divertMicrodepositDunning=${g.divertMicrodepositDunning} (NODE_ENV=${process.env.NODE_ENV || 'unset'})`);
    if (!g.dunningLadder90 || !g.payIncludeBalance) {
      console.warn('[dunning-customer-schedule] WARNING: a prerequisite gate is unset here — the cadence falls back to the legacy Day 30 steps and/or the resolver reports gate_off for every customer, so this run may not match production. '
        + 'Export the web service\'s values for the run, e.g. GATE_DUNNING_LADDER_90=true GATE_PAY_INCLUDE_BALANCE=true.');
    }
    const now = new Date();
    const steps = Followups.followupSteps();
    const stepIdAt = (i) => steps[Number(i)]?.id || null;
    const customerIds = await findCandidateCustomerIds(db);
    console.log(`[dunning-customer-schedule] DRY RUN (read-only) — ${customerIds.length} customer(s) with 2+ active follow-up sequences`);
    const tally = { promote: 0, pastFinal: 0, hold: 0, single: 0, empty: 0, multi: 0, failed: 0 };
    for (const customerId of customerIds) {
      try {
        const report = await inReadOnlyTransaction(db, (trx) => buildCustomerReport(customerId, {
          database: trx, now, resolve: resolveDunnableSet, seed: promotionSeed, seedRefusal, stepIdAt,
        }));
        printReport(report);
        tally[report.kind] += 1;
        if (report.would_promote) tally.promote += 1;
        if (report.not_promoted_reason === 'past_final_step') tally.pastFinal += 1;
      } catch (err) {
        tally.failed += 1;
        console.error(`customer ${customerId}  report failed: ${err.message}`);
      }
    }
    console.log(`[dunning-customer-schedule] summary: would promote ${tally.promote}; not promoted (past final step) ${tally.pastFinal}; multi ${tally.multi}, single ${tally.single}, empty ${tally.empty}, hold ${tally.hold}, failed ${tally.failed}`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[dunning-customer-schedule] failed:', e.message); process.exitCode = 1; });
}

module.exports = { fidelityProblems, resolvedGates, printReport, findCandidateCustomerIds, buildCustomerReport, inReadOnlyTransaction, activeSequenceRows };
