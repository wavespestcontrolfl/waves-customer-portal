#!/usr/bin/env node
// MUTATES (dry-run default; pass --execute to write)
//
// Orphan-invoice adoption sweep (dunning unification, PR 3): invoices sent
// outside the direct-send path (the only caller of scheduleForInvoice) never
// got an invoice_followup_sequences row, so the legacy late-payment-checker.js
// is still the only thing nagging them. Prod 2026-09-28: 6 open overdue
// invoices (4 customers) with no sequence row. This script is a read-only
// production count before GATE_DUNNING_ADOPT_ORPHANS turns on; --execute
// calls the real adoption (adoptOrphanInvoices in
// server/services/invoice-followups.js — the SAME selection and the SAME
// scheduleForInvoice path runPending() takes when the gate is live, so every
// one of its own guards applies).
//
// Prints invoice/customer ids only — never a customer name.
//
// Usage (repo root):
//   (export the web service's GATE_DUNNING_LADDER_90 / GATE_LATE_PAYMENT_CHECKER_OFF first —
//   railway run --service Postgres does not carry them; the script warns when unset)
//   railway run --service Postgres -- node server/scripts/dunning-adopt-orphans-dry-run.js            # dry run
//   railway run --service Postgres -- node server/scripts/dunning-adopt-orphans-dry-run.js --execute

const path = require('path');

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as
// ops/agents/primary-property-backfill.js).
const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };
if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
  console.error('[dunning-adopt-orphans] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node server/scripts/dunning-adopt-orphans-dry-run.js');
  process.exit(1);
}
if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
// The app's knex reads DATABASE_URL; railway run injects the internal host,
// unreachable from a local machine — prefer the public proxy, with TLS.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}
const db = require(path.join(__dirname, '..', 'models', 'db'));
const { adoptOrphanInvoices } = require(path.join(__dirname, '..', 'services', 'invoice-followups'));

const execute = process.argv.includes('--execute');

(async () => {
  // Landing days (and past_final_step) follow GATE_DUNNING_LADDER_90 as read
  // from THIS process's env; `railway run --service Postgres` injects the
  // database's variables, not the web service's gates, so say which cadence
  // this count used and warn when it may not match production.
  const gate = (name) => process.env[name] === 'true';
  console.log(`[dunning-adopt-orphans] gates in this run: GATE_DUNNING_LADDER_90=${gate('GATE_DUNNING_LADDER_90')} GATE_LATE_PAYMENT_CHECKER_OFF=${gate('GATE_LATE_PAYMENT_CHECKER_OFF')}`);
  if (!gate('GATE_DUNNING_LADDER_90') || !gate('GATE_LATE_PAYMENT_CHECKER_OFF')) {
    console.warn('[dunning-adopt-orphans] WARNING: a gate is unset here — this count uses the legacy Day 30 cadence and may not match production. '
      + 'Export the web service\'s values for the run, e.g. GATE_DUNNING_LADDER_90=true GATE_LATE_PAYMENT_CHECKER_OFF=true railway run --service Postgres -- node …');
  }
  const { candidates, skipped = [] } = await adoptOrphanInvoices({ dryRun: true });
  console.log(`[dunning-adopt-orphans] ${execute ? 'EXECUTE' : 'DRY RUN'} — ${candidates.length} orphan invoice(s) with no follow-up sequence row, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped invoice ${s.invoice_id}  customer ${s.customer_id}  reason ${s.reason}`);
  if (skipped.length) {
    console.log('[dunning-adopt-orphans] settle these by hand (the sweep never adopts them): has_legacy_history = the retired checker already contacted it; '
      + 'past_final_step = every ladder day has passed; ach_failure_history = unresolved ACH failures in the last 90 days; *_unreadable = retried next run');
  }
  for (const c of candidates) {
    console.log(`  invoice ${c.invoice_id}  customer ${c.customer_id}  sent ${new Date(c.sent_at).toISOString().slice(0, 10)}  $${c.amount_due.toFixed(2)} due  ${c.days_since_sent}d since sent`);
  }
  if (!execute) {
    console.log('[dunning-adopt-orphans] dry run — pass --execute to adopt these invoices into the follow-up ladder');
    return;
  }
  const result = await adoptOrphanInvoices({ dryRun: false });
  if (result.refused) {
    console.error(`[dunning-adopt-orphans] refused (${result.refused}) — nothing adopted`);
    process.exitCode = 1;
    return;
  }
  console.log(`[dunning-adopt-orphans] adopted ${result.adopted} invoice(s)${result.invoiceIds.length ? `: ${result.invoiceIds.join(', ')}` : ''}; skipped ${(result.skipped || []).length}`);
})()
  .catch((e) => { console.error('[dunning-adopt-orphans] failed:', e.message); process.exitCode = 1; })
  .finally(() => db.destroy());
