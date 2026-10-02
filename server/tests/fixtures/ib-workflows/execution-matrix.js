/**
 * Execution-mode matrix for the ten Intelligence Bar workflows (scope doc
 * Part 2, section 2.3), reduced to the tools it names, plus the capability
 * gaps and the write-call policy the manifests are checked against.
 *
 * What is asserted: what THIS branch implements, read from the action
 * registry (action-registry.js), write-gates.js, its technician rules and
 * owner-direct.js (#5563, merged). The owner cells are DERIVED from
 * owner-direct.js: OWNER_DIRECT_TOOL_NAMES says which tools can execute
 * without a card, executesWithoutCard() says when, and the probes below
 * prove each recorded condition against it. A scope-expected cell that
 * differs from the cell on this branch is a finding, listed in
 * KNOWN_DIFFERENCES / OWNER_KNOWN_DIFFERENCES; it is never silently "fixed"
 * here.
 *
 * Gap keys (CAPABILITY_GAPS) name what a case's target behavior needs that is
 * not on this tree. A case that carries `requires` stays a scored target.
 */

// cls: read | two_step_card | bare_write_card
//   read            no approval, executes on call
//   two_step_card   structural preview then confirm (WRITE_TWO_STEP_TOOL_NAMES)
//   bare_write_card legacy executor, the route proposes a card from the params
//                   (LEGACY_BARE_WRITE_TOOL_NAMES)
// owner: scope-expected cell for the owner login with the gate on (direct | card);
//        the cell on this branch may add a condition ("direct when ...")
// admin: scope-expected cell for a non-owner admin (direct | card)
// tech:  scope-expected technician cell
//   refused | scoped (reachable, limited to own visits or own customers)
//   | n/a (the scope matrix does not name this tool for technicians)
const MATRIX = [
  { workflow: 'W1', tool: 'needs_me', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W1', tool: 'get_today_briefing', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_customer_detail', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_schedule_view', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_conversation_thread', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_open_commitments', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W3', tool: 'update_lead_contact', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W3', tool: 'update_customer', cls: 'bare_write_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'add_customer_property', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'update_customer_property', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'set_primary_property', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'switch_appointment_property', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W5', tool: 'find_available_slots', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W5', tool: 'create_appointment', cls: 'bare_write_card', owner: 'card', admin: 'card', tech: 'refused' },
  { workflow: 'W6', tool: 'reschedule_appointment', cls: 'bare_write_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W6/W7', tool: 'send_sms', cls: 'bare_write_card', owner: 'card', admin: 'card', tech: 'scoped' },
  { workflow: 'W7', tool: 'draft_sms', cls: 'read', owner: 'direct', admin: 'direct', tech: 'n/a' },
  { workflow: 'W7', tool: 'list_queued_messages', cls: 'read', owner: 'direct', admin: 'direct', tech: 'n/a' },
  { workflow: 'W7', tool: 'cancel_queued_message', cls: 'two_step_card', owner: 'card', admin: 'card', tech: 'n/a' },
  { workflow: 'W8', tool: 'get_customer_estimate_context', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W8', tool: 'compute_estimate', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W8', tool: 'save_customer_estimate', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W8', tool: 'get_estimate_detail', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W9', tool: 'get_outstanding_balances', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W9', tool: 'get_stripe_payment_intents', cls: 'read', owner: 'direct', admin: 'direct', tech: 'refused' },
  { workflow: 'W10', tool: 'query_stock', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'get_stock_movements', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'get_restock_queue', cls: 'read', owner: 'direct', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'adjust_stock', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W10', tool: 'update_restock_request', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
  { workflow: 'W10', tool: 'create_restock_request', cls: 'two_step_card', owner: 'direct', admin: 'card', tech: 'refused' },
];

// Cells where main differs from the scope hypothesis, as "tool:column".
// The technician column is the only one: the scope matrix expects some
// technician reach (own visits, own-visit customers, read-only inventory)
// that the registry on main does not grant, because every tool outside
// tech-tools.js has role 'admin'. A change here is a finding to report.
const KNOWN_DIFFERENCES = [
  'needs_me:technician',
  'get_today_briefing:technician',
  'get_customer_detail:technician',
  'get_schedule_view:technician',
  'get_conversation_thread:technician',
  'get_open_commitments:technician',
  'send_sms:technician',
  'query_stock:technician',
  'get_stock_movements:technician',
  'get_restock_queue:technician',
];


// Owner cells with the gate on (GATE_IB_OWNER_DIRECT, owner login, and the
// platform task GATE_IB_PLATFORM that direct commits ride on). 'direct when X'
// is a tool on OWNER_DIRECT_TOOL_NAMES whose executesWithoutCard() also reads
// the input or the proposal preview.
const OWNER_DIRECT_CONDITIONS = {
  update_lead_contact: 'lead_id alone',
  update_customer: 'only contact, address, lead source and note fields',
  add_customer_property: 'no label',
  update_customer_property: 'no label',
  reschedule_appointment: 'the pinned visit is ungrouped',
};

// Inputs and previews the policy is probed with. A tool is conditional when
// some probe executes without a card and another does not.
const PROBE_INPUTS = [
  {}, { lead_id: 'lead-x', first_name: 'Sample' }, { lead_name: 'Sample', first_name: 'Sample' },
  { customer_id: 'cust-x', updates: { phone: '555-0100', notes: 'x' } }, { customer_id: 'cust-x', updates: { email: 'a@example.invalid' } },
  { label: null }, { label: 'rental' }, { appointment_id: 'appt-x', new_date: '2030-01-01' },
];
const PROBE_PREVIEWS = [null, { pinned_appointment: { id: 'appt-x' } }, { pinned_appointment: { id: 'appt-x', visit_id: 'visit-x' } }];

function ownerPolicyProbe(ownerDirect, tool) {
  const results = new Set();
  for (const input of PROBE_INPUTS) for (const preview of PROBE_PREVIEWS) results.add(ownerDirect.executesWithoutCard(tool, input, preview));
  return { canBeDirect: results.has(true), canBeCard: results.has(false) };
}

// 'direct' | 'direct when <condition>' | 'card', from owner-direct.js.
function ownerGateOnCell(ownerDirect, tool) {
  if (!ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(tool)) return 'card';
  const p = ownerPolicyProbe(ownerDirect, tool);
  if (!p.canBeCard) return 'direct';
  return `direct when ${OWNER_DIRECT_CONDITIONS[tool] || 'UNDOCUMENTED CONDITION'}`;
}

const baseCell = (cell) => String(cell).replace(/ when .*$/, '');

// Owner cells (gate on) where owner-direct.js differs from the scope hypothesis,
// as "tool:owner". The scope expected both to execute without a card; the
// merged policy keeps a card on them (switch_appointment_property relocates
// every service line sharing a visit; the estimate writers are money).
const OWNER_KNOWN_DIFFERENCES = [
  'switch_appointment_property:owner',
  'save_customer_estimate:owner',
];

function classify(name, action, gates) {
  if (!action) return 'missing';
  if (gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)) return 'two_step_card';
  if (gates.LEGACY_BARE_WRITE_TOOL_NAMES.has(name)) return 'bare_write_card';
  return action.approval === null && action.kind === 'read' ? 'read' : 'unclassified';
}

// Actual cells on this branch. registry is action-registry.js, gates is
// write-gates.js, ownerDirect is owner-direct.js.
function computeActual(registry, gates, ownerDirect) {
  return MATRIX.map((row) => {
    const action = registry.actions.get(row.tool);
    const cls = classify(row.tool, action, gates);
    const adminAllowed = !!action && registry.allowed(action, { role: 'admin', context: 'platform', fullAccess: false });
    const ownerAllowed = !!action && registry.allowed(action, { role: 'admin', context: 'platform', fullAccess: true });
    const techAllowed = !!action && registry.allowed(action, { role: 'technician' });
    const adminCell = !adminAllowed ? 'refused' : cls === 'read' ? 'direct' : 'card';
    // Gate off, the owner is an ordinary admin; gate on, owner-direct.js decides.
    const ownerOffCell = !ownerAllowed ? 'refused' : adminCell;
    const ownerOnCell = !ownerAllowed ? 'refused' : cls === 'read' ? 'direct' : ownerGateOnCell(ownerDirect, row.tool);
    const techCell = techAllowed ? 'scoped' : 'refused';
    return { ...row, action, actual: { cls, admin: adminCell, ownerOn: ownerOnCell, ownerOff: ownerOffCell, tech: techCell, kind: action && action.kind, role: action && action.role } };
  });
}

function differs(expected, actual) {
  return expected !== 'n/a' && expected !== actual;
}

function renderTable(rows) {
  const lines = [
    '| Workflow | Tool | Class on main | Owner gate on, scope | Owner gate on, main | Owner gate off, main | Admin, scope | Admin, main | Technician, scope | Technician, main |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const ownerMark = differs(r.owner, baseCell(r.actual.ownerOn)) ? ' (differs)' : '';
    const adminMark = differs(r.admin, r.actual.admin) ? ' (differs)' : '';
    const techMark = differs(r.tech, r.actual.tech) ? ' (differs)' : '';
    lines.push(`| ${r.workflow} | \`${r.tool}\` | ${r.actual.cls} | ${r.owner} | ${r.actual.ownerOn}${ownerMark} | ${r.actual.ownerOff} | ${r.admin} | ${r.actual.admin}${adminMark} | ${r.tech} | ${r.actual.tech}${techMark} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Capability gaps. A case whose target behavior needs something that is not on
// this tree carries `requires: "<key>"` (or an array of keys) and stays a
// scored target. `adds` lists what the gap would add to the tool schemas the
// write-call check reads: a new tool, or properties and enum values on an
// existing one. Nothing outside `adds` may differ from the schemas on main.
const CAPABILITY_GAPS = {
  series_reschedule_writer: {
    what: 'A tool that moves a whole recurring series. reschedule_appointment moves one row and refuses a recurring date move (COLLECTIVE_MOVE_REQUIRED); the series path is deferred to a follow-up PR.',
    owner_pr: 'follow-up named in reschedule_appointment (Intelligence Bar series moves)',
    adds: { tools: { reschedule_appointment_series: { properties: { appointment_id: {}, new_date: {}, new_time_window: {}, scope: { enum: ['series'] }, reason: {} } } } },
  },
  reschedule_notice_send: {
    what: 'A server-rendered reschedule notice: the move\'s own template text (appointment_rescheduled / appointment_series_rescheduled) on one card, built from the committed row. send_sms takes message_type manual, reminder, follow_up or billing_reminder and records freeform text.',
    owner_pr: 'PR 3c (move + notice, decision D1)',
    adds: { properties: { send_sms: { appointment_id: {}, message_type: { enum: ['appointment_rescheduled', 'appointment_series_rescheduled'] } } } },
  },
  create_appointment_property_pin: {
    what: 'A property pin on booking. create_appointment has no property_id and stores soleActivePropertyId(customer), which is null for a customer with two active properties.',
    owner_pr: 'PR 3b (W5 booking service, create_appointment gains property_id)',
    adds: { properties: { create_appointment: { property_id: {} } } },
  },
  estimate_measurement_selector: {
    what: 'A selector for which saved lawn measurement the estimate uses. save_customer_estimate takes customer, property, estimate and cadence only; the estimate body always derives one treatable_lawn_sqft from the selected property.',
    owner_pr: 'unassigned (W8 follow-up)',
    adds: { properties: { save_customer_estimate: { measurement_key: {} } } },
  },
  secondary_number_customer_link: {
    what: 'An authorized secondary contact number linked to the customer. sendSms compares the number with the customer\'s primary phone and clears the customer link when they differ, so the send is logged phone-only with no customer_id.',
    owner_pr: 'unassigned (W7 follow-up)',
    adds: {},
  },
  invoice_payment_reader: {
    what: 'The per-customer invoice, recorded-payment and credit reader (W9). No such reader exists on main.',
    owner_pr: '#5586 (PR 3a)',
    adds: {},
  },
};

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// Write calls. Every write step that commits names the call it would make:
// { tool, input, preview? }. input holds the key fields with synthetic values;
// preview holds the proposal facts owner-direct.js reads (pinned_appointment,
// stops). A case's `call` and a correction's `call` may be one call or a list
// for a compound step.
function callList(holder) {
  return asList(holder && holder.call);
}

// Does a step commit or propose a write? A truthful no-op or a refusal before
// any proposal does not.
const stepCommits = (step) => step.card === true || step.changes.length > 0 || step.sends > 0;

// What the schemas the bar sends to the model say about a call, with the
// gaps the case declares applied on top. Returns a list of problems.
function schemaProblems(call, registry, updatableCustomerFields, gapKeys) {
  const gaps = asList(gapKeys).map((k) => CAPABILITY_GAPS[k]).filter(Boolean);
  const addedTool = gaps.map((g) => g.adds && g.adds.tools && g.adds.tools[call.tool]).find(Boolean);
  const action = registry.actions.get(call.tool);
  if (!action && !addedTool) return [`tool ${call.tool} is not in the registry and no declared gap adds it`];
  const properties = { ...(action ? action.schema.properties : {}) };
  for (const [k, v] of Object.entries(addedTool ? addedTool.properties : {})) properties[k] = { ...(properties[k] || {}), ...v };
  for (const g of gaps) {
    for (const [k, v] of Object.entries((g.adds && g.adds.properties && g.adds.properties[call.tool]) || {})) {
      const prior = properties[k] || {};
      properties[k] = { ...prior, ...v, ...(v.enum ? { enum: [...new Set([...(prior.enum || []), ...v.enum])] } : {}) };
    }
  }
  const problems = [];
  for (const [key, value] of Object.entries(call.input || {})) {
    const spec = properties[key];
    if (!spec) { problems.push(`${call.tool}.${key} is not an input of the tool`); continue; }
    if (spec.enum && !spec.enum.includes(value)) problems.push(`${call.tool}.${key} = ${JSON.stringify(value)} is outside the enum ${JSON.stringify(spec.enum)}`);
    const types = asList(spec.type);
    if (types.length) {
      const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
      const ok = types.includes(kind) || (kind === 'integer' && types.includes('number'));
      if (!ok) problems.push(`${call.tool}.${key} is a ${kind}, the schema says ${types.join('|')}`);
    }
  }
  if (call.tool === 'update_customer' && call.input && call.input.updates && typeof call.input.updates === 'object') {
    for (const key of Object.keys(call.input.updates)) if (!updatableCustomerFields.includes(key)) problems.push(`update_customer.updates.${key} is not an updatable field`);
  }
  return problems;
}

// Is a card shown for these calls? Owner with the gate on: owner-direct.js
// decides per call (any carded call in a compound step shows its card).
// Every other actor or mode: a write always takes its card.
function expectedCard(c, calls, ownerDirect) {
  if (c.actor === 'owner' && c.mode === 'owner_direct_on') {
    return calls.some((k) => !ownerDirect.executesWithoutCard(k.tool, k.input, k.preview || null));
  }
  return true;
}

module.exports = {
  MATRIX, KNOWN_DIFFERENCES, OWNER_KNOWN_DIFFERENCES, OWNER_DIRECT_CONDITIONS, CAPABILITY_GAPS,
  computeActual, renderTable, differs, baseCell, ownerPolicyProbe, ownerGateOnCell,
  asList, callList, stepCommits, schemaProblems, expectedCard,
};
