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
 * versions and the engine's effect fingerprint, describeMergeEffects) are
 * validated by the executor UNDER its row locks, never in a caller-side
 * preflight; the final duplicate-queue eligibility decision runs there too.
 *
 * archive_customer (retire a record outright) was split out of this module:
 * it ships separately on a shared archive service with the DELETE
 * /api/admin/customers/:id route and cancellation-eligibility as a blocker.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');

// Default-off capability gate (codex #4348 r14 P1): merge_customers is an
// irreversible admin write and must not go live in every admin context the
// moment the code deploys. Call-time read (a flip needs no redeploy);
// registered in config/feature-gates.js (`ibMergeCustomers`). Enforced in
// THREE places so no path offers what another refuses: the legacy tool
// list (routes/admin-intelligence-bar.js getToolsForContext), the platform
// action registry (action-registry.js allowed), and the executor below —
// so a forced /execute or /confirm-action call fails closed too.
function mergeCustomersEnabled() {
  return gateEnvValue('GATE_IB_MERGE_CUSTOMERS');
}

// The transferred columns executeMerge backfills between winner and loser
// (customer-dedupe.js predictWinnerBackfills: stripe_customer_id/billing_mode/
// payer_id/autopay_enabled/is_primary_profile, the three service-contact
// slots and their consent stamp, the money and restriction inputs) —
// disclosed both-sided, null-safe, in the preview so the confirmation card
// shows the inputs beside the engine's own predicted outcome.
const BILLING_CONTACT_COLUMNS = [
  'stripe_customer_id', 'billing_mode', 'payer_id', 'autopay_enabled', 'is_primary_profile',
  'service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact_role',
  'service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact2_role',
  'service_contact3_name', 'service_contact3_phone', 'service_contact3_email', 'service_contact3_role',
  'service_contacts_consent_at', 'service_contacts_consent_source', 'service_contacts_consent_text_version',
  'per_application_fee', 'account_credits',
  'autopay_paused_until', 'autopay_pause_reason', 'auto_apply_account_credit',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
  // The account state the merge never copies (codex #4348 r14 P1) — shown
  // both-sided so the operator sees what the archived record carried.
  'monthly_rate', 'waveguard_tier', 'pipeline_stage',
];

function billingSnapshot(row) {
  const snapshot = {};
  for (const col of BILLING_CONTACT_COLUMNS) snapshot[col] = row[col] ?? null;
  // Never the hash itself — only whether a portal login exists.
  snapshot.has_portal_login = !!row.password_hash;
  return snapshot;
}

const money = (n) => (n == null ? 'none' : `$${Number(n).toFixed(2)}`);

function discardedStateNote(discarded) {
  if (!discarded) return '';
  const parts = [];
  if (discarded.monthly_rate) {
    parts.push(`the monthly rate ${money(discarded.monthly_rate.loser)} (the surviving record's rate is ${money(discarded.monthly_rate.winner)} — every moved visit bills at the survivor's rate from now on)`);
  }
  if (discarded.membership_tier) {
    parts.push(`the membership tier ${discarded.membership_tier.loser} (survivor: ${discarded.membership_tier.winner || 'none'})`);
  }
  if (discarded.pipeline_stage) {
    parts.push(`the ${discarded.pipeline_stage.loser} pipeline stage (survivor: ${discarded.pipeline_stage.winner || 'none'})`);
  }
  if (discarded.portal_login) {
    parts.push(discarded.portal_login.winner
      ? 'its portal login (the survivor keeps its own)'
      : 'its portal login (the survivor has none — the customer must be re-invited)');
  }
  return ` DISCARDED with the archived record — the merge never copies these onto the survivor: ${parts.join('; ')}.`;
}

function collisionFoldsNote(folds) {
  if (!folds || !Object.keys(folds).length) return '';
  const parts = Object.entries(folds).map(([table, detail]) => {
    if (table === 'customer_tags') return `tags shared by both records (${detail.shared.join(', ')}) are dropped from the archived side`;
    if (table === 'conversations') return `${detail.shared_threads.length} conversation thread(s) both records hold on the same channel (${detail.shared_threads.join(', ')}) merge into the survivor's thread`;
    return `${table}: ${detail}`;
  });
  return ` Folds the undo cannot split apart: ${parts.join('; ')}.`;
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

async function loadMergePair(winnerId, loserId) {
  // Whole rows: the engine's effect reader and backfill rule read every
  // column the executor's own locked select(*) sees.
  const rows = await db('customers').whereIn('id', [winnerId, loserId])
    .select('*', db.raw('updated_at::text AS version'));
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
    // Refusals never carry names: the route runs this preview BEFORE
    // validateRecordTarget, so a failure on a foreign pair must read the
    // same as any other refusal (Codex r3 P1).
    if (eligibility.code === 'address_conflict') {
      return {
        ok: false,
        code: 'address_conflict',
        error: 'The two records have different service addresses — merge this pair from the admin duplicates queue using "Merge + keep address" instead (the Intelligence Bar does not support keeping a second address).',
      };
    }
    return { ok: false, error: eligibility.reason, code: eligibility.code };
  }
  return { ok: true, winner, loser, eligibility };
}

// The payment-session sentence states each PaymentIntent's OWN outcome as
// the engine decided it (pay-combined stampedSessionOutcome) — never a
// blanket "will be cancelled" over a list that can include a single-invoice
// checkout the release leaves alone (codex #4348 r5 P1).
function paymentSessionsNote(sessions) {
  const all = [...(sessions?.winner || []), ...(sessions?.loser || [])];
  if (!all.length) return '';
  // Counted by PaymentIntent, not by row: one combined intent is stamped
  // onto EVERY invoice in its allocation, and the release deduplicates by
  // payment_intent_id and cancels once — so counting rows told the operator
  // three sessions would be cancelled when one would (codex #4348 r10 P2).
  // The rows themselves stay listed above, per invoice, as before.
  const seen = new Set();
  const byIntent = all.filter((s) => {
    const id = String(s.payment_intent_id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const count = (outcome) => byIntent.filter((s) => s.outcome === outcome).length;
  const parts = [];
  const cancel = count('cancel');
  if (cancel) parts.push(`${cancel} unconfirmed combined payment session(s) will be cancelled in Stripe first`);
  // A single-invoice checkout this merge invalidates is cancelled too, but
  // for a different reason — say which, because the operator is losing a
  // live payment link a customer may be holding.
  const cancelSingle = count('cancel_single_invoice');
  if (cancelSingle) parts.push(`${cancelSingle} single-invoice checkout session(s) will be cancelled in Stripe because this merge invalidates them (the archived record's own checkout, or a payer change)`);
  // Already cancelled in Stripe: the merge only finishes the stamp cleanup.
  // Counting these as cancellations promised a Stripe write that never
  // happens (codex #4348 r7 P2).
  const cleared = count('stamps_cleared');
  if (cleared) parts.push(`${cleared} already-cancelled session(s) only have their invoice stamps cleared — nothing is cancelled in Stripe for these`);
  const inFlight = count('in_flight');
  if (inFlight) parts.push(`${inFlight} payment session(s) have money in flight (a merged-away one defers the merge until it settles)`);
  const kept = count('kept_single_invoice');
  if (kept) parts.push(`${kept} single-invoice checkout session(s) stay open and are NOT cancelled`);
  return ` Payment sessions listed above (counted per payment session, not per invoice): ${parts.join('; ')}.`;
}

// The collection-case sentence states the reconcile the executor will run
// (customer-dedupe previewCollectionCaseReconciliation, pinned by state and
// version) so an approval the merge revokes is on the card, not a surprise.
function collectionCasesNote(cases) {
  if (!cases || cases.available === false || !cases.live?.length) return '';
  if (cases.defers_on_dialing) return ' A collection call is in flight for one of these customers: the merge defers until it completes.';
  if (!cases.demoted_to_proposed.length) return ` ${cases.live.length} live collection case(s) move to the surviving record unchanged.`;
  return ` Collection cases: ${cases.demoted_to_proposed.length} approved case(s) (${cases.demoted_to_proposed.join(', ')}) revert to proposed so the surviving record keeps one live approval; re-approve from the collections queue if still wanted.`;
}

// The loser's saved cards the merge strips of default/autopay because the
// winner already has a default card (customer-dedupe
// predictSavedCardDemotions — the executor's own set, pinned by the
// fingerprint): named on the card so a disabled autopay card is never a
// surprise.
function savedCardDemotionsNote(demotions) {
  if (!demotions?.winner_has_default || !demotions.cards?.length) return '';
  const flags = (c) => [c.is_default ? 'default' : null, c.autopay_enabled ? 'autopay' : null].filter(Boolean).join('+');
  const listed = demotions.cards.map((c) => `${c.id} (${flags(c)})`).join(', ');
  return ` Saved cards: ${demotions.cards.length} card(s) moving from the archived record lose default/autopay because the surviving record already has a default card — ${listed}; the survivor's own default card stays the one autopay card.`;
}

// The loser's CRM / technician notes are APPENDED onto the winner
// (customer-dedupe predictNoteAppends — the executor's own rule, pinned by
// the fingerprint). technician_notes drives technician-facing instructions,
// so the card names the fields rather than letting the change ride in
// silently (codex #4348 r7 P2).
function noteAppendsNote(appends) {
  const fields = Object.keys(appends || {});
  if (!fields.length) return '';
  const LABELS = { crm_notes: 'CRM notes', technician_notes: 'technician notes (technician-facing instructions)' };
  return ` Notes: the archived record's ${fields.map((f) => LABELS[f] || f).join(' and ')} are appended to the surviving record's — the surviving text is kept and the merged text is added below it.`;
}

// Mutations the row sweep cannot see because the customer id is embedded in
// jsonb or a trigger-id string (customer-dedupe nonFkMergeRewrites): the
// operator is told about them in words, since "rows listed above repoint"
// does not describe an address stamp or a rewritten delivery identity.
const NON_FK_REWRITE_LABELS = {
  'scheduled_services.service_address_stamp': (n) => `${n} unaddressed visit(s) on the archived record are stamped with its own address first, so the schedule board cannot send a tech to the wrong house`,
  'call_log.customer_link_override': (n) => `${n} call(s) an operator linked by hand are re-linked to the surviving record`,
  'email_messages.trigger_event_id': (n) => `${n} weekly watering-plan delivery record(s) are re-keyed to the surviving record so next week's plan is not sent twice`,
  'property_preferences.irrigation_home_changed_at': () => 'the two records are different homes, so the surviving sprinkler settings are marked moved and the weekly plan withholds sizing until they are re-saved',
};

function nonFkRewritesNote(rewrites) {
  if (!rewrites || !Object.keys(rewrites).length) return '';
  const parts = Object.entries(rewrites)
    .map(([key, value]) => (value === 'unknown'
      ? `${key} could not be counted (it is still rewritten)`
      : NON_FK_REWRITE_LABELS[key]?.(value) || `${key}: ${value}`));
  return ` Beyond the row counts: ${parts.join('; ')}.`;
}

async function previewMergeCustomers(winnerId, loserId) {
  const check = await loadMergeEligibility(winnerId, loserId);
  if (!check.ok) return { error: check.error, code: check.code };
  const { winner, loser, eligibility } = check;
  const { describeMergeEffects, rowLevelMergeConflict, dbLevelMergeConflict } = require('../customer-dedupe');
  // An unexecutable preview is a tool failure, not a card. The executor's
  // own deterministic row-level refusals (inactive winner, two Stripe
  // profiles, two payers, two billing modes / fees) run here FIRST so the
  // operator gets "resolve X first" instead of spending an approval on a
  // write that can never succeed.
  const rowConflict = rowLevelMergeConflict(winner, loser);
  if (rowConflict) {
    return { error: `These records cannot be merged yet: ${rowConflict.message}.`, code: rowConflict.code };
  }
  // The executor's DB-dependent refusals (legacy/special billing modes with
  // live billing history, a loser in a multi-property account with other
  // live members) run here too — unlocked, the same rule, so an impossible
  // merge is refused before it costs an approval (codex #4348 r7 P2).
  const dbConflict = await dbLevelMergeConflict(db, winner, loser);
  if (dbConflict) {
    return { error: `These records cannot be merged yet: ${dbConflict.message}.`, code: dbConflict.code };
  }
  const { moving, financial_effects, fingerprint } = await describeMergeEffects(db, winner, loser);
  // Likewise the executor refuses saved cards on a profile other than the
  // survivor's.
  if (financial_effects.saved_card_profile_conflict) {
    return { error: "Saved cards on these records belong to a different Stripe profile than the surviving customer's — resolve that in Stripe first.", code: 'stripe_profile_conflict' };
  }
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
    effects_fingerprint: fingerprint,
    note_to_operator: `${loserName} will be archived (soft-deleted) and folded into ${winnerName}: every appointment, service record, invoice, estimate, message, and every other row listed above repoints onto ${winnerName} in one transaction.${paymentSessionsNote(financial_effects.combined_payment_sessions)}${collectionCasesNote(financial_effects.collection_cases)}${savedCardDemotionsNote(financial_effects.saved_card_demotions)}${noteAppendsNote(financial_effects.note_appends)}${discardedStateNote(financial_effects.loser_state_discarded)}${nonFkRewritesNote(moving.non_fk_rewrites)}${collisionFoldsNote(financial_effects.predicted_collision_folds)} The merge is journaled and reviewable from the duplicates queue afterward; it is revertible from there ${financial_effects.predicted_collision_handlers.length ? `EXCEPT that this merge folds ${financial_effects.predicted_collision_handlers.join(', ')} (colliding rows the undo cannot split apart — restore by hand from the journal snapshot)` : 'unless the sweep has to fold colliding rows (e.g. duplicate tags), which the journal records and the undo refuses'}. Nothing was changed — the operator confirms from the card.`,
  };
}

async function commitMergeCustomers(winnerId, loserId, actionContext, approvedVersions = null, approvedEffects = null) {
  const { executeMerge } = require('../customer-dedupe');
  // Before executeMerge: one unlocked re-read of both customer versions and
  // the pair's eligibility. The two-step route already re-runs the
  // (unconfirmed) preview and refuses on a fingerprint mismatch before
  // reaching this function; the executor then validates versions, effects
  // fingerprint, and queue eligibility UNDER its row + pair locks. Each
  // loadMergeEligibility runs the full duplicate-queue scan, and a second
  // back-to-back unlocked sample cannot see drift those locked checks do
  // not already refuse — so there is exactly one preflight here.
  const before = await loadMergeEligibility(winnerId, loserId);
  if (!before.ok) return { error: before.error, code: before.code, preview_changed: true };
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
      // The approved card's effect fingerprint (route pin) is recomputed by
      // the executor over the LOCKED rows, and the final queue-eligibility
      // decision runs there too under the pair's adjudication lock. Without
      // a pin (direct call, no card) the effects are not asserted — the
      // version check above still holds.
      expectedEffectsFingerprint: approvedEffects || null,
      requireQueueEligibility: true,
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
  if (!mergeCustomersEnabled()) {
    return { error: 'Merging customers from the Intelligence Bar is not enabled (GATE_IB_MERGE_CUSTOMERS) — use the duplicates queue in the admin portal.', code: 'gate_off' };
  }
  // Postgres accepts an uppercase UUID and returns the row's canonical
  // lowercase id; the pair is matched by string, so normalize at the boundary.
  const uuid = (v) => (v == null ? v : String(v).trim().toLowerCase());
  const winnerId = uuid(input.winner_customer_id);
  const loserId = uuid(input.loser_customer_id);
  if (!winnerId || !loserId) return { error: 'winner_customer_id and loser_customer_id are required' };
  if (String(winnerId) === String(loserId)) return { error: 'winner_customer_id and loser_customer_id must be two different customers' };

  // ONLY the server-derived context can confirm (pre-push audit P0). Both
  // dispatchers overwrite input.confirmed from actionContext for every
  // WRITE_TWO_STEP tool, so reading input.confirmed was safe — but only
  // because of an invariant held two modules away, and `input` is raw
  // tool_use JSON from the model. A model reaching this executor by any
  // future path (or steered by an injection in customer text it reads
  // elsewhere) must not be able to approve an irreversible customer merge
  // by adding a field to its own call. The header's contract — "only
  // /confirm-action can attach confirmed:true" — is now enforced here, not
  // merely stated.
  if (actionContext.confirmed !== true) return previewMergeCustomers(winnerId, loserId);
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
Refuses when either id is missing, the two ids are the same, either customer is already archived, the pair is not an eligible duplicate-queue candidate (use find_duplicates: its queue section names the canonical winner, each candidate's id, tier and reasons), or the underlying merge engine finds a conflict it cannot resolve automatically (e.g. both customers carry their own Stripe profile, saved cards on a third profile, or different billing modes) — those must be reconciled first.
The first call returns a PREVIEW naming both customers (name, phone, email) and counts of what would move; nothing changes until the operator confirms from the card.`,
    input_schema: {
      type: 'object',
      properties: {
        winner_customer_id: { type: 'string', format: 'uuid', description: 'The customer record that survives the merge' },
        loser_customer_id: { type: 'string', format: 'uuid', description: 'The duplicate record that gets archived and folded into the winner' },
      },
      required: ['winner_customer_id', 'loser_customer_id'],
      // Defence in depth: the model cannot introduce a field of its own
      // (`confirmed`, `_approved_versions`, …) into this call.
      additionalProperties: false,
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
  mergeCustomersEnabled,
  executeCustomerLifecycleTool,
  // exported for tests
  _test: { customerName },
};
