#!/usr/bin/env node
/**
 * Backfill — Invoice Follow-up Sequences
 *
 * One-time script to create sequence rows for invoices that existed before
 * the per-invoice follow-up system was deployed. For each eligible invoice:
 *
 *   - Skip if a sequence row already exists.
 *   - Skip if the invoice is paid / void / draft.
 *   - Skip if it is more than MAX_OVERDUE_DAYS past due (assumes collections).
 *   - For overdue invoices, advance step_index PAST any steps whose
 *     daysAfterDue has already elapsed — so the backfill only schedules
 *     future touches. This prevents blasting customers who were already
 *     nagged by the legacy late-payment-checker.
 *   - Honors autopay-hold exactly the same as scheduleForInvoice().
 *
 * Run:
 *   node server/scripts/backfill-invoice-followups.js            (dry run)
 *   node server/scripts/backfill-invoice-followups.js --execute  (write)
 */

const db = require('../models/db');
const config = require('../config/invoice-followups');

const MAX_OVERDUE_DAYS = 60; // anything older is in collections territory

// customerOnAutopay() is engine-internal; replicate the logic here so the
// backfill doesn't require requiring the full engine module (which would also
// be fine — this is just isolation to keep the script auditable).
async function customerOnAutopay(customer) {
  if (!customer) return false;
  if (customer.autopay_enabled === false) return false;
  if (customer.autopay_paused_until && new Date(customer.autopay_paused_until) > new Date()) return false;

  const hasPM = !!customer.autopay_payment_method_id || !!customer.stripe_default_payment_method_id;
  if (!hasPM) {
    try {
      const pm = await db('payment_methods')
        .where({ customer_id: customer.id })
        .andWhere(function () { this.where('is_default', true).orWhere('autopay_enabled', true); })
        .first();
      if (!pm) return false;
    } catch { return false; }
  }

  if (customer.ach_status && customer.ach_status !== 'active') {
    try {
      const card = await db('payment_methods')
        .where({ customer_id: customer.id, method_type: 'card' })
        .first();
      if (!card) return false;
    } catch { return false; }
  }
  return true;
}

function computeTouchAt(dueDate, stepIndex) {
  const step = config.steps[stepIndex];
  if (!step) return null;
  const d = new Date(dueDate);
  d.setDate(d.getDate() + step.daysAfterDue);
  d.setHours(config.sendWindow.hour, 0, 0, 0);
  return d;
}

/**
 * Pick the first step whose scheduled fire time is in the future.
 * If every step is in the past, return null (already past all touches).
 */
function pickStartStep(dueDate) {
  const now = new Date();
  for (let i = 0; i < config.steps.length; i++) {
    const at = computeTouchAt(dueDate, i);
    if (at && at > now) return { stepIndex: i, nextAt: at };
  }
  return null;
}

async function run({ execute }) {
  const mode = execute ? 'EXECUTE' : 'DRY-RUN';
  console.log(`\n[backfill] Mode: ${mode}`);
  console.log(`[backfill] MAX_OVERDUE_DAYS=${MAX_OVERDUE_DAYS}\n`);

  // Candidates: non-paid, non-void, non-draft invoices
  const candidates = await db('invoices')
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .select('id', 'invoice_number', 'customer_id', 'status', 'due_date', 'created_at', 'total');

  console.log(`[backfill] Found ${candidates.length} candidate invoices`);

  const now = Date.now();
  const stats = {
    total: candidates.length,
    existing: 0,
    tooOld: 0,
    pastAllSteps: 0,
    scheduledActive: 0,
    scheduledAutopayHold: 0,
    errors: 0,
  };

  for (const inv of candidates) {
    try {
      // Skip if sequence already exists
      const existing = await db('invoice_followup_sequences').where({ invoice_id: inv.id }).first();
      if (existing) { stats.existing++; continue; }

      const dueRef = inv.due_date || inv.created_at;
      const daysOverdue = Math.floor((now - new Date(dueRef).getTime()) / 86400000);

      if (daysOverdue > MAX_OVERDUE_DAYS) { stats.tooOld++; continue; }

      const start = pickStartStep(dueRef);
      if (!start) {
        stats.pastAllSteps++;
        if (execute) {
          // Record as completed so we don't reconsider; no touches will fire.
          await db('invoice_followup_sequences').insert({
            invoice_id: inv.id,
            customer_id: inv.customer_id,
            status: 'completed',
            step_index: config.steps.length,
            next_touch_at: null,
            touches_sent: 0,
            is_autopay_held: false,
          });
        }
        continue;
      }

      const customer = await db('customers').where({ id: inv.customer_id }).first();
      const onAutopay = await customerOnAutopay(customer);

      if (execute) {
        await db('invoice_followup_sequences').insert({
          invoice_id: inv.id,
          customer_id: inv.customer_id,
          status: onAutopay ? 'autopay_hold' : 'active',
          step_index: start.stepIndex,
          next_touch_at: onAutopay ? null : start.nextAt,
          touches_sent: 0,
          is_autopay_held: !!onAutopay,
        });
      }

      if (onAutopay) stats.scheduledAutopayHold++;
      else stats.scheduledActive++;

      console.log(`  ${execute ? '✓' : '·'} ${inv.invoice_number || inv.id}  ` +
        `overdue=${daysOverdue}d  startStep=${config.steps[start.stepIndex].id}  ` +
        `nextAt=${start.nextAt.toISOString()}  ${onAutopay ? '[autopay-hold]' : '[active]'}`);
    } catch (err) {
      stats.errors++;
      console.error(`  ✗ ${inv.invoice_number || inv.id}: ${err.message}`);
    }
  }

  console.log('\n[backfill] Summary:');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\n[backfill] ${execute ? 'Committed.' : 'Dry run complete — pass --execute to write.'}\n`);
}

const args = process.argv.slice(2);
const execute = args.includes('--execute');

run({ execute })
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[backfill] FATAL:', err);
    process.exit(1);
  });
