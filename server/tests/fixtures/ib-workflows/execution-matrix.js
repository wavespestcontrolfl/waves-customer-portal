/**
 * Execution-mode matrix for the ten Intelligence Bar workflows (scope doc
 * Part 2, section 2.3), reduced to the tools it names.
 *
 * What is asserted: what THIS branch (main) implements, read from the action
 * registry (action-registry.js), write-gates.js and its technician rules.
 * What is only recorded: the owner-direct columns. Owner-direct (#5563) is not
 * merged, so those cells are the constant OWNER_DIRECT_PENDING and are never
 * asserted. A scope-expected cell that differs from the main cell is a
 * finding, listed in KNOWN_DIFFERENCES; it is never silently "fixed" here.
 */

const OWNER_DIRECT_PENDING = 'pending #5563';

// cls: read | two_step_card | bare_write_card
//   read            no approval, executes on call
//   two_step_card   structural preview then confirm (WRITE_TWO_STEP_TOOL_NAMES)
//   bare_write_card legacy executor, the route proposes a card from the params
//                   (LEGACY_BARE_WRITE_TOOL_NAMES)
// admin: scope-expected cell for a non-owner admin (direct | card)
// tech:  scope-expected technician cell
//   refused | scoped (reachable, limited to own visits or own customers)
//   | n/a (the scope matrix does not name this tool for technicians)
const MATRIX = [
  { workflow: 'W1', tool: 'needs_me', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W1', tool: 'get_today_briefing', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_customer_detail', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_schedule_view', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_conversation_thread', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W2', tool: 'get_open_commitments', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W3', tool: 'update_lead_contact', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W3', tool: 'update_customer', cls: 'bare_write_card', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'add_customer_property', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'update_customer_property', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'set_primary_property', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W4', tool: 'switch_appointment_property', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W5', tool: 'find_available_slots', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W5', tool: 'create_appointment', cls: 'bare_write_card', admin: 'card', tech: 'refused' },
  { workflow: 'W6', tool: 'reschedule_appointment', cls: 'bare_write_card', admin: 'card', tech: 'refused' },
  { workflow: 'W6/W7', tool: 'send_sms', cls: 'bare_write_card', admin: 'card', tech: 'scoped' },
  { workflow: 'W7', tool: 'draft_sms', cls: 'read', admin: 'direct', tech: 'n/a' },
  { workflow: 'W7', tool: 'list_queued_messages', cls: 'read', admin: 'direct', tech: 'n/a' },
  { workflow: 'W7', tool: 'cancel_queued_message', cls: 'two_step_card', admin: 'card', tech: 'n/a' },
  { workflow: 'W8', tool: 'get_customer_estimate_context', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W8', tool: 'compute_estimate', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W8', tool: 'save_customer_estimate', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W8', tool: 'get_estimate_detail', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W9', tool: 'get_outstanding_balances', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W9', tool: 'get_stripe_payment_intents', cls: 'read', admin: 'direct', tech: 'refused' },
  { workflow: 'W10', tool: 'query_stock', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'get_stock_movements', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'get_restock_queue', cls: 'read', admin: 'direct', tech: 'scoped' },
  { workflow: 'W10', tool: 'adjust_stock', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W10', tool: 'update_restock_request', cls: 'two_step_card', admin: 'card', tech: 'refused' },
  { workflow: 'W10', tool: 'create_restock_request', cls: 'two_step_card', admin: 'card', tech: 'refused' },
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

function classify(name, action, gates) {
  if (!action) return 'missing';
  if (gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)) return 'two_step_card';
  if (gates.LEGACY_BARE_WRITE_TOOL_NAMES.has(name)) return 'bare_write_card';
  return action.approval === null && action.kind === 'read' ? 'read' : 'unclassified';
}

// Actual cells on main. registry is action-registry.js, gates is write-gates.js.
function computeActual(registry, gates) {
  return MATRIX.map((row) => {
    const action = registry.actions.get(row.tool);
    const cls = classify(row.tool, action, gates);
    const adminAllowed = !!action && registry.allowed(action, { role: 'admin', context: 'platform', fullAccess: false });
    const ownerAllowed = !!action && registry.allowed(action, { role: 'admin', context: 'platform', fullAccess: true });
    const techAllowed = !!action && registry.allowed(action, { role: 'technician' });
    const adminCell = !adminAllowed ? 'refused' : cls === 'read' ? 'direct' : 'card';
    const ownerCell = !ownerAllowed ? 'refused' : cls === 'read' ? 'direct' : 'card';
    const techCell = techAllowed ? 'scoped' : 'refused';
    return { ...row, action, actual: { cls, admin: adminCell, owner: ownerCell, tech: techCell, kind: action && action.kind, role: action && action.role } };
  });
}

function differs(expected, actual) {
  return expected !== 'n/a' && expected !== actual;
}

function renderTable(rows) {
  const lines = [
    '| Workflow | Tool | Class on main | Owner, gate on | Owner, gate off | Admin, scope | Admin, main | Technician, scope | Technician, main |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const adminMark = differs(r.admin, r.actual.admin) ? ' (differs)' : '';
    const techMark = differs(r.tech, r.actual.tech) ? ' (differs)' : '';
    lines.push(`| ${r.workflow} | \`${r.tool}\` | ${r.actual.cls} | ${OWNER_DIRECT_PENDING} | ${OWNER_DIRECT_PENDING} | ${r.admin} | ${r.actual.admin}${adminMark} | ${r.tech} | ${r.actual.tech}${techMark} |`);
  }
  return lines.join('\n');
}

module.exports = { MATRIX, KNOWN_DIFFERENCES, OWNER_DIRECT_PENDING, computeActual, renderTable, differs };
