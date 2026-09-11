/**
 * Intelligence Bar — Customer Lifecycle Tools
 * server/services/intelligence-bar/customer-lifecycle-tools.js
 *
 * merge_customers: the confirmed customer-record write the bar previously
 * had no way to do — merging a duplicate into the real customer. A #1568
 * UI-confirm, preview→confirmed two-step tool (WRITE_TWO_STEP in
 * write-gates.js) — an unconfirmed call is mutation-free and returns the
 * rich preview the confirmation card is built from; only /confirm-action
 * can attach confirmed:true (see action-registry.js execute()).
 *
 * It reuses the existing merge engine (customer-dedupe.js executeMerge)
 * untouched — same transaction, same FK repoint, same journal, same revert
 * path as the admin duplicates-queue route
 * (routes/admin-customer-duplicates.js). The card's pins (both customer
 * versions and the disclosed effects fingerprint) are validated by the
 * executor UNDER its row locks, never in a caller-side preflight.
 *
 * archive_customer (retire a record outright) was split out of this module:
 * it ships separately on a shared archive service with the DELETE
 * /api/admin/customers/:id route and cancellation-eligibility as a blocker.
 */

const db = require('../../models/db');
const logger = require('../logger');

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

// The card's disclosed effect set as one stable string: per-table moving
// counts + the executor's money effects, key-sorted. The route pins the
// preview's fingerprint on the approved card; the confirmed path recomputes
// it UNDER executeMerge's row locks and refuses on any difference — a child
// row (invoice, visit, message) added or removed on the loser since the card
// was shown never rides silently into the merge (pre-push Codex P1: related-
// row effects were only sampled unlocked).
function effectsFingerprint(moving, financialEffects) {
  const sortKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ moving: sortKeys(moving), financial_effects: sortKeys(financialEffects) });
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
    effects_fingerprint: effectsFingerprint(moving, financial_effects),
    note_to_operator: `${loserName} will be archived (soft-deleted) and folded into ${winnerName}: every appointment, service record, invoice, estimate, message, and every other row listed above repoints onto ${winnerName} in one transaction. The merge is journaled and reviewable (and revertible) from the duplicates queue afterward. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitMergeCustomers(winnerId, loserId, actionContext, approvedVersions = null, approvedEffects = null) {
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
      // The APPROVED card's versions (route pin from the fingerprint-verified
      // preview) — the preflight sample above is only the fallback for a
      // direct call with no card, never a substitute for the approved pin.
      expectedVersions: approvedVersions || { winner: before.winner.version, loser: before.loser.version },
      // Related-row effects validated under the SAME locks: the approved
      // card's fingerprint (route pin) against a recount through the
      // executor's transaction. Without a pin (direct call, no card) the
      // effects are not asserted — the version check above still holds.
      underLock: approvedEffects ? async (trx, { winner, loser }) => {
        const lockedMoving = await fullMovingCounts(trx, loserId);
        const lockedEffects = await financialEffects(trx, winner, loser);
        if (effectsFingerprint(lockedMoving, lockedEffects) !== approvedEffects) {
          const e = new Error('The rows that would move changed after the card was shown — ask again for a fresh confirmation card.');
          e.previewChanged = true;
          throw e;
        }
      } : null,
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
  const approved = input._approved_versions && input._approved_versions.winner && input._approved_versions.loser
    ? { winner: String(input._approved_versions.winner), loser: String(input._approved_versions.loser) } : null;
  const approvedEffects = typeof input._approved_effects === 'string' && input._approved_effects ? input._approved_effects : null;
  return commitMergeCustomers(winnerId, loserId, actionContext, approved, approvedEffects);
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
];

async function executeCustomerLifecycleTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'merge_customers': return await mergeCustomers(input, actionContext);
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
  _test: { fullMovingCounts, customerName, effectsFingerprint },
};
