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
// timings) — excluded from both the card and the fingerprint.
const VOLATILE_KEY_RE = /(_at$|^at$|timestamp|generated|elapsed|duration|took|_ms$|latency|request_id|trace)/i;
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
const CUSTOMER_CONTACT_TOOL_NAMES = new Set([
  'send_sms',
  'reply_via_sms',
  'send_email_reply',
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
    ['comms', 'Texts a summary to the admin phone — internal alert, not a customer message'],
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
  // Pinned recipient (send_sms, reply_via_sms, trigger_review_request pin a
  // phone; send_email_reply pins the email the reply goes to).
  if (preview?.pinned_recipient && (toolName === 'send_sms' || toolName === 'reply_via_sms' || toolName === 'trigger_review_request')) {
    const verb = toolName === 'trigger_review_request' ? 'Send review request to' : 'Text';
    push('comms', `${verb} ${preview.pinned_recipient.name} (…${preview.pinned_recipient.phone_last4 || '????'})`);
  }
  if (toolName === 'send_email_reply' && preview?.pinned_recipient) {
    push('comms', `Email reply to ${preview.pinned_recipient.email_masked || 'the sender'}${preview.pinned_recipient.subject ? ` — re: ${preview.pinned_recipient.subject}` : ''}`);
  }
  if (toolName === 'create_appointment' && preview?.pinned_technician) {
    push('operational', `Assigned to ${preview.pinned_technician.name}`);
  }
  if (toolName === 'reschedule_appointment' && preview?.pinned_appointment) {
    const a = preview.pinned_appointment;
    const from = `${a.scheduled_date || '?'}${a.time_window ? ` ${a.time_window}` : ''}`;
    const to = `${params?.new_date || '?'}${params?.new_time_window ? ` ${params.new_time_window}` : ''}`;
    push('operational', `Move ${a.service_type || 'visit'}${a.customer_name ? ` for ${a.customer_name}` : ''} (${a.status || 'scheduled'}) from ${from} → ${to}`, {
      before: from, after: to,
    });
    // A LIVE visit (tech en route / on site) is more than a date move: the
    // executor resets it to confirmed, releases tech/tracker state, and
    // appends lifecycle history — the active field workflow ends.
    if (a.status === 'en_route' || a.status === 'on_site') {
      push('operational', `Ends the active field workflow: status ${a.status} → confirmed, technician/tracker state released, lifecycle history appended`, {
        before: a.status, after: 'confirmed',
      });
    }
  }
  if (toolName === 'bulk_update_leads') {
    push('customer', `${(params?.lead_ids || []).length} leads: ${params?.current_status} → ${params?.new_status}`, {
      before: params?.current_status, after: params?.new_status,
    });
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
    if (preview?.inspection_credit) push('billing', 'No inspection credit is redeemed by this booking — it is excluded from credit redemption (verified again at commit)');
    push('operational', 'Registers the 72h/24h reminder rows (sent later by the reminder schedule; a registration failure is reported as a warning on this card); no confirmation text is sent now');
  }
  if (toolName === 'bulk_update_customers') {
    push('customer', 'Applies to each listed customer that still resolves at commit — any skipped customer is reported as a warning on this card, never a silent Done');
  }
  for (const [kind, label] of JOB_EFFECTS[toolName] || []) push(kind, label);
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
  if (isCustomerUpdate && params?.updates?.email) {
    const n = toolName === 'bulk_update_customers' ? (params?.customer_ids || []).length : 1;
    push('customer', `${n > 1 ? `For each of ${n} customers: ` : ''}${require('../customer-email-fanout').EMAIL_FANOUT_DISCLOSURE}`);
  }
  // Billing-lane stamp (#3140): the executors stamp billing_mode
  // 'monthly_membership' on any affected row the update leaves with a
  // membership tier + positive monthly rate and no billing lane, and notify
  // the owner. Disclose whenever the update touches those fields — the
  // executor's own documented contract.
  if (isCustomerUpdate
    && (params?.updates?.waveguard_tier !== undefined || Number(params?.updates?.monthly_rate) > 0)) {
    push('billing', "Any affected customer left with a membership tier + positive monthly rate and no billing lane gets billing_mode stamped 'monthly_membership' in the same write, and the owner is notified to verify the lane");
  }

  // Name/phone fan-out runs on the single-customer path only (the bulk
  // executor propagates email alone) — disclose exactly what runs.
  if (toolName === 'update_customer'
    && (params?.updates?.first_name !== undefined || params?.updates?.last_name !== undefined || params?.updates?.phone !== undefined)) {
    push('customer', require('../customer-contact-fanout').CONTACT_FANOUT_DISCLOSURE);
  }

  // An email change may immediately re-send the newsletter double-opt-in
  // confirmation to the customer (updateCustomer → resendPendingConfirmation
  // when the fan-out finds a pending confirmation) — a customer-facing send.
  const emailChangeMayContact = toolName === 'update_customer' && !!params?.updates?.email;
  if (emailChangeMayContact) {
    push('comms', 'If a newsletter confirmation is pending for this customer, the double-opt-in email is re-sent to the NEW address immediately');
  }
  const notifiesCustomer = toolName === 'move_stops_to_day'
    ? params?.notify_customers === true
    : (CUSTOMER_CONTACT_TOOL_NAMES.has(toolName) || emailChangeMayContact);
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
    // Proposal-time pins the confirm re-checks (recipient phone/email,
    // appointment state) also bind the hash so the card can't drift.
    ...(preview?.pinned_recipient ? { pinned_recipient: preview.pinned_recipient } : {}),
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
  if (Array.isArray(value)) return value.map((v) => normalizePreview(v, depth + 1));
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
  buildContract,
  contractHash,
  previewFingerprint,
  IRREVERSIBLE_TOOL_NAMES,
  CUSTOMER_CONTACT_TOOL_NAMES,
};
