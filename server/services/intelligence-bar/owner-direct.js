/**
 * Intelligence Bar owner-direct mode (owner ruling 2026-10-01).
 *
 * For the owner login only (ibFullAccess: contact@wavespestcontrol.com),
 * behind GATE_IB_OWNER_DIRECT:
 *   - No target refusals. The record the bar picks is the record it acts
 *     on; task-context.js turns its "name one customer" / "choose the
 *     target" / customer-scope refusals off when context.ownerDirect is set.
 *     A record that does not exist, or that belongs to a different customer
 *     than the one the same call names, is still refused: those are facts
 *     about the data, not permissions.
 *   - No confirmation card on INTERNAL EDITS (the list below). The write is
 *     still proposed as a pending action and committed through the one
 *     commit path (commitPendingAction in routes/admin-intelligence-bar.js),
 *     so every proposal-time pin, the receipt and the audit row are the same
 *     as a card confirm — only the operator's click is skipped. Direct
 *     commits run under GATE_IB_PLATFORM only: the platform task carries the
 *     client's request key and a durable checkpoint, so a retried /query
 *     after a response failure replays the saved task instead of minting a
 *     second approval and applying the mutation twice (Codex r1 on #5563).
 *     With the platform off the owner keeps today's card.
 *   - One tap stays for customer messages, money and bulk changes: every
 *     tool not on the list keeps its card.
 *   - Short replies; the bar never sends the owner to another screen.
 *
 * This changes two earlier owner decisions for this login only: "write
 * confirmation is structural" (2026-08-30/31) and "fail closed rather than
 * parse cohorts" (2026-09-08). Every other admin login and every technician
 * keeps both, gate on or off. IB_WRITES_DISABLED still stops every write.
 *
 * No customer communication: nothing on the list sends a customer text or
 * email. reschedule_appointment and assign_technician post tech-facing
 * notices only.
 */
const { gateEnvValue } = require('../../config/feature-gates');
const { ibFullAccess } = require('./ib-access');

// Internal single-record edits that execute without a card. A tool is added
// here deliberately; anything new keeps its card until someone lists it.
// Kept OFF the list on purpose:
//   - bulk_update_customers / bulk_update_leads, the route optimizers,
//     swap_tech_assignments, move_stops_to_day (bulk)
//   - create_appointment (prices the visit and fires the prep guide),
//     cancel_appointment, cancel_plan, merge_customers
//   - the estimate writers and approve_price (money)
//   - switch_appointment_property: on a grouped visit it relocates every
//     service line sharing the visit (bulk; Codex r1 on #5563)
//   - set_estimate_presentation: writes model-authored customer-facing copy
//     (a display name) onto an estimate; that stays reviewed on the card
//     (Codex r4)
//   - toggle_show_one_time_option: exposes or removes a priced one-time
//     offer on a sent estimate (money; Codex r5)
//   - cancel_queued_message: retires a scheduled customer text (a customer
//     message, irreversible; Codex r5)
//   - every external_action: send_sms, reply_via_sms, send_email_reply,
//     review requests and replies, block_sender, outside-service writes
const OWNER_DIRECT_TOOL_NAMES = new Set([
  'update_lead_contact',
  'update_lead_status',
  'create_customer',
  'update_customer',
  'add_customer_property',
  'update_customer_property',
  'set_primary_property',
  'update_property_access',
  'assign_technician',
  'reschedule_appointment',
  'adjust_stock',
  'create_restock_request',
  'update_restock_request',
  'toggle_estimate_v2_view',
]);

// update_customer also carries money, billing, lifecycle and comms fields.
// Only an edit made entirely of these contact / address / source / note
// fields skips the card; any other key, known or not, keeps it:
//   - waveguard_tier, monthly_rate, active: money (active=false winds
//     billing down)
//   - email: a changed email re-sends the pending double-opt-in
//     confirmation to the customer (customer-email-fanout) — a customer
//     message (pre-push P1)
//   - pipeline_stage: 'churned' winds billing down through the churn guard
//     (pre-push P0), and a live stage on a churned or inactive row
//     reactivates the account and clears its churn history (Codex r1) —
//     every stage change keeps the card
const DIRECT_CUSTOMER_FIELDS = new Set(['first_name', 'last_name', 'phone', 'city', 'state', 'zip',
  'address_line1', 'address_line2', 'lead_source', 'notes']);

// Read at call time: a flip or an unset needs no redeploy.
function ownerDirectLive(req) {
  return gateEnvValue('GATE_IB_OWNER_DIRECT') && ibFullAccess(req);
}

const sameName = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');

// `preview` is the mutation-free preview the proposal just ran (two-step
// tools); the decision reads it where the input alone cannot tell a single
// record from a group.
function executesWithoutCard(toolName, input = {}, preview = null) {
  if (!OWNER_DIRECT_TOOL_NAMES.has(toolName)) return false;
  // assign_technician takes a list of stops; one stop is an internal edit,
  // several is a bulk change and keeps its card (pre-push P1). A lone stop
  // that belongs to a grouped visit is not single-record either: the
  // assignment aligns or detaches its siblings (Codex r2), which the card
  // discloses — so the verified preview must show exactly one ungrouped stop.
  if (toolName === 'assign_technician') {
    if (!Array.isArray(input?.service_ids) || input.service_ids.length !== 1) return false;
    const stops = preview?.stops;
    if (!Array.isArray(stops) || stops.length !== 1 || stops[0]?.grouped_visit_id) return false;
    // The executor resolves technician_name by partial match; direct only
    // when the name the model passed IS the resolved technician's full name
    // (Codex r5), so "Adam" with two Adams on the roster keeps the card.
    return Boolean(preview.would_assign_to_id) && sameName(input.technician_name, preview.would_assign_to);
  }
  // The lead tools give lead_id precedence over lead_name; a name beside an
  // id is never checked against it (Codex r5), so direct needs the id alone.
  if (toolName === 'update_lead_contact' || toolName === 'update_lead_status') {
    return Boolean(input?.lead_id) && !input.lead_name;
  }
  // A property label is customer-visible copy (the portal's property
  // selector renders it verbatim), so a labelled add/update keeps the card
  // (Codex r6); relationship and occupancy edits stay direct.
  if (toolName === 'add_customer_property' || toolName === 'update_customer_property') {
    return !String(input?.label ?? '').trim();
  }
  // reschedule_appointment on a grouped visit detaches the service or
  // recomputes the parent visit window (the card discloses it; Codex r4), so
  // the pinned appointment the proposal verified must carry no visit_id.
  if (toolName === 'reschedule_appointment') {
    const pin = preview?.pinned_appointment;
    return Boolean(pin && typeof pin === 'object' && !pin.visit_id);
  }
  if (toolName === 'update_customer') {
    const updates = input?.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return false;
    const keys = Object.keys(updates);
    if (!keys.length || !keys.every(key => DIRECT_CUSTOMER_FIELDS.has(key))) return false;
    // `notes` replaces crm_notes: direct only over empty notes, read by the
    // proposal (preview.notes_replaced); without that read, the card.
    if (keys.includes('notes') && (!preview?.notes_replaced || preview.notes_replaced.before)) return false;
    return true;
  }
  return true;
}

// Bulk cap (owner ruling 2026-10-02): one request may make at most two
// direct edits with the same tool; three or more get one bulk card instead,
// so "mark these leads lost" cannot fan a bulk change out into card-free
// single calls. Counted from direct commits the request already made (seeded
// from the task's consumed actions, so a resumed task keeps its count) plus
// this model message's calls that could run direct, decided once before any
// of them runs. A call of a capped tool whose preview says it would run
// direct is refused with a pointer to the bulk tool (one card), never minted
// as separate cards the write frontier would cut to one (Codex r1 on
// #5675); a call the preview cards (notes over existing notes, a grouped
// stop) still reaches its card (Codex r2). A preview-dependent call counts
// in the message plan, so the cap errs toward the bulk card.
const DIRECT_CAP = 3;
const SEED_FAILED = Symbol('seed_failed');

// The preview-free half of executesWithoutCard: could this call run direct?
function mayExecuteWithoutCard(toolName, input = {}) {
  if (!OWNER_DIRECT_TOOL_NAMES.has(toolName)) return false;
  if (toolName === 'assign_technician') return Array.isArray(input?.service_ids) && input.service_ids.length === 1;
  if (toolName === 'update_lead_contact' || toolName === 'update_lead_status') return Boolean(input?.lead_id) && !input.lead_name;
  if (toolName === 'add_customer_property' || toolName === 'update_customer_property') return !String(input?.label ?? '').trim();
  if (toolName === 'update_customer') {
    const updates = input?.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return false;
    const keys = Object.keys(updates);
    return keys.length > 0 && keys.every(key => DIRECT_CUSTOMER_FIELDS.has(key));
  }
  return true;
}

// Direct commits already made for this task, by tool. A failed read counts
// as the cap reached: never a reason to skip the bulk card.
async function seedDirectCounts(task, dbh = null) {
  const counts = new Map();
  if (!task?.id) return counts;
  try {
    const knex = dbh || require('../../models/db');
    const rows = await knex('ib_pending_actions').where({ task_id: task.id, status: 'confirmed' }).whereNotNull('consumed_at')
      .whereIn('tool_name', [...OWNER_DIRECT_TOOL_NAMES]).groupBy('tool_name').select('tool_name').count('* as n');
    for (const row of rows) counts.set(row.tool_name, Number(row.n) || 0);
  } catch {
    counts.set(SEED_FAILED, true);
  }
  return counts;
}

function messageDirectPlan(toolUses, isValid = () => true) {
  const plan = new Map();
  for (const toolUse of toolUses || []) {
    if (mayExecuteWithoutCard(toolUse?.name, toolUse?.input) && isValid(toolUse)) plan.set(toolUse.name, (plan.get(toolUse.name) || 0) + 1);
  }
  return plan;
}

// Decided once per model message, before any of its calls runs: the
// message's own commits must not count against the rest of the message.
function cappedTools(committed, plan) {
  const capped = new Set();
  for (const [toolName, n] of plan) {
    if (committed.has(SEED_FAILED) || (committed.get(toolName) || 0) + n >= DIRECT_CAP) capped.add(toolName);
  }
  return capped;
}

function recordDirectCommit(committed, toolName) {
  committed.set(toolName, (committed.get(toolName) || 0) + 1);
}

const BULK_LIMIT_RESULT = Object.freeze({
  error: 'Three or more edits with the same tool in one request need one bulk confirmation card. This call changed nothing.',
  code: 'owner_direct_bulk_limit',
  note: 'Use the bulk tool so the owner gets ONE card: bulk_update_customers, bulk_update_leads, move_stops_to_day, or one assign_technician call listing every stop. If no bulk tool fits, list the records still to change in one line and do them in a follow-up request.',
});

// The proposal-to-receipt step for one direct edit, kept out of the query
// loop (Codex r2 P2 on runQuery's size). `commit` runs the one commit path;
// `cancel` releases an approval that was never consumed, so no pending row
// lingers with no card to confirm or cancel it. Returns what the loop needs:
// the model-facing result, the consumed action id (for thread attachment),
// whether the outcome is uncertain (closes the write frontier and keeps the
// task open), and whether the tool call failed.
async function runDirectCommit(clientPayload, { commit, cancel }) {
  let committed = null;
  try {
    committed = await commit(clientPayload.id, clientPayload.contract_hash);
  } finally {
    if (!committed?.claimed) await Promise.resolve().then(() => cancel(clientPayload.id)).catch(() => {});
  }
  const result = directModelResult(committed);
  return {
    result,
    actionId: committed?.claimed ? clientPayload.id : null,
    uncertain: result.executed === null || result.receiptPersisted === false,
    // A known partial outcome (the write landed, a follow-on repair did not)
    // keeps the task actionable exactly as a carded partial does (Codex r4).
    partial: result.outcome === 'partially_completed',
    failed: !result.executed,
  };
}

// What the model is told after a direct commit. `committed` is the
// { status, body } commitPendingAction returned. An unknown outcome (the
// runner stopped after the approval was consumed, so the mutation may have
// committed) is reported as exactly that — never as "did not complete",
// which would invite a retry. A saved outcome whose recovery record could
// not be written carries the commit path's own warning for the same reason.
function directModelResult(committed) {
  const body = committed?.body || {};
  const persistence = body.receiptPersisted === false ? { receiptPersisted: false, warning: body.warning } : {};
  if (body.outcome === 'outcome_unknown' || body.result?.outcome_unknown === true) {
    return { executed: null, outcome: 'outcome_unknown', result: body.result, ...persistence,
      error: body.result?.error || 'The outcome of this change could not be established.',
      note: 'OUTCOME UNKNOWN — the change may or may not have been applied. Do NOT call this tool again. Re-read the record to see whether it changed, and tell the operator in one short line what you found.' };
  }
  if (body.success === true && body.outcome === 'partially_completed') {
    // No card and no receipt card: this reply is the owner's only view of
    // the failed follow-on step (Codex r5).
    return { executed: true, outcome: 'partially_completed', result: body.result, ...persistence,
      warning: body.result?.warning || persistence.warning || 'A follow-on step did not complete.',
      note: 'PARTIAL — the change itself landed but a follow-on step failed (see warning). Tell the operator what changed AND quote the warning in one short line, and say what to re-check. Do not call this tool again.' };
  }
  if (body.success === true) {
    return { executed: true, outcome: body.outcome, result: body.result, ...persistence,
      note: `Done — this executed directly, with no confirmation card. Tell the operator what changed in one short line.${persistence.warning ? ' Do not repeat the action.' : ''}` };
  }
  return { executed: false, outcome: body.outcome || 'failed', result: body.result, ...persistence,
    error: body.error || body.result?.error || 'The change did not complete.',
    note: 'This did NOT complete and nothing is awaiting approval. Say what happened in one short line; do not claim it is done.' };
}

const OWNER_DIRECT_PROMPT = `

OWNER MODE (overrides the sections above where they differ):
You are talking to the owner. Do what they ask.
- Internal edits execute the moment you call the tool — no confirmation card: ${[...OWNER_DIRECT_TOOL_NAMES].join(', ')}. (update_customer executes directly for name, phone, address, lead source, and notes when the customer has none yet — notes REPLACE the existing notes, so over existing notes it shows a card naming what is deleted: include the existing text if the owner asked to add a line; an email, tier, rate, active or pipeline-stage change still shows a card. Lead edits execute directly when you pass lead_id alone — never lead_id with lead_name. A property add or edit executes directly unless it sets a label. assign_technician executes directly for one ungrouped stop when technician_name is the technician's full name; reschedule_appointment for one ungrouped stop; grouped visits, several stops and a partial name show a card. Three or more edits with the same tool in one request are refused as a set: for three or more records use the bulk tool, which shows one card.) When the result says executed: true, say what changed in one short line. Never tell the owner to confirm these.
- Customer messages, money and bulk changes still show a one-tap card. Prepare it and say "tap Confirm" — nothing more.
- Pick the record yourself from fresh lookups and pass its id: "the Murphy lead that came in today" is the Murphy lead created today. Use the phone, email, date, status or page record the owner gave to choose. Only when two records fit equally, ask ONE short question that lists the choices in a few words each.
- A second name in a request (a technician, a spouse, a neighbor) is context, not a second target.
- A refused or failed lookup is not "tools erroring". Try another lookup or a different selector first. Report a failure only when nothing worked, in one sentence.
- Never send the owner to another screen, never explain limitations, never apologize. If something truly cannot be done from here, say so in one sentence and offer the closest thing you can do.
- Replies: 1–3 short lines. No preamble, no recap of the request, no "anything else?". Lists and numbers only when the owner asked for data.`;

// The owner login with the gate on but GATE_IB_PLATFORM off: nothing commits
// directly (see the header), so the prompt must stay card-aware — the same
// voice and target rules, but every write is a one-tap card (Codex r2 P1).
const OWNER_DIRECT_CARDED_PROMPT = `

OWNER MODE (overrides the sections above where they differ):
You are talking to the owner. Do what they ask.
- Every write shows a one-tap confirmation card. Prepare it and say "tap Confirm" — nothing more. Never claim a change is done until a confirmed result says so.
- Pick the record yourself from fresh lookups and pass its id: "the Murphy lead that came in today" is the Murphy lead created today. Use the phone, email, date, status or page record the owner gave to choose. Only when two records fit equally, ask ONE short question that lists the choices in a few words each.
- A second name in a request (a technician, a spouse, a neighbor) is context, not a second target.
- A refused or failed lookup is not "tools erroring". Try another lookup or a different selector first. Report a failure only when nothing worked, in one sentence.
- Never send the owner to another screen, never explain limitations, never apologize. If something truly cannot be done from here, say so in one sentence and offer the closest thing you can do.
- Replies: 1–3 short lines. No preamble, no recap of the request, no "anything else?". Lists and numbers only when the owner asked for data.`;

module.exports = { OWNER_DIRECT_TOOL_NAMES, DIRECT_CUSTOMER_FIELDS, DIRECT_CAP, BULK_LIMIT_RESULT, ownerDirectLive, executesWithoutCard, mayExecuteWithoutCard, seedDirectCounts, messageDirectPlan, cappedTools, recordDirectCommit, directModelResult, runDirectCommit, OWNER_DIRECT_PROMPT, OWNER_DIRECT_CARDED_PROMPT };
