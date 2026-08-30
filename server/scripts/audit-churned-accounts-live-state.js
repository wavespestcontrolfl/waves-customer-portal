#!/usr/bin/env node
/**
 * Read-only audit: churned accounts that still carry live plan state.
 *
 * Background (cancellation scope, 2026-08-29): the portal cancel path churns
 * the account and stops series/visits, but never clears WaveGuard tier,
 * monthly_rate, billing_mode or customer_plan_rates — and admin-side churns
 * are field edits that may miss any of these. This lists every churned or
 * inactive customer that still has one of:
 *   - a WaveGuard tier or positive monthly_rate on a monthly lane
 *   - a customer_plan_rates row
 *   - an ongoing recurring series
 *   - an upcoming cancellable visit
 *   - autopay still enabled (customer or payment method)
 *
 * Prints a summary and one line per account (id + which flags). Never
 * writes. Usage: node server/scripts/audit-churned-accounts-live-state.js
 * [--json]
 */

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

const JSON_OUT = process.argv.includes('--json');
const CANCELLABLE = ['pending', 'confirmed', 'scheduled', 'rescheduled'];

async function main() {
  const today = etDateString();
  const churned = await db('customers')
    .where(function () {
      this.where({ pipeline_stage: 'churned' }).orWhere({ active: false });
    })
    .select('id', 'pipeline_stage', 'active', 'waveguard_tier', 'monthly_rate', 'billing_mode', 'autopay_enabled', 'churned_at');
  const ids = churned.map((c) => c.id);
  if (!ids.length) {
    console.log('No churned/inactive customers.');
    return;
  }

  const hasPlanRates = await db.schema.hasTable('customer_plan_rates');
  const planRates = hasPlanRates
    ? await db('customer_plan_rates').whereIn('customer_id', ids).select('customer_id')
    : [];
  const ongoing = await db('scheduled_services')
    .whereIn('customer_id', ids)
    .where({ recurring_ongoing: true })
    .select('customer_id');
  const upcoming = await db('scheduled_services')
    .whereIn('customer_id', ids)
    .whereIn('status', CANCELLABLE)
    .where('scheduled_date', '>=', today)
    .select('customer_id');
  const autopayMethods = await db('payment_methods')
    .whereIn('customer_id', ids)
    .where({ autopay_enabled: true })
    .select('customer_id');

  const set = (rows) => new Set(rows.map((r) => String(r.customer_id)));
  const planRateSet = set(planRates);
  const ongoingSet = set(ongoing);
  const upcomingSet = set(upcoming);
  const autopaySet = set(autopayMethods);

  const findings = [];
  for (const c of churned) {
    const id = String(c.id);
    const flags = [];
    const monthlyLane = c.billing_mode == null || c.billing_mode === 'monthly_membership';
    if (c.waveguard_tier) flags.push(`tier=${c.waveguard_tier}`);
    if (monthlyLane && Number(c.monthly_rate) > 0) flags.push(`monthly_rate=${c.monthly_rate}`);
    if (c.billing_mode === 'monthly_membership') flags.push('billing_mode=monthly_membership');
    if (planRateSet.has(id)) flags.push('plan_rates_row');
    if (ongoingSet.has(id)) flags.push('recurring_ongoing');
    if (upcomingSet.has(id)) flags.push('upcoming_visit');
    if (c.autopay_enabled === true) flags.push('customer_autopay_on');
    if (autopaySet.has(id)) flags.push('method_autopay_on');
    if (flags.length) findings.push({ id, stage: c.pipeline_stage, active: c.active, churned_at: c.churned_at, flags });
  }

  const counts = {};
  for (const f of findings) for (const flag of f.flags) counts[flag.split('=')[0]] = (counts[flag.split('=')[0]] || 0) + 1;

  if (JSON_OUT) {
    console.log(JSON.stringify({ churned: churned.length, withLiveState: findings.length, counts, findings }, null, 2));
    return;
  }
  console.log(`Churned/inactive customers: ${churned.length}`);
  console.log(`With live plan state:      ${findings.length}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log('');
  for (const f of findings) {
    console.log(`${f.id}  ${String(f.stage || '').padEnd(16)} active=${f.active}  churned_at=${f.churned_at || '-'}  ${f.flags.join(' ')}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
