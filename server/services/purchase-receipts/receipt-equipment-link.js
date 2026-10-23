/**
 * Receipt → equipment link (docs/tool-inventory-tracker-scope.md PR 3).
 *
 * When the inventory agent classes a purchase line as equipment while a tool
 * on a truck is reported missing or damaged, the office bell names that tool
 * and links to its Assets row; any other equipment line links to a new-row
 * dialog with the name filled in. The Assets save that carries
 * receipt_line_id writes purchase_receipt_lines.equipment_id, so the purchase
 * that replaced a tool is traceable from the line. Live only with
 * GATE_TRUCK_KIT; off, the agent rings its plain bell as before.
 */
const truckKit = require('../truck-kit');

const ASSETS_LINK = '/admin/equipment?tab=assets';
const TITLE_MAX = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_STATUS = 'agent_equipment';

// The bell body and link for an agent_equipment line, or null when the gate
// is off (the caller keeps its plain bell).
async function equipmentBellFor(conn, { lineId, line }) {
  if (!truckKit.truckKitEnabled()) return null;
  const title = String(line?.raw_title || '').trim();
  const alert = await truckKit.matchReceiptToOpenAlert(title, conn);
  if (alert) {
    const state = alert.alert_type === 'tool_damaged' ? 'damaged' : 'missing';
    const where = alert.vehicle_name ? ` on ${alert.vehicle_name}` : '';
    return {
      body: `"${title}" looks like equipment, not stock. ${alert.name} is reported ${state}${where}: open its row to record the replacement.`,
      link: `${ASSETS_LINK}&edit=${alert.equipment_id}&receipt_line=${lineId}`,
      equipmentId: alert.equipment_id,
    };
  }
  return {
    body: `"${title}" wasn't added: looks like equipment, not stock — add it to the equipment list if you're keeping it.`,
    link: `${ASSETS_LINK}&new=1&name=${encodeURIComponent(title.slice(0, TITLE_MAX))}&receipt_line=${lineId}`,
    equipmentId: null,
  };
}

// Locks the line for the save and says why it cannot take the link, or null.
// 'not-found': no such line, or not an equipment line; 'already-linked': it
// names another equipment row (a create has no row yet: any filed line is
// refused). The same row again is allowed (a retry).
async function claimReceiptLine(trx, lineId, equipmentId = null) {
  if (!UUID_RE.test(String(lineId || ''))) return 'not-found';
  const line = await trx('purchase_receipt_lines').where({ id: lineId }).forUpdate().first('id', 'status', 'equipment_id');
  if (!line || line.status !== LINE_STATUS) return 'not-found';
  if (line.equipment_id && line.equipment_id !== equipmentId) return 'already-linked';
  return null;
}

// Writes the link; the caller claimed the line first in the same transaction.
async function linkReceiptLine(trx, lineId, equipmentId) {
  await trx('purchase_receipt_lines').where({ id: lineId }).update({ equipment_id: equipmentId });
}

module.exports = { ASSETS_LINK, equipmentBellFor, claimReceiptLine, linkReceiptLine, UUID_RE };
