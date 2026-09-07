/**
 * Intelligence Bar authorization contract (W0B — owner rulings 7–9,
 * 2026-08-31).
 *
 * A pending write is approved against a CONTRACT, not a sentence: a
 * server-built, deterministic description of exactly what the commit will
 * do — tier, action label, the effects list (operational / customer /
 * billing / comms), whether it can be undone, and whether a customer gets
 * contacted. It is derived ONLY from the curated display params and the
 * proposal-time preview pins (the same deterministic inputs the card
 * already trusts) — never from model-generated text.
 *
 * The contract is hashed; the card echoes the hash on Confirm and the claim
 * refuses a mismatch. One approval = one frozen effect set; anything new
 * (target, amount, recipient, effect) is a new proposal.
 *
 * Tiers surface the existing write-gate taxonomy rather than a new one:
 *   yellow — two-step / legacy-bare writes: one operator Confirm on the card
 *   red    — confirmed-endpoint writes (payouts, SEO pipeline): owner-only,
 *            confirmed:true + idempotency key on /execute, never a card
 *   green  — reads (never reach a card)
 * Charges/refunds/sensitive money movement have no IB tool at all
 * (blocked by absence — nothing to gate).
 */

const crypto = require('crypto');
const {
  WRITE_TWO_STEP_TOOL_NAMES,
  LEGACY_BARE_WRITE_TOOL_NAMES,
  CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES,
} = require('./write-gates');

const CONTRACT_VERSION = 1;

// Preview keys that are plumbing, not effects (the model-facing wrapper
// and the pins the contract already reads directly).
const PREVIEW_NOISE_KEYS = new Set([
  'proposal', 'tool', 'params', 'preview', 'pending_confirmation', 'note', 'success', 'error',
  'pinned_recipient', 'pinned_technician', 'pinned_lead', 'matches', 'action', 'cancellation',
]);
// Keys that legitimately differ between two identical previews (clocks,
// runtime timing metrics) — excluded from both the card and the
// fingerprint. Deliberately NARROW (pre-push P1): business durations
// (duration_minutes, estimated_duration_minutes) are scheduling state that
// alters occupancy/window effects and MUST stay hash-bound — only actual
// request-timing fields are volatile.
const VOLATILE_KEY_RE = /(_at$|^at$|timestamp|generated|elapsed|took_ms|_ms$|latency|request_id|trace)/i;
const PREVIEW_EFFECT_LINES = 12;
const PREVIEW_EFFECT_CHARS = 200;

// Tools whose commit cannot be undone from the portal (a message leaves,
// money moves, a public reply posts). Everything else is editable after.
const IRREVERSIBLE_TOOL_NAMES = new Set([
  'send_sms',
  'reply_via_sms',
  'send_email_reply',
  'trigger_review_request',
  'submit_review_reply',
  'request_instant_payout',
  'request_standard_payout',
  'run_seo_pipeline',
]);

// Tools whose commit itself sends a customer a message. Bookings, schedule
// moves and cancellations are deliberately NOT here: their executors
// move/log rows and register reminders with sendConfirmation:false — no
// customer message is sent by the confirm (reminder crons are separate,
// later, and disclosed as their own effect).
// move_stops_to_day is conditional on notify_customers and handled
// explicitly.
// send_email_reply is deliberately NOT here (GH r17 P2): the inbox holds
// vendor/partner/unattributed mail too, and a reply to those is not
// customer contact — the flag derives from the pinned email's customer
// attribution (preview.pinned_recipient.linked_customer) instead.
const CUSTOMER_CONTACT_TOOL_NAMES = new Set([
  'send_sms',
  'reply_via_sms',
  'trigger_review_request',
]);

// Legacy-bare jobs with no mutation-free preview: what the launch does is
// fixed and known, so the card states it explicitly (job launch, external
// spend, variable writes, internal comms) instead of an empty effect list.
const JOB_EFFECTS = {
  run_price_lookup: [
    ['operational', 'Launches the AI price-research job (paid web-search calls — external spend)'],
    ['billing', 'Inserts a runtime-dependent set of price_approvals rows for the approval queue (nothing is approved or purchased by this action)'],
  ],
  run_tax_advisor: [
    ['operational', 'Generates and stores a fresh AI tax-advisor report (15–30 s; paid model + search calls)'],
    // Conditional by the sender's own rules (GH r11 P2): tax-advisor.js
    // texts only when the report carries a high-severity compliance alert
    // or high-priority savings item, skips silently without ADMIN_PHONE,
    // and swallows provider failures — a routine report sends nothing, so
    // the card must not promise an unconditional SMS.
    ['comms', 'MAY text a summary to the admin phone — only if the report finds a high-severity compliance alert or high-priority savings item (internal alert, not a customer message; best-effort send)'],
  ],
};

const BILLING_TOOL_NAMES = new Set([
  'request_instant_payout',
  'request_standard_payout',
  'approve_price',
  'create_pending_estimate',
  'create_agent_estimate_draft',
  'set_estimate_presentation',
]);

const ACTION_LABELS = {
  send_sms: 'Send a text message',
  reply_via_sms: 'Reply by text',
  send_email_reply: 'Send an email reply',
  create_customer: 'Create a customer',
  update_customer: 'Update customer record',
  bulk_update_customers: 'Update multiple customers',
  update_property_access: 'Update property access notes',
  create_appointment: 'Book an appointment',
  reschedule_appointment: 'Move an appointment',
  cancel_appointment: 'Cancel an appointment',
  move_stops_to_day: 'Move stops to another day',
  assign_technician: 'Assign a technician',
  swap_tech_assignments: 'Swap technician assignments',
  optimize_all_routes: 'Re-optimize all routes',
  optimize_tech_route: 'Re-optimize a technician route',
  update_lead_status: 'Change a lead status',
  bulk_update_leads: 'Change status on multiple leads',
  submit_review_reply: 'Post a public review reply',
  trigger_review_request: 'Send a review request',
  block_sender: 'Block a sender',
  create_pending_estimate: 'Create an estimate',
  create_agent_estimate_draft: 'Save an estimate draft',
  set_estimate_presentation: 'Change estimate presentation',
  toggle_estimate_v2_view: 'Toggle estimate view',
  toggle_show_one_time_option: 'Toggle one-time option',
  run_price_lookup: 'Run a vendor price lookup',
  approve_price: 'Approve a vendor price',
  run_tax_advisor: 'Run the tax advisor',
  adjust_stock: 'Adjust inventory stock',
  create_restock_request: 'Create a restock request',
  update_restock_request: 'Update a restock request',
  request_instant_payout: 'Request an INSTANT payout',
  request_standard_payout: 'Request a standard payout',
  run_seo_pipeline: 'Run the SEO pipeline',
  approve_seo_action: 'Approve an SEO action',
};

function tierFor(toolName) {
  if (CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES.has(toolName)) return 'red';
  if (WRITE_TWO_STEP_TOOL_NAMES.has(toolName) || LEGACY_BARE_WRITE_TOOL_NAMES.has(toolName)) return 'yellow';
  return 'green';
}

// Operator-facing label for a tool in the activity list (what the bar
// checked / did on this exchange). Write tools use the curated card label;
// read tools fall back to the tool name as words. Never the model-facing
// TOOLS[].description — those are prompts, not labels.
function activityLabel(toolName) {
  if (ACTION_LABELS[toolName]) return ACTION_LABELS[toolName];
  const words = humanKey(toolName);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanKey(k) {
  // snake_case and camelCase both read as words on the card.
  return String(k).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function scalar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return null;
  return String(v);
}

// Render ANY curated value as a disclosure string. Nested objects and
// arrays of objects (e.g. engineInputs.services on an estimate draft) must
// never vanish from the contract — the card hides raw params once a
// contract exists, so the contract is the complete disclosure.
function describe(v, depth = 0) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => describe(x, depth + 1)).filter((x) => x !== null);
    return parts.length ? parts.join(', ') : null;
  }
  const parts = Object.entries(v)
    .filter(([k]) => !String(k).startsWith('_'))
    .map(([k, x]) => {
      const d = describe(x, depth + 1);
      return d === null ? null : `${humanKey(k)}: ${d}`;
    })
    .filter((x) => x !== null);
  if (!parts.length) return null;
  return depth === 0 ? parts.join('; ') : `{ ${parts.join('; ')} }`;
}

// Which lane an effect line belongs to, by tool + field name. Deterministic
// and intentionally coarse — the card groups by kind; the wording is the
// curated display param itself.
function kindFor(toolName, key) {
  const k = String(key).toLowerCase();
  if (/(sms|text|message|email|recipient|reply|notify)/.test(k)) return 'comms';
  if (BILLING_TOOL_NAMES.has(toolName) || /(price|monthly|annual|one_time|amount|fee|payout|discount)/.test(k)) return 'billing';
  if (/(customer|lead|name|phone|address|access|status)/.test(k)) return 'customer';
  return 'operational';
}

/**
 * Build the contract for a proposal.
 *  - displayParams: output of the route's confirmationDisplayParams (curated,
 *    pinned identities by name, never `_`-prefixed internals)
 *  - preview: the proposal-time preview (pins, before/after where known)
 */
const CUSTOMER_UPDATE_TOOL_NAMES = new Set(['update_customer', 'bulk_update_customers']);
// address_line2 included (GH r14 P2): a unit/apartment-only edit runs the
// same executor fan-out (addressSubmitted in both customer executors), so
// it carries the same derived-effect disclosure.
const ADDRESS_UPDATE_KEYS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

// Derived writes the lead-status executors perform BESIDE the status column
// (GH r10 P2): the transition mirrors onto the lead's ad_service_attribution
// funnel row via the monotonic bridge (attribution reporting moves), and a
// lead_activities status-change row is appended (audit history) — both in the
// single (leads-tools updateLeadStatus) and bulk paths. The exact-effects
// contract must disclose them, keyed off the SAME status→stage mapping the
// bridge consumes so the disclosure fires exactly when the funnel write does.
function pushLeadStatusDerivedEffects(push, newStatus, { bulk = false } = {}) {
  const { LEAD_STATUS_TO_FUNNEL_STAGE } = require('../lead-funnel-bridge');
  const stage = LEAD_STATUS_TO_FUNNEL_STAGE[newStatus];
  const each = bulk ? 'each lead' : 'the lead';
  if (stage) {
    // Conditional, not promised (GH r13 P2): the bridge is update-only and
    // best-effort — a lead with no linked ad_service_attribution row is a
    // no-op, and a bridge failure surfaces as a result warning.
    push('operational', `If ${each} has a linked ad-attribution row, its funnel stage advances toward '${stage}' (monotonic — never downgraded; a bridge failure surfaces as a warning); a status-change entry is appended to ${each}'s activity history`);
  } else {
    push('operational', `Appends a status-change entry to ${each}'s activity history`);
  }
}

function buildContract({ toolName, params, displayParams, preview, summary }) {
  const effects = [];
  const seen = new Set();
  const push = (kind, label, extra = {}) => {
    const key = `${kind}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    effects.push({ kind, label, ...extra });
  };
  // A null in a customer `updates` map is a WRITE (the field is cleared) —
  // it must render as an effect, never vanish like an absent value.
  if (CUSTOMER_UPDATE_TOOL_NAMES.has(toolName) && displayParams?.updates && typeof displayParams.updates === 'object') {
    displayParams = {
      ...displayParams,
      updates: Object.fromEntries(Object.entries(displayParams.updates).map(([k, v]) => [k, v === null ? '(cleared)' : v])),
    };
  }

  // Before/after pins the proposal already resolved deterministically.
  if (toolName === 'update_lead_status' && preview?.pinned_lead) {
    push('customer', `Lead ${preview.pinned_lead.name}: status ${preview.pinned_lead.current_status} → ${params?.new_status}`, {
      before: preview.pinned_lead.current_status, after: params?.new_status,
    });
    pushLeadStatusDerivedEffects(push, params?.new_status);
  }
  // Pinned recipient (send_sms, reply_via_sms, trigger_review_request pin a
  // phone; send_email_reply pins the email the reply goes to).
  if (preview?.pinned_recipient && (toolName === 'send_sms' || toolName === 'reply_via_sms' || toolName === 'trigger_review_request')) {
    const verb = toolName === 'trigger_review_request' ? 'Send review request to' : 'Text';
    push('comms', `${verb} ${preview.pinned_recipient.name} (…${preview.pinned_recipient.phone_last4 || '????'})`);
  }
  // Replying by SMS to an email also changes inbox state: the source email
  // is marked read and stamped auto_action 'replied_via_sms' (GH r8 P2) —
  // an operational effect on the thread, not just an outbound text.
  if (toolName === 'reply_via_sms' && params?.email_id) {
    push('operational', 'The source email is marked read and tagged replied-via-SMS in the inbox');
  }
  // Blocking scope, resolved exactly as the executor does (GH r8 P1): an
  // email address blocks that one sender; a bare domain blocks the whole
  // domain — the operator must see which one they are approving.
  if (toolName === 'block_sender') {
    const blockAddr = params?.email_address ? String(params.email_address).trim().toLowerCase() : null;
    const blockDom = !blockAddr && params?.domain
      ? String(params.domain).trim().toLowerCase().replace(/^@/, '') : null;
    // An existing same-scope block with a MISSING Gmail filter proposes as
    // a repair (GH r17 P2): the executor re-applies the filter onto the
    // existing row — the card must promise exactly that, not a new block.
    // (A fully intact existing block is refused at proposal, never a card.)
    const repair = params?._existing_block_repair === true;
    if (blockAddr) {
      push('operational', repair
        ? `${blockAddr} is already on the blocklist but its Gmail auto-trash filter is missing — re-applies the filter onto the EXISTING entry (no new blocklist row)`
        : `Auto-trash every future email from ${blockAddr} (Gmail filter + blocklist row); other senders at that domain are unaffected`);
    } else if (blockDom) {
      push('operational', repair
        ? `@${blockDom} is already on the blocklist but its Gmail auto-trash filter is missing — re-applies the filter onto the EXISTING entry (no new blocklist row)`
        : `Auto-trash every future email from ANY sender at @${blockDom} — the ENTIRE domain is blocked (refused for shared/protected provider domains)`);
    }
  }
  if (toolName === 'send_email_reply' && preview?.pinned_recipient) {
    push('comms', `Email reply to ${preview.pinned_recipient.email_masked || 'the sender'}${preview.pinned_recipient.subject ? ` — re: ${preview.pinned_recipient.subject}` : ''}`);
    if (preview.pinned_recipient.linked_customer === false) {
      push('comms', 'Sends to an EXTERNAL (non-customer) recipient — this inbox row is not attributed to a customer');
    }
  }
  if (toolName === 'create_appointment' && preview?.pinned_technician) {
    push('operational', `Assigned to ${preview.pinned_technician.name}`);
  }
  // Single-target mutations name the resolved human (GH r8 P1) — the card
  // hides raw params, so the uuid alone would leave the operator unable to
  // detect a wrong-customer selection before confirming.
  if (preview?.pinned_customer && (toolName === 'create_appointment' || toolName === 'update_customer')) {
    push('customer', `${toolName === 'create_appointment' ? 'Booked for' : 'Customer'}: ${preview.pinned_customer.name}`);
  }
  if (toolName === 'reschedule_appointment' && preview?.pinned_appointment) {
    const a = preview.pinned_appointment;
    const from = `${a.scheduled_date || '?'}${a.time_window ? ` ${a.time_window}` : ''}`;
    const to = `${params?.new_date || '?'}${params?.new_time_window ? ` ${params.new_time_window}` : ''}`;
    push('operational', `Move ${a.service_type || 'visit'}${a.customer_name ? ` for ${a.customer_name}` : ''} (${a.status || 'scheduled'}) from ${from} → ${to}`, {
      before: from, after: to,
    });
    // The move also appends a reschedule_log audit row (GH r16 P2) — a
    // derived write of every confirmed reschedule, so the exact-effects
    // card must carry it, and the executor surfaces a failed append as a
    // warning instead of a bare Done.
    push('operational', "A reschedule audit entry is appended to the visit's history after the move (a failed append surfaces as a warning)");
    // A LIVE visit (tech en route / on site) is more than a date move: the
    // executor resets it to confirmed, releases tech/tracker state, and
    // appends lifecycle history — the active field workflow ends.
    if (a.status === 'en_route' || a.status === 'on_site') {
      push('operational', `Ends the active field workflow: status ${a.status} → confirmed, technician/tracker state released, lifecycle history appended`, {
        before: a.status, after: 'confirmed',
      });
    } else if (a.track_rewind === true && params?.new_date && String(params.new_date) !== String(a.scheduled_date)) {
      // Evidence-only rewind on a non-live row (GH r8): a DATE move clears
      // stale tracker stamps + runs cleanup without a status change (the
      // executor's rewind is gated on the day actually changing).
      push('operational', 'Clears stale tracker evidence on this visit (tracker state released, cleanup run; no status change)');
    }
  }
  if (toolName === 'bulk_update_leads') {
    push('customer', `${(params?.lead_ids || []).length} leads: ${params?.current_status} → ${params?.new_status}`, {
      before: params?.current_status, after: params?.new_status,
    });
    pushLeadStatusDerivedEffects(push, params?.new_status, { bulk: true });
  }
  if (toolName === 'approve_price' && preview?.pinned_approval) {
    const a = preview.pinned_approval;
    const price = a.new_price != null ? `$${Number(a.new_price).toFixed(2)}` : 'the proposed price';
    if (params?.action === 'reject') {
      push('operational', `Reject the ${price} price for ${a.product_name || 'this product'}${a.vendor_name ? ` from ${a.vendor_name}` : ''} — no pricing changes`);
    } else {
      push('billing', `Approve ${price}${a.new_quantity ? ` / ${a.new_quantity}` : ''} for ${a.product_name || 'this product'}${a.vendor_name ? ` from ${a.vendor_name}` : ''} — applies vendor pricing, records price history, and recalculates the product's best price`);
    }
  }
  if ((toolName === 'toggle_estimate_v2_view' || toolName === 'toggle_show_one_time_option') && preview?.pinned_estimate) {
    const e = preview.pinned_estimate;
    const what = e.flag === 'use_v2_view' ? 'V2 estimate view' : 'one-time option';
    push('customer', `Estimate ${e.token || e.id}${e.customer_name ? ` (${e.customer_name})` : ''}: ${what} ${e.current ? 'on' : 'off'} → ${e.next ? 'on' : 'off'} (customer-facing)`, {
      before: e.current ? 'on' : 'off', after: e.next ? 'on' : 'off',
    });
  }
  for (const [kind, label] of JOB_EFFECTS[toolName] || []) push(kind, label);
  if (toolName === 'create_appointment') {
    // Booking money + follow-on effects (codex P0/P1 on #3648): the open
    // inspection credit is redeemed post-commit, and reminder rows are
    // registered now but send LATER via the reminder schedule — no
    // confirmation SMS goes out on Confirm.
    // Credit-bearing bookings are refused at proposal (the redemption is
    // claimed post-commit and by the hourly sweep — not pinnable), so a card
    // booking is always approved as credit-free and the executor verifies
    // that inside the booking transaction.
    if (preview?.inspection_credit) push('billing', 'No inspection credit is redeemed by this booking (no open credit; re-verified at commit under the credit lock offer creation shares)');
    push('operational', 'Registers the 72h/24h reminder rows (sent later by the reminder schedule; a registration failure is reported as a warning on this card); no confirmation text is sent now');
  }
  if (toolName === 'bulk_update_customers') {
    push('customer', 'Applies to each listed customer that still resolves at commit — any skipped customer is reported as a warning on this card, never a silent Done');
  }
  // A live (en_route/on_site) stop in a bulk move is more than a date move —
  // the commit resets it to confirmed, releases technician/tracker state,
  // and appends lifecycle history (codex r7 on #3648; same disclosure the
  // single-visit reschedule card carries). The stop statuses ride in the
  // preview, so the two-step fingerprint also binds them.
  if (toolName === 'move_stops_to_day' && Array.isArray(preview?.stops)) {
    const liveStops = preview.stops.filter((st) => st && (st.status === 'en_route' || st.status === 'on_site'));
    if (liveStops.length) {
      const who = liveStops.map((st) => `${st.customer || st.id} (${st.status})`).join(', ');
      push('operational', `Ends the active field workflow for ${liveStops.length} live stop(s) — ${who}: status resets to confirmed, technician/tracker state is released, lifecycle history is appended`);
    }
    // Evidence-only rewinds (GH r8 P1): stale tracker evidence on a
    // non-live stop is cleared by the move (tracker fields reset +
    // post-commit cleanup) without a status change — an input-dependent
    // lifecycle effect the operator is approving. The flag rides the
    // fingerprinted preview, so evidence appearing mid-pending is drift.
    const rewindStops = preview.stops.filter((st) => st && st.track_rewind);
    if (rewindStops.length) {
      const who = rewindStops.map((st) => String(st.customer || st.id)).join(', ');
      push('operational', `Clears stale tracker evidence on ${rewindStops.length} stop(s) — ${who}: tracker state is released and cleanup runs (no status change)`);
    }
    // Grouped moved stops (GH r18 P1): a sole-open-member grouped stop
    // passes eligibility, and the post-move seam then detaches it and
    // dissolves the empty group — disclosed, with membership bound in the
    // fingerprint (grouped_visit_id) and re-asserted by the confirmed pass.
    const groupedStops = preview.stops.filter((st) => st && st.grouped_visit_id);
    if (groupedStops.length) {
      const who = groupedStops.map((st) => String(st.customer || st.id)).join(', ');
      push('operational', `${groupedStops.length} moved stop(s) are the sole open member of a grouped visit — ${who}: the date move also detaches them from that visit and dissolves the now-empty group (a failed repair surfaces as a warning)`);
    }
    // Every moved stop also gets a reschedule_log audit append (GH r19
    // P2) — same disclosure the single-visit reschedule carries; a failed
    // append surfaces in the combined warning.
    push('operational', 'A reschedule audit entry is appended for each moved stop (a failed append surfaces as a warning)');
    // Pinned text recipients (GH r18 P1): with notify_customers the card
    // names each number (last4) the reschedule text goes to — the full
    // number binds the fingerprint and is enforced at the sender's final
    // recipient read.
    if (params?.notify_customers === true) {
      const who = preview.stops
        .map((st) => `${String(st.customer || st.id)} (${st.notify_phone_last4 ? `…${st.notify_phone_last4}` : 'no SMS recipient'})`)
        .join(', ');
      push('comms', `Reschedule texts go to: ${who}`);
    }
  }
  // Grouped stops in a reassignment get seam effects beyond the tech column
  // (GH r14 P1): after commit the visit-group seam either adopts the new
  // technician for the whole visit or detaches the child from its visit,
  // per the group's rules. Membership rides the fingerprinted preview
  // (grouped_visit_id), so joining/leaving a group mid-pending is drift,
  // and the executor re-asserts it pre-lock and under the tech-day locks.
  if (toolName === 'assign_technician' && Array.isArray(preview?.stops)) {
    const grouped = preview.stops.filter((st) => st && st.grouped_visit_id);
    if (grouped.length) {
      const who = grouped.map((st) => String(st.customer || st.id)).join(', ');
      push('operational', `${grouped.length} stop(s) belong to grouped visits — ${who}: the reassignment also updates grouped-visit membership (the visit adopts the new technician, or the stop detaches from its visit, per the group's rules; a failed repair surfaces as a warning)`);
    }
    // Route-order reset (GH r19 P2): a stop whose technician actually
    // changes loses its sequence number (NULL appends after the
    // destination day's ordered run until an optimizer places it) —
    // a scheduling mutation the operator is approving.
    const changing = preview.stops.filter((st) => st
      && String(st.current_tech || 'Unassigned') !== String(preview.would_assign_to || ''));
    if (changing.length && preview.would_assign_to) {
      push('operational', `${changing.length} stop(s) actually change technician — their route order is cleared (they append after the destination day's ordered run until the next optimization)`);
    }
  }
  // Same seam disclosure for whole-day swaps (GH r16 P1): the swap preview's
  // stops are an object keyed by technician name; grouped members carry
  // grouped_visit_id, which also binds the fingerprint and the executor's
  // under-lock membership compare.
  if (toolName === 'swap_tech_assignments' && preview?.stops && typeof preview.stops === 'object' && !Array.isArray(preview.stops)) {
    const allSwap = Object.values(preview.stops).flat().filter(Boolean);
    const grouped = allSwap.filter((st) => st.grouped_visit_id);
    if (grouped.length) {
      push('operational', `${grouped.length} swapped stop(s) belong to grouped visits: the swap also updates grouped-visit membership (each visit adopts the new technician, or the divergent stop detaches, per the group's rules; a failed repair surfaces as a warning)`);
    }
    // Both sides' route orders are cleared on reassignment (GH r19 P2) —
    // same scheduling mutation as assign_technician, disclosed.
    if (allSwap.length) {
      push('operational', "Every swapped stop's route order is cleared on both sides — stops append after each day's ordered run until the next optimization");
    }
  }
  if (toolName === 'cancel_appointment' && preview?.cancellation) {
    // The follow-through's money effects, from the rails' own previews.
    const c = preview.cancellation;
    const a = c.appointment || {};
    push('operational', `Cancel ${a.service_type || 'visit'} on ${a.scheduled_date || '?'}${a.customer_name ? ` for ${a.customer_name}` : ''}`, {
      before: a.status || null, after: 'cancelled',
    });
    // Wording states what the rails GUARANTEE, not the best case: a charge
    // may still land in review (office alerted), a hold may be parked for
    // the rebooked visit instead of released, and a void is skipped when
    // money is in flight or the invoice sits on a finalized statement.
    if (c.fee?.applies) {
      const amt = c.fee.amount != null ? `$${Number(c.fee.amount).toFixed(2)}` : 'the agreed';
      push('billing', c.fee.unresolved
        ? `A late-cancel fee MAY be charged to the card on file (${amt} — lane state could not be verified; unresolved outcomes go to office review)`
        : `Late-cancel fee of ${amt} will be charged to the card on file (a failed charge goes to office review, never silently dropped)`);
    } else if (c.fee?.rail === 'card_hold') {
      // Frozen disposition (pinned in the fingerprint), not a disjunction.
      push('billing', c.fee.hold_disposition === 'parked'
        ? 'No late-cancel fee (outside the fee window) — the card hold is PARKED for the rebooked visit'
        : 'No late-cancel fee (outside the fee window) — the card hold is RELEASED');
    } else if (c.fee?.rail && c.fee.rail !== 'none') {
      push('billing', 'No late-cancel fee (outside the fee window) — the appointment-card agreement is released');
    }
    for (const inv of c.invoices || []) {
      const total = inv.total != null ? `$${Number(inv.total).toFixed(2)}` : '';
      const credit = Number(inv.credit_applied) > 0 ? `; $${Number(inv.credit_applied).toFixed(2)} account credit restored` : '';
      push('billing', `Void invoice ${inv.invoice_number || inv.id} (${inv.status}${total ? `, ${total}` : ''}) — applied credits/deposits restored${credit}; skipped for office review if a payment is in flight or it sits on a finalized statement`);
    }
    if ((c.invoices || []).length) {
      push('billing', 'Only the invoices listed above are voided — anything created after this card is left for office review');
    }
  }

  // Two-step tools resolve the REAL target/state in their preview (the
  // product and before/after stock, the ordered stops, the record to be
  // created) — that resolution, not just the model's inputs, is what the
  // operator approves. Surface it (capped for the card; the fingerprint
  // below covers it exactly) alongside the display params.
  // Overflow/long lines are NOT dropped: the complete text lives in
  // more_effects (rendered under "Show more" on the card) and the whole
  // preview is hashed via preview_fingerprint.
  const moreEffects = [];
  // Bulk lead update: the operator approves the ACTUAL pinned set — every
  // name rides in full under "Show more", and the contract carries a
  // fingerprint of the complete id list (two sets with the same count and
  // first-ten names can never hash alike).
  if (toolName === 'bulk_update_leads' && Array.isArray(preview?.all_names) && preview.all_names.length) {
    for (const n of preview.all_names) moreEffects.push({ kind: 'customer', label: String(n) });
    push('customer', `All ${preview.all_names.length} lead names are listed under "Show more"`);
  }
  // Bulk customer update: same rule (codex r7 on #3648) — the card hides
  // raw params once a contract exists, so opaque UUIDs alone would leave
  // the operator unable to tell WHO gets edited. The route resolves every
  // pinned id to a name (fail-closed) and the full list rides here.
  if (toolName === 'bulk_update_customers' && Array.isArray(preview?.all_customer_names) && preview.all_customer_names.length) {
    for (const n of preview.all_customer_names) moreEffects.push({ kind: 'customer', label: String(n) });
    push('customer', `All ${preview.all_customer_names.length} customer names are listed under "Show more"`);
  }
  if (WRITE_TWO_STEP_TOOL_NAMES.has(toolName) && preview && typeof preview === 'object') {
    let shown = 0;
    for (const [k, v] of Object.entries(preview)) {
      if (PREVIEW_NOISE_KEYS.has(k) || String(k).startsWith('_') || VOLATILE_KEY_RE.test(k)) continue;
      const d = describe(v, 1);
      if (d === null) continue;
      const line = `${humanKey(k)}: ${d}`;
      const kind = kindFor(toolName, k);
      if (shown >= PREVIEW_EFFECT_LINES) { moreEffects.push({ kind, label: line }); continue; }
      if (line.length > PREVIEW_EFFECT_CHARS) {
        push(kind, `${line.slice(0, PREVIEW_EFFECT_CHARS - 1)}…`);
        moreEffects.push({ kind, label: line });
      } else {
        push(kind, line);
      }
      shown += 1;
    }
    if (moreEffects.length) push('operational', `(+${moreEffects.length} more — see "Show more"; pinned exactly, confirm re-checks them)`);
  }

  // Every curated display line is an effect the operator is approving —
  // one level of plain-object params flattens to its own lines (so an
  // update_customer card says WHAT changes), deeper structure is described
  // in full rather than dropped.
  for (const [k, v] of Object.entries(displayParams || {})) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (String(k2).startsWith('_')) continue;
        const s = describe(v2, 1);
        if (s !== null) push(kindFor(toolName, k2), `${humanKey(k2)}: ${s}`);
      }
      continue;
    }
    const s = describe(v, 1);
    if (s !== null) push(kindFor(toolName, k), `${humanKey(k)}: ${s}`);
  }

  // Deterministic ripples the Confirm also covers (customer-email-fanout /
  // customer-contact-fanout): an email/name/phone change syncs to other
  // surfaces. These are mandatory disclosures — encoded as effects, not
  // left in the free-text summary.
  const isCustomerUpdate = toolName === 'update_customer' || toolName === 'bulk_update_customers';
  // Field PRESENCE, not truthiness (GH r8 P2): the executors treat
  // `email !== undefined` as an email submission, so explicitly CLEARING an
  // email (null) runs the same fan-out and must carry the same disclosure.
  if (isCustomerUpdate && params?.updates?.email !== undefined) {
    const n = toolName === 'bulk_update_customers' ? (params?.customer_ids || []).length : 1;
    push('customer', `${n > 1 ? `For each of ${n} customers: ` : ''}${require('../customer-email-fanout').EMAIL_FANOUT_DISCLOSURE}`);
  }
  // Deterministic ripples of a customer update the executors always run —
  // disclosed so the card is the complete effect set. The open-artifact set
  // an address rewrite touches is resolved at commit (see Known limit).
  if (CUSTOMER_UPDATE_TOOL_NAMES.has(toolName)) {
    const upd = params?.updates && typeof params.updates === 'object' ? params.updates : {};
    if (ADDRESS_UPDATE_KEYS.some((k) => upd[k] !== undefined)) {
      push('customer', 'Address change also clears saved coordinates (re-geocoding is ATTEMPTED after commit, best-effort — a failure leaves coordinates empty until the next geocode pass), updates the primary property record, and rewrites the address on open leads/estimates that still match the OLD address (that set is resolved at commit)');
    }
    if (upd.pipeline_stage) {
      push('customer', `Stage → ${upd.pipeline_stage} also stamps lifecycle fields (active, member_since, churned_at/churn_reason, pipeline_stage_changed_at) derived from the customer's stage at commit`);
    }
  }
  // Billing-lane stamp (#3140): the executors stamp billing_mode
  // 'monthly_membership' on any affected row the update leaves with a
  // membership tier + positive monthly rate and no billing lane, and notify
  // the owner. Disclose whenever the update touches those fields — the
  // executor's own documented contract.
  if (isCustomerUpdate
    && (params?.updates?.waveguard_tier !== undefined || Number(params?.updates?.monthly_rate) > 0)) {
    push('billing', "Any affected customer left with a membership tier + positive monthly rate and no billing lane gets billing_mode stamped 'monthly_membership' in the same write, and an owner notification to verify the lane is attempted (best-effort — a notification failure is logged, the stamp itself stands)");
  }

  // Name/phone fan-out runs on the single-customer path only (the bulk
  // executor propagates email alone) — disclose exactly what runs.
  if (toolName === 'update_customer'
    && (params?.updates?.first_name !== undefined || params?.updates?.last_name !== undefined || params?.updates?.phone !== undefined)) {
    push('customer', require('../customer-contact-fanout').CONTACT_FANOUT_DISCLOSURE);
  }

  // Grouped-visit ripple of a reschedule (GH r12 P1): a pinned visit_id
  // only reaches a card when the row is the SOLE open member of its visit
  // (multi-member and frozen visits are refused at proposal) — the
  // executor's post-move seam then detaches the row and dissolves the
  // empty group. DATE moves only (GH r13 P2): a same-day window edit of a
  // sole member keeps the date matching its parent, so
  // handleChildStopChanged retains membership (empty sibling set counts
  // as overlapping) and just recomputes the visit window — no detach, no
  // dissolve, no disclosure. Same date-gate as the tracker-rewind effect
  // above. visit_id rides the appointment fingerprint either way, so a
  // membership change during the pending window drifts to preview_changed
  // instead of executing undisclosed.
  if (toolName === 'reschedule_appointment' && preview?.pinned_appointment?.visit_id) {
    if (params?.new_date && String(params.new_date) !== String(preview.pinned_appointment.scheduled_date)) {
      push('operational', 'This service is the sole open member of a grouped visit — the date move also detaches it from that visit and dissolves the now-empty group');
    } else {
      // Same-day edit (GH r17 P2): the seam KEEPS a date-matching sole
      // member grouped and recomputes the parent visit's time window from
      // its members — a service_visits write the card must still disclose.
      push('operational', "This service is the sole open member of a grouped visit — the edit also recomputes the parent visit's time window (membership is kept)");
    }
  }

  // An email change may re-send the newsletter double-opt-in confirmation
  // to the customer (updateCustomer → resendPendingConfirmation when the
  // fan-out finds a pending confirmation) — a customer-facing send. The
  // re-send is post-commit fire-and-forget BY CONTRACT (#3084 r47), so the
  // card must describe it as attempted, never promised (GH r12 P2): the
  // helper declines on a superseded confirmation, a do-not-contact or
  // suppression veto, a verification failure, or a delivery failure, and
  // the tool result does not report its outcome.
  const emailChangeMayContact = (toolName === 'update_customer' || toolName === 'bulk_update_customers') && !!params?.updates?.email;
  if (emailChangeMayContact) {
    push('comms', 'If a newsletter confirmation is pending for this customer, a re-send of the double-opt-in email to the NEW address is attempted after commit — best-effort: a do-not-contact/suppression veto, a superseded confirmation, or a delivery failure each stop it, and the result does not report whether it sent');
  }
  // Email replies contact the CUSTOMER only when the pinned inbox row is
  // attributed to one (GH r17 P2) — vendor/partner replies are outbound
  // mail, not customer contact.
  const emailReplyToCustomer = toolName === 'send_email_reply' && preview?.pinned_recipient?.linked_customer === true;
  const notifiesCustomer = toolName === 'move_stops_to_day'
    ? params?.notify_customers === true
    : (CUSTOMER_CONTACT_TOOL_NAMES.has(toolName) || emailReplyToCustomer || emailChangeMayContact);
  // "Will" only for tools whose whole point is the send; the conditional
  // double-opt-in path says "may" (GH r12 P2) — notifies_customer and the
  // irreversibility derivation stay conservative either way.
  if (notifiesCustomer) {
    let contactLabel = CUSTOMER_CONTACT_TOOL_NAMES.has(toolName) || emailReplyToCustomer || toolName === 'move_stops_to_day'
      ? 'Customer will be contacted'
      : 'Customer may be contacted (conditional double-opt-in re-send only)';
    // Derived from the PINNED recipient set for batch moves (GH r21 P2):
    // a stop pinned with no SMS recipient cannot be texted — the card
    // must not claim an impossible send and then warn about it after.
    if (toolName === 'move_stops_to_day' && Array.isArray(preview?.stops)) {
      const missing = preview.stops.filter((st) => st && !st.notify_phone_last4).length;
      if (missing && missing === preview.stops.length) {
        contactLabel = 'No stop has an SMS recipient — NO customers will be texted by this move';
      } else if (missing) {
        contactLabel = `Customers with a pinned SMS recipient will be texted; ${missing} stop(s) have no SMS recipient and will NOT be texted`;
      }
    }
    push('comms', contactLabel);
  }

  // Canonical order (kind, then label) so the contract — and therefore its
  // hash — never depends on param key order. The card groups by kind anyway.
  const KIND_RANK = { comms: 0, billing: 1, customer: 2, operational: 3 };
  effects.sort((x, y) => (KIND_RANK[x.kind] - KIND_RANK[y.kind]) || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));

  return {
    version: CONTRACT_VERSION,
    tool: toolName,
    tier: tierFor(toolName),
    action_label: ACTION_LABELS[toolName] || humanKey(toolName),
    effects,
    // Irreversibility is derived, not just allowlisted: anything that sends
    // an outbound message (customer texts on a notifying move, the tax
    // advisor's admin SMS) or spends externally (price research) cannot be
    // undone from the portal.
    irreversible: IRREVERSIBLE_TOOL_NAMES.has(toolName) || notifiesCustomer || toolName === 'run_tax_advisor' || toolName === 'run_price_lookup',
    notifies_customer: notifiesCustomer,
    summary: summary || null,
    ...(moreEffects.length ? { more_effects: moreEffects } : {}),
    ...(toolName === 'bulk_update_leads' && Array.isArray(params?.lead_ids)
      ? { targets_fingerprint: crypto.createHash('sha256').update(JSON.stringify([...params.lead_ids].map(String).sort())).digest('hex') }
      : {}),
    ...(toolName === 'bulk_update_customers' && Array.isArray(params?.customer_ids)
      ? { targets_fingerprint: crypto.createHash('sha256').update(JSON.stringify([...params.customer_ids].map(String).sort())).digest('hex') }
      : {}),
    // Proposal-time pins the confirm re-checks (recipient phone/email,
    // appointment state) also bind the hash so the card can't drift.
    ...(preview?.pinned_recipient ? { pinned_recipient: preview.pinned_recipient } : {}),
    ...(preview?.pinned_customer ? { pinned_customer: preview.pinned_customer } : {}),
    ...(preview?.pinned_appointment ? { pinned_appointment: preview.pinned_appointment } : {}),
    ...(preview?.pinned_approval ? { pinned_approval: preview.pinned_approval } : {}),
    ...(preview?.pinned_estimate ? { pinned_estimate: preview.pinned_estimate } : {}),
    // The card caps/truncates preview lines for presentation only — the
    // contract (and so its hash) still covers the COMPLETE resolved preview
    // through this fingerprint, so two plans that share a visible prefix
    // can never hash to the same contract.
    ...(WRITE_TWO_STEP_TOOL_NAMES.has(toolName) && preview && typeof preview === 'object'
      ? { preview_fingerprint: previewFingerprint(preview) }
      : {}),
  };
}

// Deterministic stringify (sorted keys) so the hash is stable across JSON
// property ordering — same approach as pending-actions.paramsHash.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contractHash(contract) {
  return crypto.createHash('sha256').update(stableStringify(contract)).digest('hex');
}

// Strip plumbing + volatile keys (recursively) so two previews of the same
// resolved effect set hash identically, and any real difference (target,
// order, amount, before/after state) does not.
function normalizePreview(value, depth = 0) {
  // Arrays are hashed as SETS: target lists come from SQL without ORDER BY,
  // so an unchanged set can arrive in a new order at confirm. Genuinely
  // ordered plans (route optimization) carry an explicit `position` on each
  // element, so order still binds through the element itself.
  if (Array.isArray(value)) {
    return value.map((v) => normalizePreview(v, depth + 1))
      .sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (String(k).startsWith('_') || VOLATILE_KEY_RE.test(k)) continue;
      if (depth === 0 && PREVIEW_NOISE_KEYS.has(k) && k !== 'matches' && k !== 'preview' && k !== 'action') continue;
      out[k] = normalizePreview(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Execution pin for two-step writes: the confirmed run re-resolves its
 * target from stored params, so the proposal-time preview is fingerprinted
 * and /confirm-action re-runs the preview and refuses on drift — one
 * approval = one exact resolved effect set (owner ruling 8).
 */
function previewFingerprint(preview) {
  return crypto.createHash('sha256').update(stableStringify(normalizePreview(preview || {}))).digest('hex');
}

module.exports = {
  CONTRACT_VERSION,
  tierFor,
  activityLabel,
  buildContract,
  contractHash,
  previewFingerprint,
  IRREVERSIBLE_TOOL_NAMES,
  CUSTOMER_CONTACT_TOOL_NAMES,
};
