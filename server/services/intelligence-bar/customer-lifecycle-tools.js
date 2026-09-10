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

// The transferred columns executeMerge backfills between winner and loser
// (customer-dedupe.js ~1680-1810: stripe_customer_id/billing_mode/payer_id/
// autopay_enabled/is_primary_profile, the three service-contact slots, and
// their consent stamp) — disclosed both-sided, null-safe, in the preview so
// the confirmation card shows exactly what the merge would carry over.
const BILLING_CONTACT_COLUMNS = [
  'stripe_customer_id', 'billing_mode', 'payer_id', 'autopay_enabled', 'is_primary_profile',
  'service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact_role',
  'service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact2_role',
  'service_contact3_name', 'service_contact3_phone', 'service_contact3_email', 'service_contact3_role',
  'service_contacts_consent_at', 'service_contacts_consent_source', 'service_contacts_consent_text_version',
  // Money the executor moves or adopts: cached credit balance (added to the
  // winner), per-application fee (rides along with a loser-only billing mode).
  'per_application_fee', 'account_credits',
];

// The executor's special-case money effects, stated as amounts the card can
// show — not inferable from FK row counts: the loser's cached credit balance
// is added to the winner; a loser-only per-application billing mode (and its
// fee) is adopted when the winner has none; the loser's plan-rate rows are
// DELETED, not repointed (customer_plan_rates is excluded from the generic
// FK repoint — the ledger is rebuilt on the winner).
async function financialEffects(database, winner, loser) {
  const credits = Math.round(Number(loser.account_credits || 0) * 100) / 100;
  const adoptsBillingMode = !winner.billing_mode && !!loser.billing_mode;
  const adoptsFee = adoptsBillingMode && (winner.per_application_fee == null || winner.per_application_fee === '')
    && loser.per_application_fee != null && loser.per_application_fee !== '';
  let loserPlanRates = 0;
  try {
    const row = await database('customer_plan_rates').where({ customer_id: loser.id }).count({ n: '*' }).first();
    loserPlanRates = Number(row?.n || 0);
  } catch {
    loserPlanRates = 'unknown';
  }
  return {
    account_credits_moved_to_winner: credits,
    billing_mode_adopted_from_loser: adoptsBillingMode ? loser.billing_mode : null,
    per_application_fee_adopted_from_loser: adoptsFee ? Number(loser.per_application_fee) : null,
    loser_plan_rate_rows_deleted: loserPlanRates,
  };
}

function billingSnapshot(row) {
  const snapshot = {};
  for (const col of BILLING_CONTACT_COLUMNS) snapshot[col] = row[col] ?? null;
  return snapshot;
}

// Per-table row counts for the loser across EVERY table the merge engine
// itself repoints (customerFkColumns — never a hand-picked subset that could
// omit a table the executor actually moves). Best-effort: a table that fails
// to count is disclosed as 'unknown', never a thrown error — one bad table
// must not blank the whole preview.
async function fullMovingCounts(database, loserId) {
  const { customerFkColumns } = require('../customer-dedupe');
  let fkColumns;
  try {
    fkColumns = await customerFkColumns(database);
  } catch (err) {
    logger.warn(`[intelligence-bar] merge preview: customerFkColumns failed: ${err.message}`);
    return { total_rows: 0 };
  }
  const byTable = new Map();
  for (const { table_name: table, column_name: column } of fkColumns) {
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(column);
  }
  const moving = {};
  let total = 0;
  await Promise.all([...byTable].map(async ([table, columns]) => {
    try {
      let sum = 0;
      for (const column of columns) {
        // Sequential per-column, concurrent per-table: two FK columns on one
        // table are rare, but summing them concurrently would race on the
        // same accumulator — sequential here avoids that, tables still run
        // in parallel with each other.
        const row = await database(table).where(column, loserId).count({ n: '*' }).first();
        sum += Number(row?.n || 0);
      }
      if (sum > 0) { moving[table] = sum; total += sum; }
    } catch (err) {
      moving[table] = 'unknown';
      logger.warn(`[intelligence-bar] merge preview: count failed for table ${table}: ${err.message}`);
    }
  }));
  moving.total_rows = total;
  return moving;
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

async function loadMergePair(winnerId, loserId) {
  const rows = await db('customers').whereIn('id', [winnerId, loserId])
    .select('id', 'first_name', 'last_name', 'phone', 'email', 'deleted_at',
      ...BILLING_CONTACT_COLUMNS, db.raw('updated_at::text AS version'));
  return {
    winner: rows.find((r) => String(r.id) === String(winnerId)) || null,
    loser: rows.find((r) => String(r.id) === String(loserId)) || null,
  };
}

// ─── merge_customers ────────────────────────────────────────────────────

// Loads the pair and runs every non-mutating refusal check merge_customers
// shares between preview and confirm: existence, liveness, and the
// canonical duplicate-eligibility recheck (customer-dedupe.js
// duplicatePairEligibility — never re-derived here). address_conflict gets
// an IB-specific message: the Intelligence Bar has no link-as-property path
// (that stays admin-duplicates-queue only), so it points the operator there
// instead of offering a merge that would silently drop the loser's address.
async function loadMergeEligibility(winnerId, loserId) {
  const { winner, loser } = await loadMergePair(winnerId, loserId);
  if (!winner) return { ok: false, error: 'winner_customer_id does not match a customer', code: 'record_unavailable' };
  if (!loser) return { ok: false, error: 'loser_customer_id does not match a customer', code: 'record_unavailable' };
  if (winner.deleted_at) return { ok: false, error: 'The winner customer is already archived — pick a live customer to merge into.', code: 'record_unavailable' };
  if (loser.deleted_at) return { ok: false, error: 'The loser customer is already archived — there is nothing to merge.', code: 'record_unavailable' };
  const { duplicatePairEligibility } = require('../customer-dedupe');
  const eligibility = await duplicatePairEligibility(winnerId, loserId);
  if (!eligibility.eligible) {
    if (eligibility.code === 'address_conflict') {
      return {
        ok: false,
        code: 'address_conflict',
        error: `${customerName(loser)} has a different service address than ${customerName(winner)} — merge this pair from the admin duplicates queue using "Merge + keep address" instead (the Intelligence Bar does not support keeping a second address).`,
      };
    }
    return { ok: false, error: eligibility.reason, code: eligibility.code };
  }
  return { ok: true, winner, loser, eligibility };
}

async function previewMergeCustomers(winnerId, loserId) {
  const check = await loadMergeEligibility(winnerId, loserId);
  if (!check.ok) return { error: check.error, code: check.code };
  const { winner, loser, eligibility } = check;
  const moving = await fullMovingCounts(db, loserId);
  const financial_effects = await financialEffects(db, winner, loser);
  const winnerName = customerName(winner);
  const loserName = customerName(loser);
  return {
    preview: true,
    winner_customer_id: winner.id,
    winner_name: winnerName,
    winner_phone: winner.phone || null,
    winner_email: winner.email || null,
    winner_version: winner.version,
    loser_customer_id: loser.id,
    loser_name: loserName,
    loser_phone: loser.phone || null,
    loser_email: loser.email || null,
    loser_version: loser.version,
    pair: { tier: eligibility.candidate.tier, reasons: eligibility.candidate.reasons },
    billing_and_contacts: { winner: billingSnapshot(winner), loser: billingSnapshot(loser) },
    financial_effects,
    moving,
    note_to_operator: `${loserName} will be archived (soft-deleted) and folded into ${winnerName}: every appointment, service record, invoice, estimate, message, and every other row listed above repoints onto ${winnerName} in one transaction. The merge is journaled and reviewable (and revertible) from the duplicates queue afterward. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitMergeCustomers(winnerId, loserId, actionContext) {
  const { executeMerge } = require('../customer-dedupe');
  // Before executeMerge: re-read both customer versions and re-run
  // eligibility, then do it again immediately before the write. The
  // two-step route already re-runs the (unconfirmed) preview and refuses on
  // a fingerprint mismatch before reaching this function — this is a second,
  // narrower belt-and-suspenders check for the gap between that re-run and
  // this call actually executing the merge.
  const before = await loadMergeEligibility(winnerId, loserId);
  if (!before.ok) return { error: before.error, code: before.code, preview_changed: true };
  const recheck = await loadMergeEligibility(winnerId, loserId);
  if (!recheck.ok || recheck.winner.version !== before.winner.version || recheck.loser.version !== before.loser.version) {
    return { error: 'The pair changed after the card was shown — ask again for a fresh confirmation card.', preview_changed: true };
  }
  try {
    const result = await executeMerge({
      winnerId,
      loserId,
      performedBy: `ib:${actionContext.technicianId || 'unknown'}`,
      performedById: actionContext.technicianId || null,
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar' },
      // Validated by the executor UNDER its row locks — the preflights above
      // narrow the window, this closes it.
      expectedVersions: { winner: before.winner.version, loser: before.loser.version },
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
    const drifted = err.previewChanged === true || /deleted|not found/i.test(err.message || '');
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

async function resolveTwinNames(twins) {
  if (!twins.length) return [];
  const ids = [...new Set(twins.map((t) => t.twin_id))];
  const rows = await db('customers').whereIn('id', ids).select('id', 'first_name', 'last_name');
  const byId = new Map(rows.map((r) => [String(r.id), customerName(r)]));
  return twins.map((t) => ({ twin_id: t.twin_id, twin_name: byId.get(String(t.twin_id)) || 'Unnamed customer' }));
}

// Same twin ids (any order) and the same row count — the shape a card cares
// about; email_key never rides on the disclosed side, so it plays no part
// in the comparison.
function samePlan(a, b) {
  if (a.relinked_count !== b.relinked_count) return false;
  const idsA = new Set(a.twins.map((t) => t.twin_id));
  const idsB = new Set(b.twins.map((t) => t.twin_id));
  if (idsA.size !== idsB.size) return false;
  for (const id of idsA) if (!idsB.has(id)) return false;
  return true;
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
  const { planRelinkFromArchivedCustomer } = require('../newsletter-subscribers');
  const plan = await planRelinkFromArchivedCustomer(db, customer.id);
  const twins = await resolveTwinNames(plan.twins);
  return {
    preview: true,
    customer_id: customer.id,
    customer_name: name,
    customer_phone: customer.phone || null,
    customer_email: customer.email || null,
    reason: reason || null,
    newsletter_relink: { count: plan.relinked_count, twins },
    note_to_operator: `${name} will be archived (deleted_at stamped). Any newsletter subscribers linked to this customer are relinked to a live same-email twin, if one exists, in the same commit. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitArchiveCustomer(customer, reason, actionContext) {
  const { relinkSubscribersFromArchivedCustomer, planRelinkFromArchivedCustomer } = require('../newsletter-subscribers');
  const { recordAuditEvent } = require('../audit-log');
  try {
    // Fresh, unlocked plan at the START of the confirmed call — recomputed
    // again under the row lock below. The route already re-runs the
    // unconfirmed preview and refuses on a fingerprint mismatch before
    // reaching this function; this closes the narrower gap between that
    // re-run and the lock actually being held (a subscriber signs up, or a
    // twin gets archived, in between).
    const freshPlan = await planRelinkFromArchivedCustomer(db, customer.id);
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
      const lockedPlan = await planRelinkFromArchivedCustomer(trx, customer.id);
      if (!samePlan(freshPlan, lockedPlan)) {
        const e = new Error('The newsletter relink plan changed after the card was shown — ask again for a fresh confirmation card.');
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
  _test: { archiveBlockers, fullMovingCounts, customerName, samePlan },
};
