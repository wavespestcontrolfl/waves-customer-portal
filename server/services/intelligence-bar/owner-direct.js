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
 *     as a card confirm — only the operator's click is skipped.
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
  'switch_appointment_property',
  'adjust_stock',
  'create_restock_request',
  'update_restock_request',
  'toggle_estimate_v2_view',
  'toggle_show_one_time_option',
  'set_estimate_presentation',
  'cancel_queued_message',
]);

// update_customer also carries money, billing and comms fields. Only an edit
// made entirely of these contact / address / pipeline / note fields skips
// the card; any other key, known or not, keeps it:
//   - waveguard_tier, monthly_rate, active: money (active=false winds
//     billing down)
//   - email: a changed email re-sends the pending double-opt-in
//     confirmation to the customer (customer-email-fanout) — a customer
//     message, so it keeps its card (pre-push P1)
//   - pipeline_stage = 'churned': the churn guard winds billing down on the
//     same write (pre-push P0); every other stage is a label
const DIRECT_CUSTOMER_FIELDS = new Set(['first_name', 'last_name', 'phone', 'city', 'state', 'zip',
  'address_line1', 'address_line2', 'pipeline_stage', 'lead_source', 'notes']);
const CARDED_CUSTOMER_VALUES = { pipeline_stage: new Set(['churned']) };

// Read at call time: a flip or an unset needs no redeploy.
function ownerDirectLive(req) {
  return gateEnvValue('GATE_IB_OWNER_DIRECT') && ibFullAccess(req);
}

function executesWithoutCard(toolName, input = {}) {
  if (!OWNER_DIRECT_TOOL_NAMES.has(toolName)) return false;
  // assign_technician takes a list of stops; one stop is an internal edit,
  // several is a bulk change and keeps its card (pre-push P1).
  if (toolName === 'assign_technician') {
    return Array.isArray(input?.service_ids) && input.service_ids.length === 1;
  }
  if (toolName === 'update_customer') {
    const updates = input?.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return false;
    const keys = Object.keys(updates);
    return keys.length > 0 && keys.every(key => DIRECT_CUSTOMER_FIELDS.has(key)
      && !CARDED_CUSTOMER_VALUES[key]?.has(String(updates[key] ?? '').trim().toLowerCase()));
  }
  return true;
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
- Internal edits execute the moment you call the tool — no confirmation card: ${[...OWNER_DIRECT_TOOL_NAMES].join(', ')}. (update_customer executes directly for name, phone, address, pipeline stage, lead source and notes; an email, tier, rate, active or Churned change still shows a card. assign_technician executes directly for one stop; several stops show a card.) When the result says executed: true, say what changed in one short line. Never tell the owner to confirm these.
- Customer messages, money and bulk changes still show a one-tap card. Prepare it and say "tap Confirm" — nothing more.
- Pick the record yourself from fresh lookups and pass its id: "the Murphy lead that came in today" is the Murphy lead created today. Use the phone, email, date, status or page record the owner gave to choose. Only when two records fit equally, ask ONE short question that lists the choices in a few words each.
- A second name in a request (a technician, a spouse, a neighbor) is context, not a second target.
- A refused or failed lookup is not "tools erroring". Try another lookup or a different selector first. Report a failure only when nothing worked, in one sentence.
- Never send the owner to another screen, never explain limitations, never apologize. If something truly cannot be done from here, say so in one sentence and offer the closest thing you can do.
- Replies: 1–3 short lines. No preamble, no recap of the request, no "anything else?". Lists and numbers only when the owner asked for data.`;

module.exports = { OWNER_DIRECT_TOOL_NAMES, DIRECT_CUSTOMER_FIELDS, ownerDirectLive, executesWithoutCard, directModelResult, OWNER_DIRECT_PROMPT };
