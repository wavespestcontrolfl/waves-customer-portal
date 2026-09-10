/**
 * Intelligence Bar — Customer Lifecycle Tools
 * server/services/intelligence-bar/customer-lifecycle-tools.js
 *
 * Two confirmed customer-record writes the bar previously had no way to do:
 * merging a duplicate into the real customer, and archiving one outright.
 * Both are #1568 UI-confirm, preview→confirmed two-step tools (WRITE_TWO_STEP
 * in write-gates.js) — an unconfirmed call is mutation-free and returns the
 * rich preview the confirmation card is built from; only /confirm-action can
 * attach confirmed:true (see action-registry.js execute()).
 *
 * merge_customers reuses the existing merge engine (customer-dedupe.js
 * executeMerge) untouched — same transaction, same FK repoint, same journal,
 * same revert path as the admin duplicates-queue route
 * (routes/admin-customer-duplicates.js). archive_customer mirrors the three
 * steps of DELETE /api/admin/customers/:id (routes/admin-customers.js): stamp
 * deleted_at, relink newsletter subscribers, write a critical audit event —
 * all inside one transaction.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

// Tables whose rows move onto the winner in a merge — used only for the
// PREVIEW's disclosure of what's about to move (executeMerge itself
// discovers every customer_id FK at run time; this is a smaller, readable
// subset for the card, per the assignment's counting recipe).
const MOVING_TABLES = ['scheduled_services', 'service_records', 'invoices', 'estimates', 'sms_log'];

async function movingCounts(customerId) {
  const rows = await Promise.all(
    MOVING_TABLES.map((table) => db(table).where({ customer_id: customerId }).count({ n: '*' }).first()),
  );
  return Object.fromEntries(MOVING_TABLES.map((table, i) => [table, Number(rows[i]?.n || 0)]));
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

async function loadMergePair(winnerId, loserId) {
  const rows = await db('customers').whereIn('id', [winnerId, loserId])
    .select('id', 'first_name', 'last_name', 'phone', 'email', 'deleted_at');
  return {
    winner: rows.find((r) => String(r.id) === String(winnerId)) || null,
    loser: rows.find((r) => String(r.id) === String(loserId)) || null,
  };
}

// ─── merge_customers ────────────────────────────────────────────────────

async function previewMergeCustomers(winnerId, loserId) {
  const { winner, loser } = await loadMergePair(winnerId, loserId);
  if (!winner) return { error: 'winner_customer_id does not match a customer', code: 'record_unavailable' };
  if (!loser) return { error: 'loser_customer_id does not match a customer', code: 'record_unavailable' };
  if (winner.deleted_at) return { error: 'The winner customer is already archived — pick a live customer to merge into.', code: 'record_unavailable' };
  if (loser.deleted_at) return { error: 'The loser customer is already archived — there is nothing to merge.', code: 'record_unavailable' };

  const moving = await movingCounts(loserId);
  const winnerName = customerName(winner);
  const loserName = customerName(loser);
  return {
    preview: true,
    winner_customer_id: winner.id,
    winner_name: winnerName,
    winner_phone: winner.phone || null,
    winner_email: winner.email || null,
    loser_customer_id: loser.id,
    loser_name: loserName,
    loser_phone: loser.phone || null,
    loser_email: loser.email || null,
    moving,
    note_to_operator: `${loserName} will be archived (soft-deleted) and folded into ${winnerName}: every appointment, service record, invoice, estimate, and message listed above repoints onto ${winnerName} in one transaction. The merge is journaled and reviewable (and revertible) from the duplicates queue afterward. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitMergeCustomers(winnerId, loserId, actionContext) {
  const { executeMerge } = require('../customer-dedupe');
  try {
    const result = await executeMerge({
      winnerId,
      loserId,
      performedBy: `ib:${actionContext.technicianId || 'unknown'}`,
      performedById: actionContext.technicianId || null,
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar' },
    });
    logger.info(`[intelligence-bar] merge_customers committed loser=${loserId} -> winner=${winnerId} (journal ${result.journalId})`);
    return {
      success: true,
      winner_customer_id: winnerId,
      loser_customer_id: loserId,
      journal_id: result.journalId,
      repointed: result.repointed,
      backfills: result.backfills,
    };
  } catch (err) {
    // executeMerge's own refusals (Stripe/billing conflicts, a live
    // collection call, a deleted row) are plain domain errors — relay the
    // message; nothing committed (the whole executor runs in one txn). A
    // refusal naming a vanished/deleted row means the pair drifted since
    // the card was shown — ask for a fresh proposal instead of a bare retry.
    const drifted = /deleted|not found/i.test(err.message || '');
    return { error: err.message, ...(drifted ? { preview_changed: true } : {}) };
  }
}

async function mergeCustomers(input, actionContext = {}) {
  const winnerId = input.winner_customer_id;
  const loserId = input.loser_customer_id;
  if (!winnerId || !loserId) return { error: 'winner_customer_id and loser_customer_id are required' };
  if (String(winnerId) === String(loserId)) return { error: 'winner_customer_id and loser_customer_id must be two different customers' };

  const confirmed = input.confirmed === true || actionContext.confirmed === true;
  if (!confirmed) return previewMergeCustomers(winnerId, loserId);
  return commitMergeCustomers(winnerId, loserId, actionContext);
}

// ─── archive_customer ───────────────────────────────────────────────────

// Mirrors the canonical unpaid-invoice filter (dashboard-tools.js
// getOutstandingBalances): paid_at IS NULL, not draft/void, and the amount
// still due (after applied credit) is positive.
async function hasUnpaidInvoice(customerId, trx = db) {
  const row = await trx('invoices')
    .where({ customer_id: customerId })
    .whereNull('paid_at')
    .whereNotIn('status', ['draft', 'void'])
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .first('id');
  return !!row;
}

async function hasBlockingAppointment(customerId, trx = db) {
  const row = await trx('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', ['cancelled', 'completed', 'skipped'])
    .where('scheduled_date', '>=', etDateString())
    .first('id');
  return !!row;
}

async function archiveBlockers(customerId, trx = db) {
  const blockers = [];
  if (await hasBlockingAppointment(customerId, trx)) {
    blockers.push('has an upcoming scheduled visit that is not cancelled, completed, or skipped');
  }
  if (await hasUnpaidInvoice(customerId, trx)) {
    blockers.push('has an unpaid invoice');
  }
  return blockers;
}

async function previewArchiveCustomer(customer, reason) {
  const blockers = await archiveBlockers(customer.id);
  const name = customerName(customer);
  if (blockers.length) {
    // An unexecutable preview is a tool failure, not a card (same rule
    // cancel_plan's nothing_to_cancel follows): a card for a blocked
    // archive would deterministically fail on Confirm.
    return { error: `${name} cannot be archived yet — ${blockers.join('; ')}. Resolve that first, or use merge_customers if this is a duplicate of a live customer.`, code: 'archive_blocked', blockers };
  }
  return {
    preview: true,
    customer_id: customer.id,
    customer_name: name,
    customer_phone: customer.phone || null,
    customer_email: customer.email || null,
    reason: reason || null,
    note_to_operator: `${name} will be archived (deleted_at stamped). Any newsletter subscribers linked to this customer are relinked to a live same-email twin, if one exists, in the same commit. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitArchiveCustomer(customer, reason, actionContext) {
  const { relinkSubscribersFromArchivedCustomer } = require('../newsletter-subscribers');
  const { recordAuditEvent } = require('../audit-log');
  try {
    const relink = await db.transaction(async (trx) => {
      const locked = await trx('customers').where({ id: customer.id }).forUpdate().first('id', 'deleted_at');
      if (!locked) { const e = new Error('This customer no longer exists.'); e.previewChanged = true; throw e; }
      if (locked.deleted_at) { const e = new Error(`${customerName(customer)} was already archived since the card was shown.`); e.previewChanged = true; throw e; }
      const freshBlockers = await archiveBlockers(customer.id, trx);
      if (freshBlockers.length) {
        const e = new Error(`Cannot archive — ${freshBlockers.join('; ')} (this changed after the card was shown).`);
        e.previewChanged = true;
        throw e;
      }
      await trx('customers').where({ id: customer.id }).update({ deleted_at: new Date() });
      const result = await relinkSubscribersFromArchivedCustomer(trx, customer.id);
      await recordAuditEvent({
        actor_type: 'technician',
        actor_id: actionContext.technicianId || null,
        action: 'customer.archive',
        resource_type: 'customer',
        resource_id: customer.id,
        metadata: { previousDeletedAt: customer.deleted_at || null, newsletterRelinked: result.relinked, reason: reason || null, source: 'intelligence_bar' },
        critical: true,
        trx,
      });
      return result;
    });
    logger.info(`[intelligence-bar] archive_customer committed id=${customer.id}` + (relink.relinked ? ` (newsletter subscribers relinked: ${relink.relinked})` : ''));
    return { success: true, customer_id: customer.id, newsletter_relinked: relink.relinked };
  } catch (err) {
    return { error: err.message, ...(err.previewChanged ? { preview_changed: true } : {}) };
  }
}

async function archiveCustomer(input, actionContext = {}) {
  const customerId = input.customer_id;
  if (!customerId) return { error: 'customer_id is required' };
  const reason = input.reason ? String(input.reason).trim().slice(0, 500) : null;

  const customer = await db('customers').where({ id: customerId })
    .first('id', 'first_name', 'last_name', 'phone', 'email', 'deleted_at');
  if (!customer) return { error: 'customer_id does not match a customer', code: 'record_unavailable' };
  if (customer.deleted_at) return { error: `${customerName(customer)} is already archived.`, code: 'record_unavailable' };

  const confirmed = input.confirmed === true || actionContext.confirmed === true;
  if (!confirmed) return previewArchiveCustomer(customer, reason);
  return commitArchiveCustomer(customer, reason, actionContext);
}

// ─── TOOL DEFINITIONS ───────────────────────────────────────────────────

const CUSTOMER_LIFECYCLE_TOOLS = [
  {
    name: 'merge_customers',
    description: `Merge a duplicate customer record into the real one. Use this for a duplicate "Unknown" website/lead stub that shares a phone with an existing customer, or any other confirmed duplicate pair (check find_duplicates first when unsure which record should win). The loser is archived (soft-deleted) and every one of its appointments, service records, invoices, estimates, and messages is repointed onto the winner in one transaction; the merge is journaled and reviewable/revertible afterward from the duplicates queue.
Refuses when either id is missing, the two ids are the same, either customer is already archived, or the underlying merge engine finds a conflict it cannot resolve automatically (e.g. both customers carry their own Stripe profile, or different billing modes) — those must be reconciled first.
The first call returns a PREVIEW naming both customers (name, phone, email) and counts of what would move; nothing changes until the operator confirms from the card.`,
    input_schema: {
      type: 'object',
      properties: {
        winner_customer_id: { type: 'string', format: 'uuid', description: 'The customer record that survives the merge' },
        loser_customer_id: { type: 'string', format: 'uuid', description: 'The duplicate record that gets archived and folded into the winner' },
      },
      required: ['winner_customer_id', 'loser_customer_id'],
    },
  },
  {
    name: 'archive_customer',
    description: `Archive (soft-delete) a customer record — use to retire a stale duplicate stub, an account created in error, or a customer who should no longer appear as active. This does NOT move any data onto another record; use merge_customers instead when the customer is a duplicate of a real, active customer (e.g. an "Unknown" website stub that turned out to be an existing customer).
Refuses when the customer has an upcoming scheduled visit that is not cancelled, completed, or skipped, or an unpaid invoice — resolve those first.
The first call returns a PREVIEW naming the customer, or an error explaining what blocks the archive; nothing changes until the operator confirms from the card.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid' },
        reason: { type: 'string', description: 'Optional free-text reason recorded on the audit event' },
      },
      required: ['customer_id'],
    },
  },
];

async function executeCustomerLifecycleTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'merge_customers': return await mergeCustomers(input, actionContext);
      case 'archive_customer': return await archiveCustomer(input, actionContext);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = {
  CUSTOMER_LIFECYCLE_TOOLS,
  executeCustomerLifecycleTool,
  // exported for tests
  _test: { archiveBlockers, movingCounts, customerName },
};
