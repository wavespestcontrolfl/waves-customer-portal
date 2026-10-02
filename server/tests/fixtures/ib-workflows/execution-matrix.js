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


// Owner cells (gate on) where owner-direct.js differs from the scope hypothesis,
// as "tool:owner". The full cell is compared, condition included: a scope
// "direct" against a code "direct when <condition>" is a difference, because the
// condition decides whether the workflow's own request goes without a card.
//   - switch_appointment_property, save_customer_estimate: the scope expected
//     direct; the merged policy keeps a card (a property move on a grouped
//     visit relocates every service line sharing it; the estimate writers are
//     money)
//   - add_customer_property, update_customer_property: direct only with no
//     label, so W4's own "label it rental" request keeps its card
//   - update_customer: direct only for contact, address, lead source and note
//     fields; email and pipeline stage keep the card (the scope named name,
//     phone and address)
//   - update_lead_contact: direct only by lead_id alone, never by name
//   - reschedule_appointment: direct only when the pinned visit is ungrouped
const OWNER_KNOWN_DIFFERENCES = [
  'switch_appointment_property:owner',
  'save_customer_estimate:owner',
  'add_customer_property:owner',
  'update_customer_property:owner',
  'update_customer:owner',
  'update_lead_contact:owner',
  'reschedule_appointment:owner',
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
    const ownerMark = differs(r.owner, r.actual.ownerOn) ? ' (differs)' : '';
    const adminMark = differs(r.admin, r.actual.admin) ? ' (differs)' : '';
    const techMark = differs(r.tech, r.actual.tech) ? ' (differs)' : '';
    lines.push(`| ${r.workflow} | \`${r.tool}\` | ${r.actual.cls} | ${r.owner} | ${r.actual.ownerOn}${ownerMark} | ${r.actual.ownerOff} | ${r.admin} | ${r.actual.admin}${adminMark} | ${r.tech} | ${r.actual.tech}${techMark} |`);
  }
  return lines.join('\n');
}

module.exports = {
  MATRIX, KNOWN_DIFFERENCES, OWNER_KNOWN_DIFFERENCES, OWNER_DIRECT_CONDITIONS,
  computeActual, renderTable, differs, ownerPolicyProbe, ownerGateOnCell,
};
