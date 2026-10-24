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
 * After a general admin read (`read_admin_data`) returned data, nothing in the
 * rest of the request runs direct: see UNTRUSTED READS below.
 *
 * No customer communication: nothing on the list sends a customer text or
 * email. reschedule_appointment and assign_technician post tech-facing
 * notices only.
 */
const { gateEnvValue, ibTargetRulesV2Live } = require('../../config/feature-gates');
const { changesAddress } = require('./address-tools');
const { ibFullAccess } = require('./ib-access');
const { executionOutcome } = require('./outcomes');
const IbThreads = require('./threads');
const { isChoiceLabelShape } = require('./choice-tools');

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
//   - adjust_stock and update_restock_request (receive): both change the stock count. Stock
//     writes always show a confirm card, owner 2026-10-05: the operator's wording cannot be
//     trusted for the amount ("2 of the Talak" became 2 fl oz). create_restock_request stays
//     on the list: it saves a request and changes no stock.
//   - add_customer_property: every valid add carries an address (changesAddress),
//     so it always shows its card (#6297); it is not listed as card-free
//   - remove_saved_payment_method (Stripe detach, optional Auto Pay-off,
//     customer emails) and correct_invoice_address (rewrites the address a
//     customer-facing receipt prints; money-domain document) — both always
//     carded, owner 2026-10-03
const OWNER_DIRECT_TOOL_NAMES = new Set([
  'update_lead_contact',
  'update_lead_status',
  'create_customer',
  'update_customer',
  'update_customer_property',
  'set_primary_property',
  'update_property_access',
  'assign_technician',
  'reschedule_appointment',
  'create_restock_request',
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
//   - phone: the customer's portal sign-in key (the one-time code goes to
//     it), so a changed number changes who can open the account. Every
//     phone change keeps the card, named customer or not (owner 2026-10-24;
//     #6463's always-card half)
// No address field: a change to any part of a street address always keeps
// its card (#6297; changesAddress below covers the other address writers).
const DIRECT_CUSTOMER_FIELDS = new Set(['first_name', 'last_name', 'lead_source', 'notes']);

// Read at call time: a flip or an unset needs no redeploy.
function ownerDirectLive(req) {
  return gateEnvValue('GATE_IB_OWNER_DIRECT') && ibFullAccess(req);
}

const sameName = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');

// TARGET RULES (GATE_IB_TARGET_RULES_V2; owner ruling 2026-10-12 decision 3). A
// card-free edit on a customer keeps its card when the message did not name that
// customer and that customer is not the one on screen. "Named" is decided from
// server facts only, never from the model's input: the customers the task
// context resolved from a name typed in THIS message (groundedCustomerIds, the simplest case
// only) and the customer the page shows (pageIds). A
// customer the model found itself (a call log, a search) is in neither set.
// Not subject to it: lead tools (a lead is not a customer), create_customer
// (the customer is the message's own content), create_restock_request and
// toggle_estimate_v2_view (no customer is edited).
const CUSTOMER_ID_EDIT_TOOLS = new Set(['update_customer', 'update_customer_property', 'set_primary_property', 'update_property_access']);

// Built once per request from the finished task context. null while the gate
// is off. With the gate on and no grounding passed, every subject edit is carded.
function targetGrounding(taskContext) {
  if (!ibTargetRulesV2Live()) return null;
  const ids = new Set();
  const add = id => { if (id) ids.add(String(id).toLowerCase()); };
  // Direct (no-card) authority from typed evidence comes ONLY from groundedCustomerIds: exactly
  // one typed full name that resolves to exactly one customer, with no qualifier in the message
  // (Codex #6369 r23). A target the name lookup resolved ('current_request_lookup') grants
  // nothing on its own; an operator pick and the page still do.
  for (const id of Array.isArray(taskContext?.groundedCustomerIds) ? taskContext.groundedCustomerIds : []) add(id);
  // The customer on screen keeps its authority only when the message names nobody, or names exactly
  // that customer; failed identity evidence takes it too (Codex #6369 r26).
  const blocked = taskContext?.pageGroundingBlocked === true;
  const picked = target => (target?.provenance === 'current_request_lookup' || (blocked && target?.provenance === 'viewed_record') ? null : target?.customer_id);
  for (const target of Array.isArray(taskContext?.targets) ? taskContext.targets : []) add(picked(target));
  add(picked(taskContext?.target));
  // The customer on screen: the page context's own customer, or the customer
  // record the page showed (pageIds, already validated by the task context).
  const page = taskContext?.page || {};
  add(picked(page.customer));
  if (!blocked) add(page.ids?.customer_id);
  return { ids };
}

const groundedCustomerId = (id, grounding) => Boolean(id) && Boolean(grounding?.ids?.has(String(id).toLowerCase()));

// Preview-free half: only the tools that carry the customer id in their input.
function customerNamedOrOnScreenPossible(toolName, input, grounding) {
  return !ibTargetRulesV2Live() || !CUSTOMER_ID_EDIT_TOOLS.has(toolName) || groundedCustomerId(input?.customer_id, grounding);
}

// Full half, on the finished preview: reschedule_appointment pins its
// appointment's customer id; assign_technician's stop carries its customer id.
function customerNamedOrOnScreen(toolName, input, preview, grounding) {
  if (!ibTargetRulesV2Live()) return true;
  if (CUSTOMER_ID_EDIT_TOOLS.has(toolName)) return groundedCustomerId(input?.customer_id, grounding);
  if (toolName === 'reschedule_appointment') return groundedCustomerId(preview?.pinned_appointment?.customer_id, grounding);
  // The stop's customer id comes from the proposal's own read (the stops preview, gate on);
  // a preview without it (or a name) cannot show whose stop it is, so it keeps its card.
  if (toolName === 'assign_technician') return groundedCustomerId(preview?.stops?.[0]?.customer_id, grounding);
  return true;
}

// `preview` is the mutation-free preview the proposal just ran (two-step
// tools); the decision reads it where the input alone cannot tell a single
// record from a group. `grounding` is targetGrounding(taskContext).
// The decision is a pipeline of named stages; every stage must agree (Codex #6369 r13).
//   scope:    the tool is an owner-direct tool and the call carries no address text.
//             A change to any part of a street address always keeps its card, so the
//             operator sees the exact address before it is saved (#6297).
//   tool:     the tool's own single-record / field rules (DIRECT_TOOL_RULES below).
//   grounding: the customer was named in this message or is on screen (rule 1).
function directEditAllowed(toolName, input = {}, preview = null, grounding = null) {
  const call = { toolName, input, preview, grounding };
  return DIRECT_EDIT_STAGES.every(stage => stage(call));
}

const directScopeStage = ({ toolName, input }) => OWNER_DIRECT_TOOL_NAMES.has(toolName) && !changesAddress(toolName, input);
const directToolStage = ({ toolName, input, preview }) => (DIRECT_TOOL_RULES.get(toolName) || (() => true))(input, preview);
const directGroundingStage = ({ toolName, input, preview, grounding }) => customerNamedOrOnScreen(toolName, input, preview, grounding);

// assign_technician takes a list of stops; one stop is an internal edit, several is a
// bulk change and keeps its card (pre-push P1). A lone stop that belongs to a grouped
// visit is not single-record either: the assignment aligns or detaches its siblings
// (Codex r2), which the card discloses, so the verified preview must show exactly one
// ungrouped stop. The executor resolves technician_name by partial match; direct only
// when the name the model passed IS the resolved technician's full name (Codex r5),
// so "Adam" with two Adams on the roster keeps the card.
function assignTechnicianRule(input, preview) {
  if (!Array.isArray(input?.service_ids) || input.service_ids.length !== 1) return false;
  const stops = preview?.stops;
  if (!Array.isArray(stops) || stops.length !== 1 || stops[0]?.grouped_visit_id) return false;
  return Boolean(preview.would_assign_to_id) && sameName(input.technician_name, preview.would_assign_to);
}

// The lead tools give lead_id precedence over lead_name; a name beside an id is never
// checked against it (Codex r5), so direct needs the id alone.
const leadEditRule = input => Boolean(input?.lead_id) && !input.lead_name;

// A property label is customer-visible copy (the portal's property selector renders it
// verbatim), so a labelled update keeps the card (Codex r6); relationship and occupancy
// edits stay direct.
const propertyEditRule = input => !String(input?.label ?? '').trim();

// reschedule_appointment on a grouped visit detaches the service or recomputes the
// parent visit window (the card discloses it; Codex r4), so the pinned appointment the
// proposal verified must carry no visit_id.
function rescheduleRule(input, preview) {
  const pin = preview?.pinned_appointment;
  return Boolean(pin && typeof pin === 'object' && !pin.visit_id);
}

function customerUpdateRule(input, preview) {
  const updates = input?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return false;
  const keys = Object.keys(updates);
  if (!keys.length || !keys.every(key => DIRECT_CUSTOMER_FIELDS.has(key))) return false;
  // `notes` replaces crm_notes: direct only over empty notes, read by the proposal
  // (preview.notes_replaced); without that read, the card.
  return !(keys.includes('notes') && (!preview?.notes_replaced || preview.notes_replaced.before));
}

const DIRECT_TOOL_RULES = new Map([
  ['assign_technician', assignTechnicianRule],
  ['update_lead_contact', leadEditRule],
  ['update_lead_status', leadEditRule],
  ['update_customer_property', propertyEditRule],
  ['reschedule_appointment', rescheduleRule],
  ['update_customer', customerUpdateRule],
]);

const DIRECT_EDIT_STAGES = [directScopeStage, directToolStage, directGroundingStage];

// UNTRUSTED READS. Text inside a read result can be typed by anyone (a
// customer name a public quote visitor entered) and can read like an
// instruction to the next model round. Once the general admin read
// (`read_admin_data`) has returned data in a request, no write in the REST of
// that request executes without a card: the owner-direct decisions above all
// return false when this per-request flag is set, so the write is carded
// exactly like a non-owner admin's. The flag lives in one `requestTaint`
// object the route creates once per request (seeded from the saved history, so
// a resumed task keeps it) and passes to the three decision functions. Scope:
// this covers the general read, because its catalog is broad and grows by
// review, and (GATE_IB_TARGET_RULES_V2) every read outside TRUSTED_READS below.
const GENERAL_READ_TOOL = 'read_admin_data';

// A general-read result that carries data: a 2xx answer with a `data` field.
// An error, a refusal or a bare note does not taint.
function isDataAnswer(result) {
  return Boolean(result) && typeof result === 'object' && !result.error && !result.code
    && Number.isInteger(result.status) && result.status >= 200 && result.status < 300 && result.data !== undefined;
}

// GATE_IB_TARGET_RULES_V2 (Codex #6369 r9): the rule is inverted. With the gate on,
// ANY successful read result taints the request, except the tools in TRUSTED_READS.
// Message bodies, lead and web-form text, call transcripts, emails, reviews and
// outside notes are all reads that can carry a stranger's instructions, and a new
// read tool is untrusted until someone reads its result shape and lists it here.
// A write tool's result is not a read, so it taints only when it shows a prior value as text (r45;
// known write kinds only; a tool the policy does not know taints). Gate off: only `read_admin_data` taints.
//
// TRUSTED_READS lists only tools whose results carry NO customer-entered string:
// pure numbers and aggregates by service line or period, the pricing config the team
// wrote, and control replies. Any read whose result carries a customer or lead name,
// a city, an address, a payer, a note or other customer-entered text stays OUT (Codex
// #6369 r10), so these are left out on purpose: get_day_summary and every schedule read
// (customer names), the invoice readers (payer and customer names), get_revenue_breakdown
// (groups by customer or city), compare_technicians (cities), get_customer_detail, the
// notes readers, the lead reads, get_today_briefing, the expense and banking reads, the
// vendor and product reads, and every comms, email, review, call and SEO read.
const TRUSTED_READS = new Set([
  // dashboard and revenue aggregates (numbers by period, tier or service line)
  'get_kpi_snapshot', 'get_mrr_trend', 'compare_periods', 'get_service_mix',
  'get_revenue_overview', 'compare_revenue_periods', 'get_service_line_pnl', 'get_tech_revenue_performance',
  // pricing config the team wrote
  'get_waveguard_tiers', 'read_pricing_config',
  // control replies (server-authored metadata)
  'offer_choices', 'find_admin_reads', 'discover_capabilities',
]);

const actionPolicy = require('./action-policy.json');
// A read the policy knows as a read, or a tool it does not know at all.
const isReadTool = toolName => !actionPolicy[toolName] || actionPolicy[toolName].kind === 'read';
const readTaints = toolName => (toolName === GENERAL_READ_TOOL
  || (ibTargetRulesV2Live() && isReadTool(toolName) && !TRUSTED_READS.has(toolName)));

// A read that returned rows: an object without an error or a refusal code.
const isReadAnswer = result => Boolean(result) && typeof result === 'object' && !result.error && !result.code;

// A write result that shows a prior value as text (a card preview's notes_replaced.before, a field's
// before / previous / existing value) hands customer-entered text to the model like a read does
// (Codex #6369 r45). Numbers (stock_before) and on/off flags carry no instructions.
const PRIOR_VALUE_KEY_RE = /(?:^|_)(?:before|previous|prior|old|existing|replaced|current)(?:_|$)/i;
function carriesPriorText(value, depth = 0, underPriorKey = false) {
  if (depth > 6 || value == null) return false;
  if (typeof value === 'string') return underPriorKey && /\p{L}{2,}/u.test(value);
  if (Array.isArray(value)) return value.some(item => carriesPriorText(item, depth + 1, underPriorKey));
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([key, inner]) => carriesPriorText(inner, depth + 1, underPriorKey || PRIOR_VALUE_KEY_RE.test(key)));
}

function noteUntrustedRead(taint, toolName, result) {
  if (taint && ibTargetRulesV2Live() && !isReadTool(toolName) && isReadAnswer(result) && carriesPriorText(result)) {
    taint.untrustedRead = true;
    taint.untrustedV2 = true;
    return;
  }
  if (!taint || !readTaints(toolName)) return;
  if (!(toolName === GENERAL_READ_TOOL ? isDataAnswer(result) : isReadAnswer(result))) return;
  taint.untrustedRead = true;
  // Which marker the reply leaves on the thread: read_admin_data keeps the old one, every
  // v2-only tainting read gets the v2 marker (Codex #6369 r19).
  if (toolName === GENERAL_READ_TOOL) taint.untrustedGeneral = true;
  else taint.untrustedV2 = true;
}

// Pure: does a saved message history hold a tainting read that returned data?
// A read with no saved result (the runner stopped between the call and its
// result) counts as returned, so a resume fails closed.
function untrustedReadKindsInHistory(messages) {
  const blocks = (Array.isArray(messages) ? messages : []).flatMap(message => (Array.isArray(message?.content) ? message.content : []));
  const reads = blocks.filter(block => block?.type === 'tool_use' && readTaints(block.name));
  const answers = new Map(blocks.filter(block => block?.type === 'tool_result').map(block => [block.tool_use_id, block]));
  const returned = (read) => {
    const answer = answers.get(read.id);
    if (!answer) return true;
    try { return (read.name === GENERAL_READ_TOOL ? isDataAnswer : isReadAnswer)(JSON.parse(answer.content)); } catch { return true; }
  };
  const returnedReads = reads.filter(returned);
  // A write whose saved result showed prior text taints a resume the same way (r45).
  const priorTextWrite = ibTargetRulesV2Live() && blocks.some((block) => {
    if (block?.type !== 'tool_use' || isReadTool(block.name)) return false;
    const answer = answers.get(block.id);
    if (!answer) return false;
    try { const parsed = JSON.parse(answer.content); return isReadAnswer(parsed) && carriesPriorText(parsed); } catch { return false; }
  });
  return { general: returnedReads.some(read => read.name === GENERAL_READ_TOOL), v2: priorTextWrite || returnedReads.some(read => read.name !== GENERAL_READ_TOOL) };
}

const untrustedReadInHistory = messages => Object.values(untrustedReadKindsInHistory(messages)).some(Boolean);

function newRequestTaint(history) {
  const { general, v2 } = untrustedReadKindsInHistory(history);
  return { untrustedRead: general || v2, untrustedGeneral: general, untrustedV2: v2 };
}

// What the server's own thread record says: true (an earlier exchange read
// admin data, or the thread cannot be read: fail closed), false (a verified
// thread with no such exchange), or null when there is no thread id to look up.
// Consulted whatever the gates say: the saved marker stays authoritative even
// after the general read is turned off.
async function threadTaintVerdict(actorId, threadId, marker = null) {
  if (!threadId) return null;
  try {
    return (await (marker ? IbThreads.hasUntrustedRead(actorId, threadId, marker) : IbThreads.hasUntrustedRead(actorId, threadId))) === true;
  } catch {
    return true;
  }
}

// The flag for a new request, called once per request. It starts from the
// message history this request carries (a resumed task's saved blocks), then
// from the SERVER's own record of the conversation:
//   - whenever owner-direct is on and there is a thread id, the thread record
//     decides, whatever the general read gate says: a marked exchange taints
//     the thread for its life, an unreadable thread is tainted (fail closed),
//     and a verified thread without a marker is not (one query; see
//     IbThreads.hasUntrustedRead);
//   - with NO record to consult (no thread id, or the thread append failed so
//     the client detached) a FOLLOW-UP turn (history, or a thread id) is
//     tainted, because an earlier turn may have used the general read and
//     nothing trusted says it did not: cards are required. This holds for a
//     full-access login whatever the general read gate says NOW: the gate may
//     have been on for the earlier turn and turned off since, and no trusted
//     record exists to tell. The cost is narrow: with thread persistence on
//     (production) a follow-up has a verified thread record, so this branch
//     is only reached with threads off or after a failed append;
//   - the first message of a conversation (no history, no thread id) is not.
// `needed` is false when owner-direct is off, where the flag decides nothing.
async function loadRequestTaint(args) {
  const taint = await loadUntrustedTaint(args);
  if (args.needed !== false && await sameNameChoicePending(args)) taint.sameNameCandidates = true;
  return taint;
}

async function loadUntrustedTaint({ history, threadId, actorId, needed = true, fullAccess = false, conversationHistory = [] }) {
  const taint = newRequestTaint(history);
  if (taint.untrustedRead || !needed) return taint;
  const verdict = await threadTaintVerdict(actorId, threadId);
  if (verdict !== null) {
    // The v2 marker counts only while the v2 gate is on (Codex #6369 r19).
    taint.untrustedGeneral = verdict;
    taint.untrustedV2 = !verdict && ibTargetRulesV2Live() && await threadTaintVerdict(actorId, threadId, IbThreads.UNTRUSTED_READ_V2_MARKER) === true;
    taint.untrustedRead = taint.untrustedGeneral || taint.untrustedV2;
    return taint;
  }
  taint.untrustedGeneral = fullAccess === true && Array.isArray(conversationHistory) && conversationHistory.length > 0;
  taint.untrustedRead = taint.untrustedGeneral;
  return taint;
}

// Bulk cap (owner ruling 2026-10-02): one request may make at most two
// direct edits with the same tool; three or more get one bulk card instead,
// so "mark these leads lost" cannot fan a bulk change out into card-free
// single calls. Counted from direct commits the request already made (seeded
// from the task's consumed actions, so a resumed task keeps its count) plus
// this model message's calls that could run direct, decided once before any
// of them runs. A call of a capped tool whose preview says it would run
// direct is refused before anything is stored, with a pointer to the bulk
// tool (one card), never minted
// as separate cards the write frontier would cut to one (Codex r1 on
// #5675); a call the preview cards (notes over existing notes, a grouped
// stop) still reaches its card (Codex r2). A preview-dependent call counts
// in the message plan, so the cap errs toward the bulk card.
const DIRECT_CAP = 3;
// GATE_IB_TARGET_RULES_V2: one request may make 5 direct edits with the same
// tool; the 6th (and a message that plans a 6th) gets the bulk card. Off, the
// cap above holds: the 3rd is the first refused.
const DIRECT_EDITS_V2 = 5;
// Lead edits are not grounded to a named customer and lead text can come from
// the public lead form (a prompt-injection path), so they keep the old cap
// even with the gate on (Codex #6369 security P2).
// Only a tool whose target is proven named or on screen (rule 1) gets the
// five-edit limit; every other direct tool (lead edits, create_customer) keeps
// the old cap, so text the model read cannot steer more writes (Codex security r6).
const isGroundedCapTool = (toolName) => CUSTOMER_ID_EDIT_TOOLS.has(toolName) || toolName === 'reschedule_appointment' || toolName === 'assign_technician';
const directCapThreshold = (toolName) => (ibTargetRulesV2Live() && isGroundedCapTool(toolName) ? DIRECT_EDITS_V2 + 1 : DIRECT_CAP);
const DID_NOT_RUN = new Set(['failed', 'blocked', 'awaiting_approval']);
const SEED_FAILED = Symbol('seed_failed');

// The preview-free half of directEditAllowed: could this call run direct?
// A call on a customer the message did not name and the page does not show gets a card anyway, so it never counts either.
function directEditPossible(toolName, input = {}, grounding = null) {
  return directEditPossibleBase(toolName, input) && customerNamedOrOnScreenPossible(toolName, input, grounding);
}

function directEditPossibleBase(toolName, input = {}) {
  // A call that carries address text gets a card anyway (directEditAllowed), so it never counts toward the direct cap.
  if (!OWNER_DIRECT_TOOL_NAMES.has(toolName) || changesAddress(toolName, input)) return false;
  if (toolName === 'assign_technician') return Array.isArray(input?.service_ids) && input.service_ids.length === 1;
  if (toolName === 'update_lead_contact' || toolName === 'update_lead_status') return Boolean(input?.lead_id) && !input.lead_name;
  if (toolName === 'update_customer_property') return !String(input?.label ?? '').trim();
  if (toolName === 'update_customer') {
    // An array's keys are indexes, never contact fields, so it falls out below.
    const updates = input?.updates;
    const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
    return keys.length > 0 && keys.every(key => DIRECT_CUSTOMER_FIELDS.has(key));
  }
  return true;
}

// The two decisions the route asks, each checking the per-request flag first
// (UNTRUSTED READS above): after a general read returned data, never direct.
function executesWithoutCard(toolName, input = {}, preview = null, taint = null, grounding = null) {
  return cardsEveryWrite(taint) ? false : directEditAllowed(toolName, input, preview, grounding);
}

function mayExecuteWithoutCard(toolName, input = {}, taint = null, grounding = null) {
  return cardsEveryWrite(taint) ? false : directEditPossible(toolName, input, grounding);
}

// GATE_IB_TARGET_RULES_V2 (Codex #6369 r14, r20): a request whose context carries more than
// one customer row (same-name candidates) keeps a card on every write, including the
// on-screen same-name pick. A separate flag from untrustedRead, so it is never written
// to the thread's marker and does not taint later requests on the thread. Every card-free
// path (customer edits, create_customer and the other exempt tools) asks executesWithoutCard
// or mayExecuteWithoutCard, so this flag cards them all (Codex #6369 r15).
function noteSameNameContext(taint, taskContext) {
  // Only an owner-direct context: with owner-direct off the flag and the marker mean nothing (Codex #6369 r31).
  if (taint && ibTargetRulesV2Live() && taskContext?.ownerDirect === true
    && ((taskContext?.candidates?.length || 0) > 1 || taskContext?.sameNameOverflow === true)) {
    taint.sameNameCandidates = true;
    // The reply is then followed by a text-only "yes" as readily as a button tap, whatever the
    // group kind (Codex #6369 r22): the thread marker is left whenever more than one candidate
    // row reached the model, not only when buttons were shown.
    taint.sameNameEmitted = true;
  }
}

// Does the final response show same-name choice buttons: a button list that is actually
// in the reply the client gets (not suppressed by a card or a direct action) and whose
// options are the choice labels built from this request's same-name candidates? An
// ordinary amount, date or product choice never marks (Codex #6369 r17). The tap sends
// the label text back as the next message, so the thread then cards the next writes.
function markSameNameChoices(taint, taskContext, offeredChoices, suppressingActions = 0) {
  // A card or a direct action in the same reply suppresses the buttons.
  const shownChoices = suppressingActions > 0 ? null : offeredChoices;
  const labels = new Set((taskContext?.candidates || []).map(candidate => candidate?.choice_label).filter(Boolean));
  if (taint && ibTargetRulesV2Live() && Array.isArray(shownChoices) && shownChoices.some(choice => labels.has(choice))) taint.sameNameEmitted = true;
}

// Does this request's reply leave a pending same-name choice on the thread? Only what THIS
// request showed counts, never what it consumed.
const sameNameMarkerNeeded = taint => Boolean(taint?.sameNameEmitted) && ibTargetRulesV2Live();

// The marker check for a new request: a pending same-name choice cards every write in it.
// An unreadable thread fails closed.
async function sameNameChoicePending({ actorId, threadId, conversationHistory, prompt }) {
  if (!ibTargetRulesV2Live()) return false;
  // Choice buttons stay tappable long after the 30-minute marker window, so a message shaped like a
  // choice reply ("Full Name, City" / "First L., City") is carded whatever the marker's age or the
  // thread says (Codex #6369 r30).
  if (looksLikeChoiceReply(prompt)) return true;
  if (!threadId || !actorId) return pendingFromHistory(conversationHistory, prompt);
  try {
    return (await IbThreads.hasSameNameChoicePending(actorId, threadId)) === true;
  } catch {
    return true;
  }
}

// No thread record to read (threads off, or the append failed): the round-tripped history is
// the only evidence (Codex #6369 r23). A marker in any of the last 3 assistant turns counts as
// pending (no clock is available). With no readable history, a message shaped like a choice
// reply ("Full Name, City" / "First L., City") fails closed.
// The one label shape (choice-tools isChoiceLabelShape): task-context emits only labels that pass it.
const looksLikeChoiceReply = prompt => isChoiceLabelShape(String(prompt ?? '').trim());
const turnText = content => (Array.isArray(content) ? content.map(block => (typeof block === 'string' ? block : block?.text || '')).join('\n') : String(content ?? ''));

function pendingFromHistory(conversationHistory, prompt) {
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) return looksLikeChoiceReply(prompt);
  return conversationHistory.filter(message => message?.role === 'assistant').slice(-3)
    .some(message => turnText(message.content).split('\n').some(line => line.trim() === IbThreads.SAME_NAME_CHOICE_MARKER));
}

const cardsEveryWrite = taint => Boolean(taint?.untrustedRead || taint?.sameNameCandidates);

// Direct commits already made for this task, by tool (proposePendingWrite
// stamps `_ib_owner_direct` on them). A failed read counts
// as the cap reached: never a reason to skip the bulk card.
async function seedDirectCounts(task, dbh = null) {
  const counts = new Map();
  if (!task?.id) return counts;
  try {
    const knex = dbh || require('../../models/db');
    // Actions the proposal marked owner-direct; a card the owner confirmed
    // is consumed the same way and is marked false. A listed tool's row with
    // no marker predates the marker (a task in flight across the deploy) and
    // counts too, so the cap cannot restart on resume.
    const rows = await knex('ib_pending_actions').where({ task_id: task.id, status: 'confirmed' }).whereNotNull('consumed_at')
      .whereIn('tool_name', [...OWNER_DIRECT_TOOL_NAMES])
      .whereRaw("coalesce(params->>'_ib_owner_direct', 'unmarked') <> 'false'").select('tool_name', 'result');
    // A known failure changed nothing and does not count (Codex r5); an
    // unknown outcome may have, and does.
    for (const row of rows) {
      const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
      if (!DID_NOT_RUN.has(executionOutcome(result))) counts.set(row.tool_name, (counts.get(row.tool_name) || 0) + 1);
    }
  } catch {
    counts.set(SEED_FAILED, true);
  }
  return counts;
}

// GATE_IB_TARGET_RULES_V2 (Codex #6369 r19, r21, r26): every grounded customer tool (the customer
// edits, reschedule_appointment, assign_technician) is counted SEQUENTIALLY, as it commits
// (dynamicCapReached), never from a whole-message plan made before the calls run. A plan would
// refuse all six of six grounded name edits, and both of two proposed beside four committed;
// counting as they commit lets five run and refuses only the sixth (four committed + two
// proposed: one runs, one is refused). Carded calls never use the allowance.
const countsAsTheyCommit = toolName => ibTargetRulesV2Live() && isGroundedCapTool(toolName);

function messageDirectPlan(toolUses, isValid = () => true, taint = null, grounding = null) {
  const plan = new Map();
  for (const toolUse of toolUses || []) {
    // Grounded customer tools join no up-front plan; each is counted as it commits (see above).
    if (countsAsTheyCommit(toolUse?.name)) continue;
    if (mayExecuteWithoutCard(toolUse?.name, toolUse?.input, taint, grounding) && isValid(toolUse)) plan.set(toolUse.name, (plan.get(toolUse.name) || 0) + 1);
  }
  return plan;
}

// Decided once per model message, before any of its calls runs: the
// message's own commits must not count against the rest of the message.
function cappedTools(committed, plan) {
  const capped = new Set();
  for (const [toolName, n] of plan) {
    if (committed.has(SEED_FAILED) || (committed.get(toolName) || 0) + n >= directCapThreshold(toolName)) capped.add(toolName);
  }
  return capped;
}

// The preview-time half of the cap for the preview-decided tools (gate on): refuse
// once this request has already made its 5 direct edits with the tool.
function dynamicCapReached(committed, toolName) {
  if (!countsAsTheyCommit(toolName)) return false;
  return committed.has(SEED_FAILED) || (committed.get(toolName) || 0) >= DIRECT_EDITS_V2;
}

function recordDirectCommit(committed, toolName) {
  committed.set(toolName, (committed.get(toolName) || 0) + 1);
}

const BULK_LIMIT_RESULT = Object.freeze({
  error: 'Three or more edits with the same tool in one request need one bulk confirmation card. This call changed nothing.',
  code: 'owner_direct_bulk_limit',
  note: 'Use the bulk tool so the owner gets ONE card: bulk_update_customers, bulk_update_leads, move_stops_to_day, or one assign_technician call listing every stop. If no bulk tool fits, list the records still to change in one line and do them in a follow-up request.',
});

const BULK_LIMIT_RESULT_V2 = Object.freeze({
  ...BULK_LIMIT_RESULT,
  error: `More than ${DIRECT_EDITS_V2} edits with the same tool in one request need one bulk confirmation card. This call changed nothing.`,
});
// The wording follows the threshold that tool is held to: a lead edit keeps the
// old cap of three even with the gate on (Codex #6369 r3).
// No tool named: the gate-wide wording, as before; a named tool gets its own limit.
const bulkLimitResult = (toolName) => {
  const v2 = toolName === undefined ? ibTargetRulesV2Live() : directCapThreshold(toolName) === DIRECT_EDITS_V2 + 1;
  return v2 ? BULK_LIMIT_RESULT_V2 : BULK_LIMIT_RESULT;
};

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

// Appended after OWNER_DIRECT_PROMPT while GATE_IB_TARGET_RULES_V2 is on.
const OWNER_DIRECT_TARGET_RULES_PROMPT = `

CUSTOMER NAMED OR ON SCREEN:
- An edit on a customer executes directly only when the owner named that customer in this message (a name, phone or email they typed) or that customer is the one on screen. A customer you found yourself, for example from a call log or a search, shows a one-tap card: prepare it and say "tap Confirm".
- Up to ${DIRECT_EDITS_V2} edits with the same tool in one request execute directly. More than that needs the bulk tool.`;

const OWNER_DIRECT_PROMPT = `

OWNER MODE (overrides the sections above where they differ):
You are talking to the owner. Do what they ask.
- Internal edits execute the moment you call the tool — no confirmation card: ${[...OWNER_DIRECT_TOOL_NAMES].join(', ')}. (update_customer executes directly for name, lead source, and notes when the customer has none yet; any address field (street, unit, city, state, ZIP) on a customer, property or lead always shows a card with the exact address — notes REPLACE the existing notes, so over existing notes it shows a card naming what is deleted: include the existing text if the owner asked to add a line; a phone, email, tier, rate, active or pipeline-stage change still shows a card. Lead edits execute directly when you pass lead_id alone — never lead_id with lead_name. A property edit (label, occupancy, relationship; it takes no address) executes directly unless it sets a label; add_customer_property is not on this list: a property add always shows its card with the exact address. assign_technician executes directly for one ungrouped stop when technician_name is the technician's full name; reschedule_appointment for one ungrouped stop; grouped visits, several stops and a partial name show a card. Three or more edits with the same tool in one request are refused as a set: for three or more records use the bulk tool, which shows one card.) When the result says executed: true, say what changed in one short line. Never tell the owner to confirm these.
- Customer messages, money and bulk changes still show a one-tap card. Prepare it and say "tap Confirm" — nothing more.
- Pick the record yourself from fresh lookups and pass its id: "the Murphy lead that came in today" is the Murphy lead created today. Use the phone, email, date, status or page record the owner gave to choose. Only when two records fit equally, ask ONE short question that lists the choices in a few words each.
- A second name in a request (a technician, a spouse, a neighbor) is context, not a second target.
- A refused or failed lookup is not "tools erroring". Try another lookup or a different selector first. Report a failure only when nothing worked, in one sentence.
- Never send the owner to another screen, never explain limitations, never apologize. If something truly cannot be done from here, say so in one sentence and offer the closest thing you can do.
- Replies: 1–3 short lines. No preamble, no recap of the request, no "anything else?". Lists and numbers only when the owner asked for data.`;

// The owner prompt states exactly one direct-edit limit: today's (three or more
// refused) while GATE_IB_TARGET_RULES_V2 is off, the new one (more than 5) while on.
const LIMIT_SENTENCE_OFF = 'Three or more edits with the same tool in one request are refused as a set: for three or more records use the bulk tool, which shows one card.';
// The tools that keep the three-edit cap with the gate on are derived from
// directCapThreshold, so the sentence cannot drift from the cap (Codex #6369 r8).
const limitSentenceOn = () => {
  const stricter = [...OWNER_DIRECT_TOOL_NAMES].filter(name => directCapThreshold(name) === DIRECT_CAP);
  return `More than ${DIRECT_EDITS_V2} edits with the same tool in one request are refused as a set: for more than ${DIRECT_EDITS_V2} records use the bulk tool, which shows one card. These tools keep the stricter limit, three or more in one request are refused: ${stricter.join(', ')}.`;
};
function ownerDirectPrompt() {
  return ibTargetRulesV2Live() ? OWNER_DIRECT_PROMPT.replace(LIMIT_SENTENCE_OFF, limitSentenceOn()) : OWNER_DIRECT_PROMPT;
}

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

module.exports = { TRUSTED_READS, looksLikeChoiceReply, isChoiceLabelShape, noteSameNameContext, markSameNameChoices, sameNameMarkerNeeded, ownerDirectPrompt, dynamicCapReached, targetGrounding, bulkLimitResult, OWNER_DIRECT_TARGET_RULES_PROMPT, DIRECT_EDITS_V2, loadRequestTaint, newRequestTaint, noteUntrustedRead, untrustedReadInHistory, OWNER_DIRECT_TOOL_NAMES, DIRECT_CUSTOMER_FIELDS, DIRECT_CAP, BULK_LIMIT_RESULT, ownerDirectLive, executesWithoutCard, mayExecuteWithoutCard, seedDirectCounts, messageDirectPlan, cappedTools, recordDirectCommit, directModelResult, runDirectCommit, OWNER_DIRECT_PROMPT, OWNER_DIRECT_CARDED_PROMPT };
