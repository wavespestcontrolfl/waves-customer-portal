// MUTATES (dry-run default; requires --execute --plan=FILE to write).
// Applies only a version-2 human-reviewed plan from link-unlinked-visit-invoices.
// One transaction, no invoice creation, balance changes, or communications.
// An error, lock timeout, eligibility change, or digest drift aborts the batch.
//
// REPAIR_DATABASE_URL must explicitly identify the intended database.
// node ops/agents/execute-visit-invoice-plan.js --plan=/tmp/link-plan.json
// node ops/agents/execute-visit-invoice-plan.js --execute --plan=/tmp/link-plan.json
const { isDeepStrictEqual } = require('util');
const { evaluate, readPlan, formatPairing } = require('./link-unlinked-visit-invoices');
const { acquireScheduledInvoiceMintLock, acquireScheduledMintLockChain } = require('../../server/services/scheduled-invoice-mint');

async function executePlan(database, reviewed) {
  if (!reviewed.length) throw new Error('Empty plan — nothing to execute');
  const invoiceIds = [...new Set(reviewed.map((p) => p.invoiceId))].sort();
  const visitIds = [...new Set(reviewed.map((p) => p.visitId))].sort();
  if (invoiceIds.length !== reviewed.length) throw new Error('Duplicate invoice in reviewed plan');
  return database.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    // All mint advisory locks first: evaluating A while holding its customer
    // row must never wait for B's mint writer, which may need that same row.
    for (const id of visitIds) await acquireScheduledInvoiceMintLock(trx, id);
    const owners = await trx('invoices').whereIn('id', invoiceIds).select('id', 'customer_id');
    if (owners.length !== invoiceIds.length) throw new Error('A reviewed invoice no longer exists — batch aborted');
    const customerIds = [...new Set(owners.map((r) => r.customer_id))].sort();
    // Invoice before customer agrees with credit settlement. Include terminal
    // and other-date siblings: refund failure and redating can make them live
    // candidates again without touching the reviewed invoice.
    const invoices = await trx('invoices').whereIn('customer_id', customerIds).orderBy('id').forUpdate().select('id', 'payer_id');
    // Customer merges lock customers before repointing invoices. Never wait
    // here with invoice locks held: NOWAIT makes the repair abort instead of
    // deadlocking that live merge (or an invoice insert holding FK key-share).
    const customers = await trx('customers').whereIn('id', customerIds).orderBy('id').forUpdate().noWait().select('id', 'payer_id');
    // Customer FOR UPDATE blocks new invoice/visit FKs. A row inserted between
    // the invoice lock statement and that customer lock is not held: detect
    // the changed set and abort instead of silently trusting its future state.
    const currentInvoices = await trx('invoices').whereIn('customer_id', customerIds).orderBy('id').select('id');
    if (!isDeepStrictEqual(currentInvoices.map((r) => r.id), invoices.map((r) => r.id))) {
      throw new Error('Customer invoice set changed while acquiring locks — batch aborted');
    }
    for (const id of visitIds) {
      await acquireScheduledMintLockChain(trx, { scheduledServiceId: id, visitColumns: ['id'] });
    }
    // All dates/statuses: a silent historical correction can move a sibling
    // onto the reviewed date. Keep these rows locked until the batch commits.
    const visits = await trx('scheduled_services').whereIn('customer_id', customerIds).orderBy('id').forUpdate().select('id', 'payer_id');
    // Existing callback flags and canonical completion attempts need row
    // locks too. The held visit FK prevents insertions/retargeting into this
    // set; these locks prevent existing records changing after evaluation.
    await trx('service_records').whereIn('scheduled_service_id', visitIds).orderBy('id').forUpdate().select('id');
    await trx('service_completion_attempts').whereIn('service_id', visitIds).orderBy('id').forUpdate().select('id');
    const payerIds = [...new Set([...customers, ...visits, ...invoices].map((r) => r.payer_id).filter((id) => id != null))].sort((a, b) => a - b);
    await trx('payers').whereIn('id', payerIds).orderBy('id').forUpdate().select('id');
    for (const p of reviewed) {
      const again = await evaluate(trx, p.invoiceId);
      if (!isDeepStrictEqual(again.pairing, p)) {
        throw new Error(`Invoice ${p.invoiceId}: reviewed pairing changed (${again.skip || 'reviewed fields differ'}) — batch aborted`);
      }
      // Values come only from the locked re-evaluation, including clearing a
      // stale technician name when the reviewed technician ID changes.
      const live = again.pairing;
      const updated = await trx('invoices').where({ id: live.invoiceId })
        .whereNull('scheduled_service_id').whereNull('service_record_id')
        .update({ scheduled_service_id: live.visitId, service_record_id: live.serviceRecordId,
          technician_id: live.technicianId, tech_name: live.techName, updated_at: trx.fn.now() });
      if (updated !== 1) throw new Error(`Invoice ${p.invoiceId}: update count changed — batch aborted`);
    }
    return reviewed.length;
  }, { isolationLevel: 'read committed' });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--execute' && !/^--plan=.+$/.test(a))) throw new Error('Accepts only --plan=FILE and --execute');
  const planArg = args.find((a) => a.startsWith('--plan='));
  if (!planArg) throw new Error('--plan=FILE is required');
  const reviewed = readPlan(planArg.slice(7));
  if (!args.includes('--execute')) {
    console.log(`DRY RUN — ${reviewed.length} saved pairing(s), not revalidated; no database connection or writes`);
    for (const p of reviewed) console.log(formatPairing(p));
    return;
  }
  if (!process.env.REPAIR_DATABASE_URL) throw new Error('REPAIR_DATABASE_URL is required');
  const knex = require('knex')({ client: 'pg', connection: process.env.REPAIR_DATABASE_URL, pool: { min: 0, max: 1 } });
  try { console.log(`Linked ${await executePlan(knex, reviewed)} invoice(s) from the reviewed plan.`); }
  finally { await knex.destroy(); }
}

if (require.main === module) void main().catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { executePlan };
