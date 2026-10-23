/**
 * Intelligence Bar — truck kit reads (docs/tool-inventory-tracker-scope.md
 * PR 3). Read-only: what rides on a truck, what a truck check found, which
 * tool alerts are open. No write tool; Equipment → Assets is the write path.
 * Live only with GATE_TRUCK_KIT (read at call time); off, every call answers
 * integration_disabled.
 */
const db = require('../../models/db');
const truckKit = require('../truck-kit');

const TRUCK_KIT_TOOLS = [
  {
    name: 'get_truck_kit',
    description: `What rides on a technician's truck: every item with its kit key and open missing/damaged alert, the last truck check and whether a check is due, and today's tool gaps. Pass technician_name for one truck; omit it for a one-line overview of every live truck.
Use for: "what's on Adam's truck?", "which trucks are overdue for a truck check?", "does the truck have a moisture meter?"`,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { technician_name: { type: ['string', 'null'], maxLength: 80, description: 'Technician name (partial match OK); null for every truck' } },
    },
  },
  {
    name: 'get_tool_issues',
    description: `Open truck-check tool alerts across the fleet: the tool, whether it is missing or damaged, the truck and technician, the technician's note and when it was reported.
Use for: "what tools are missing right now?", "any damaged tools?", "what did the truck checks find this week?"`,
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

const DISABLED = { error: 'Truck kit reads are off (GATE_TRUCK_KIT)', code: 'integration_disabled' };

async function executeTruckKitTool(name, input = {}) {
  if (!truckKit.truckKitEnabled()) return DISABLED;
  if (name === 'get_truck_kit') return getTruckKit(input.technician_name);
  if (name === 'get_tool_issues') return getToolIssues();
  return { error: 'Unknown truck kit read' };
}

function compactKit(status) {
  return {
    truck: status.truck,
    due: status.due, interval_days: status.intervalDays,
    last_check: status.lastCheck ? { at: status.lastCheck.checked_at, by: status.lastCheck.technician_name || null, missing: status.lastCheck.missing_count, damaged: status.lastCheck.damaged_count } : null,
    items: status.kit.map((k) => ({ name: k.name, category: k.category, kit_key: k.kit_key || null, open_issue: k.open_issue || null })),
    today_gaps: status.gaps,
  };
}

async function getTruckKit(technicianName) {
  const name = String(technicianName || '').trim();
  if (!name) return { trucks: await truckKit.trucksOverview(db) };
  // technicians carries one `name` column (customers are the table with
  // first_name / last_name).
  const matches = await db('technicians').where('name', 'ilike', `%${name}%`).orderBy('name').limit(5).select('id', 'name');
  if (!matches.length) return { error: `No technician matches "${name}"` };
  if (matches.length > 1) return { candidates: matches.map((t) => t.name), note: 'Ask which technician is meant.' };
  try {
    const status = await truckKit.truckKitStatus(matches[0].id);
    return { technician: matches[0].name, ...compactKit(status) };
  } catch (err) {
    if (err instanceof truckKit.TruckCheckError) return { technician: matches[0].name, error: err.message, code: err.code };
    throw err;
  }
}

async function getToolIssues() {
  const alerts = await truckKit.openToolAlerts(db);
  return {
    open: alerts.length,
    issues: alerts.map((a) => ({
      tool: a.name, kit_key: a.kit_key || null, issue: a.alert_type === 'tool_damaged' ? 'damaged' : 'missing',
      truck: a.vehicle_name || null, technician: a.technician_name || null, note: a.description || null, reported_at: a.created_at,
    })),
  };
}

module.exports = { TRUCK_KIT_TOOLS, executeTruckKitTool };
