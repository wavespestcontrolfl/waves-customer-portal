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

// Tools whose commit contacts a customer (directly, or via the automations
// that fire on schedule changes). move_stops_to_day is conditional on its
// notify_customers param and handled explicitly.
const CUSTOMER_CONTACT_TOOL_NAMES = new Set([
  'send_sms',
  'reply_via_sms',
  'send_email_reply',
  'trigger_review_request',
  'create_appointment',
  'reschedule_appointment',
  'cancel_appointment',
]);

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
function buildContract({ toolName, params, displayParams, preview, summary }) {
  const effects = [];
  const seen = new Set();
  const push = (kind, label, extra = {}) => {
    const key = `${kind}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    effects.push({ kind, label, ...extra });
  };

  // Before/after pins the proposal already resolved deterministically.
  if (toolName === 'update_lead_status' && preview?.pinned_lead) {
    push('customer', `Lead ${preview.pinned_lead.name}: status ${preview.pinned_lead.current_status} → ${params?.new_status}`, {
      before: preview.pinned_lead.current_status, after: params?.new_status,
    });
  }
  if (toolName === 'send_sms' && preview?.pinned_recipient) {
    push('comms', `Text ${preview.pinned_recipient.name} (…${preview.pinned_recipient.phone_last4 || '????'})`);
  }
  if (toolName === 'create_appointment' && preview?.pinned_technician) {
    push('operational', `Assigned to ${preview.pinned_technician.name}`);
  }
  if (toolName === 'bulk_update_leads') {
    push('customer', `${(params?.lead_ids || []).length} leads: ${params?.current_status} → ${params?.new_status}`, {
      before: params?.current_status, after: params?.new_status,
    });
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
    } else if (c.fee?.rail && c.fee.rail !== 'none') {
      push('billing', 'No late-cancel fee (outside the fee window) — the card hold is released, or parked for the rebooked visit when park-on-cancel is on');
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
  if (isCustomerUpdate && params?.updates?.email) {
    const n = toolName === 'bulk_update_customers' ? (params?.customer_ids || []).length : 1;
    push('customer', `${n > 1 ? `For each of ${n} customers: ` : ''}${require('../customer-email-fanout').EMAIL_FANOUT_DISCLOSURE}`);
  }
  // Name/phone fan-out runs on the single-customer path only (the bulk
  // executor propagates email alone) — disclose exactly what runs.
  if (toolName === 'update_customer'
    && (params?.updates?.first_name !== undefined || params?.updates?.last_name !== undefined || params?.updates?.phone !== undefined)) {
    push('customer', require('../customer-contact-fanout').CONTACT_FANOUT_DISCLOSURE);
  }

  const notifiesCustomer = toolName === 'move_stops_to_day'
    ? params?.notify_customers === true
    : CUSTOMER_CONTACT_TOOL_NAMES.has(toolName);
  if (notifiesCustomer) push('comms', 'Customer will be contacted');

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
    irreversible: IRREVERSIBLE_TOOL_NAMES.has(toolName),
    notifies_customer: notifiesCustomer,
    summary: summary || null,
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

module.exports = {
  CONTRACT_VERSION,
  tierFor,
  buildContract,
  contractHash,
  IRREVERSIBLE_TOOL_NAMES,
  CUSTOMER_CONTACT_TOOL_NAMES,
};
