/**
 * Truck kit (GATE_TRUCK_KIT, dark): what rides on each truck, and a
 * technician's truck check (docs/tool-inventory-tracker-scope.md, PR 1).
 *
 * A technician's truck is the live equipment row with category 'vehicle'
 * assigned to them (the rule Bouncie mileage attribution already uses). The
 * truck's kit is every live equipment row whose assigned_vehicle_id is that
 * truck: the roster the office keeps on Equipment → Assets IS the kit
 * standard. A check records present / missing / damaged per item in ONE
 * equipment_checks row.
 *
 * Effects of a check: a missing or damaged item opens one maintenance alert
 * (tool_missing / tool_damaged; an alert already open for that item is
 * refreshed, never doubled); an item marked present closes its own open tool
 * alerts (found); a check with at least one issue rings ONE office bell per
 * truck through raiseAdminAlert, and the emitter closes that bell itself once
 * no tool alert on the truck is open (docs/admin-notifications.md section 4).
 * A clean check writes its row and nothing else. Nothing here changes an
 * item's status (marking a tool lost or retired stays an office action on the
 * alert, routes/admin-equipment-maintenance.js) and nothing contacts a
 * customer.
 */
const db = require('../models/db');
const logger = require('./logger');
const { truckKitLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { reportEquipmentIssue } = require('./equipment-maintenance');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { fitAction, tidyName } = require('./admin-alert-names');
const { truncateAtWord } = require('./ops-digest');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { normalizeKitKey } = require('./kit-key');

// A truck check is due this many days after the last one (owner decision 2,
// docs/tool-inventory-tracker-scope.md: weekly plus ad hoc).
const CHECK_INTERVAL_DAYS = 7;
const STATES = ['present', 'missing', 'damaged'];
const ALERT_TYPE = { missing: 'tool_missing', damaged: 'tool_damaged' };
const TOOL_ALERT_TYPES = Object.values(ALERT_TYPE);
const OPEN_ALERT_STATUSES = ['new', 'acknowledged'];
// A truck that is retired, sold or lost carries no kit.
const DEAD_VEHICLE_STATUSES = ['retired', 'sold', 'lost'];
// The rows expected on the truck. 'in_service' is the code-side synonym of
// active (equipment-maintenance.js checkMaintenanceDue reads both).
const KIT_STATUSES = ['active', 'in_service'];
const NOTE_MAX = 300;
// A visit still ahead of the technician today (mirrors the Schedule readiness
// poll, client/src/components/schedule/useDispatchReadiness.js).
const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
const CATEGORY = 'truck_kit';
const LINK = '/admin/equipment?tab=maintenance';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bellKey = (vehicleId) => `truck-kit:${vehicleId}`;

function truckKitEnabled() {
  return truckKitLive();
}

class TruckCheckError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function truckForTechnician(technicianId, conn = db) {
  if (!technicianId) return null;
  const row = await conn('equipment')
    .where({ category: 'vehicle', assigned_to: technicianId })
    .whereNotIn('status', DEAD_VEHICLE_STATUSES)
    .orderBy('name')
    .first('id', 'name', 'asset_tag');
  return row || null;
}

// The truck's kit with each item's open tool alert, if any, so the check
// defaults a still-missing tool to missing instead of silently finding it.
async function kitForTruck(vehicleId, conn = db) {
  const rows = await conn('equipment')
    .where({ assigned_vehicle_id: vehicleId })
    .whereIn('status', KIT_STATUSES)
    .orderBy([{ column: 'category' }, { column: 'name' }])
    .select('id', 'name', 'asset_tag', 'category', 'serial_number', 'condition_rating', 'kit_key');
  if (!rows.length) return [];
  const open = await conn('maintenance_alerts')
    .whereIn('equipment_id', rows.map((r) => r.id))
    .whereIn('alert_type', TOOL_ALERT_TYPES)
    .whereIn('status', OPEN_ALERT_STATUSES)
    .select('equipment_id', 'alert_type');
  const issueFor = new Map(open.map((a) => [a.equipment_id, a.alert_type === ALERT_TYPE.missing ? 'missing' : 'damaged']));
  return rows.map((r) => ({ ...r, open_issue: issueFor.get(r.id) || null }));
}

async function lastCheckForTruck(vehicleId, conn = db) {
  const row = await conn('equipment_checks as c')
    .leftJoin('technicians as t', 'c.technician_id', 't.id')
    .where('c.vehicle_id', vehicleId)
    .orderBy('c.checked_at', 'desc')
    .first('c.id', 'c.checked_at', 'c.item_count', 'c.missing_count', 'c.damaged_count', 't.name as technician_name');
  return row || null;
}

function checkDue(lastCheckedAt, now = new Date()) {
  if (!lastCheckedAt) return true;
  const at = new Date(lastCheckedAt).getTime();
  return !Number.isFinite(at) || now.getTime() - at >= CHECK_INTERVAL_DAYS * 86400000;
}

const parseGroups = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

// The tools a service line's checklists require, by kit key (PR 2). An item
// without a key, or marked optional, is display-only and never a gap.
async function requiredToolsForLine(serviceLine, conn = db) {
  if (!serviceLine) return [];
  const rows = await conn('equipment_checklists').where({ service_line: serviceLine }).select('checklist_items');
  const byKey = new Map();
  for (const row of rows) {
    for (const group of parseGroups(row.checklist_items)) {
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        const key = normalizeKitKey(item?.kit_key);
        if (!key || item.required === false || byKey.has(key)) continue;
        byKey.set(key, { kit_key: key, label: String(item.item || key) });
      }
    }
  }
  return [...byKey.values()];
}

// Every key in use, for the Assets dialog's suggestions: the checklist items
// (with their text as the label) and the keys already on equipment rows.
async function kitKeyVocabulary(conn = db) {
  const byKey = new Map();
  for (const row of await conn('equipment_checklists').select('checklist_items')) {
    for (const group of parseGroups(row.checklist_items)) {
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        const key = normalizeKitKey(item?.kit_key);
        if (key && !byKey.has(key)) byKey.set(key, { kit_key: key, label: String(item.item || key) });
      }
    }
  }
  for (const row of await conn('equipment').whereNotNull('kit_key').distinct('kit_key')) {
    const key = normalizeKitKey(row.kit_key);
    if (key && !byKey.has(key)) byKey.set(key, { kit_key: key, label: key.replace(/_/g, ' ') });
  }
  return [...byKey.values()].sort((a, b) => a.kit_key.localeCompare(b.kit_key));
}

// The keyed tools a truck carries today: keyed live rows minus any with an open
// tool alert (reported missing or damaged on the last check).
const keysOnTruck = (kit) => new Set(kit.filter((item) => item.kit_key && !item.open_issue).map((item) => normalizeKitKey(item.kit_key)));

// What a truck lacks for a service line. Empty when the truck has no keyed row
// at all (keys are not set up for it) or the line requires nothing keyed.
async function toolGapsForTruck(vehicleId, serviceLine, conn = db) {
  const kit = await kitForTruck(vehicleId, conn);
  if (!kit.some((item) => item.kit_key)) return [];
  const required = await requiredToolsForLine(serviceLine, conn);
  if (!required.length) return [];
  const onTruck = keysOnTruck(kit);
  return required.filter((tool) => !onTruck.has(tool.kit_key));
}

function toolGapLabel(gaps) {
  const names = gaps.map((gap) => gap.label);
  if (names.length === 1) return `Truck lacks ${names[0]}`;
  if (names.length === 2) return `Truck lacks ${names[0]} and ${names[1]}`;
  return `Truck lacks ${names.length} tools`;
}

// The Schedule readiness strip's exception for one visit (job-card.js
// dispatchReadiness), or null: a required tool the assigned truck lacks is a
// hold like company stock or weather.
async function toolGapIssue({ technicianId, serviceLine }, conn = db) {
  if (!truckKitLive() || !technicianId || !serviceLine) return null;
  const truck = await truckForTechnician(technicianId, conn);
  if (!truck) return null;
  const gaps = await toolGapsForTruck(truck.id, serviceLine, conn);
  if (!gaps.length) return null;
  return { kind: 'tools', status: 'hold', label: toolGapLabel(gaps), tools: gaps.map((gap) => gap.kit_key) };
}

// Today's visits of the technician that need a tool their truck lacks (the
// Today page's Up next line), keyed by scheduled service.
async function toolGapsForToday(technicianId, truck, { now = new Date(), conn = db } = {}) {
  const visits = await conn('scheduled_services')
    .where({ technician_id: technicianId, scheduled_date: etDateString(now) })
    .whereIn('status', LIVE_VISIT_STATUSES)
    .select('id', 'service_type');
  if (!visits.length) return [];
  const kit = await kitForTruck(truck.id, conn);
  if (!kit.some((item) => item.kit_key)) return [];
  const onTruck = keysOnTruck(kit);
  const requiredByLine = new Map();
  const out = [];
  for (const visit of visits) {
    const line = detectServiceLine(visit.service_type);
    if (!requiredByLine.has(line)) requiredByLine.set(line, await requiredToolsForLine(line, conn));
    const missing = requiredByLine.get(line).filter((tool) => !onTruck.has(tool.kit_key));
    if (missing.length) out.push({ serviceId: visit.id, serviceType: visit.service_type, missing: missing.map((tool) => tool.label) });
  }
  return out;
}

// What the field workspace shows: the truck, its kit, the last check, whether
// a check is due (only when there is something on the list) and today's gaps.
async function truckKitStatus(technicianId, { now = new Date(), conn = db } = {}) {
  const truck = await truckForTechnician(technicianId, conn);
  if (!truck) return { enabled: true, truck: null, kit: [], lastCheck: null, due: false, intervalDays: CHECK_INTERVAL_DAYS, gaps: [] };
  const [kit, lastCheck, gaps] = await Promise.all([
    kitForTruck(truck.id, conn), lastCheckForTruck(truck.id, conn), toolGapsForToday(technicianId, truck, { now, conn }),
  ]);
  return {
    enabled: true, truck, kit, lastCheck,
    due: kit.length > 0 && checkDue(lastCheck?.checked_at, now),
    intervalDays: CHECK_INTERVAL_DAYS,
    gaps,
  };
}

function normalizeResults(results) {
  if (!Array.isArray(results)) throw new TruckCheckError('invalid_results', 'results must be a list');
  const byId = new Map();
  for (const entry of results) {
    const equipmentId = String(entry?.equipmentId || entry?.equipment_id || '');
    const state = String(entry?.state || '').toLowerCase();
    if (!UUID_RE.test(equipmentId)) throw new TruckCheckError('invalid_results', 'each result names an equipment id');
    if (!STATES.includes(state)) throw new TruckCheckError('invalid_results', 'each result state is present, missing or damaged');
    if (byId.has(equipmentId)) throw new TruckCheckError('invalid_results', 'an item appears twice');
    const note = entry?.note == null ? '' : String(entry.note).trim().slice(0, NOTE_MAX);
    byId.set(equipmentId, { equipmentId, state, note });
  }
  return byId;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// Names as a person would read them in a bell: no code-shaped characters and no
// sentence-ending stops inside the list (the why is one sentence).
const plainName = (name) => tidyName(name).replace(/\.\s+/g, ' ');
const itemList = (lines) => lines.map((line) => plainName(line.name)).join(', ');

function bellSpec({ truck, technician, missing, damaged }) {
  const count = missing.length + damaged.length;
  const tools = count === 1 ? 'tool' : 'tools';
  const who = firstName(technician?.name) || 'The truck check';
  const parts = [];
  if (missing.length) parts.push(`missing ${itemList(missing)}`);
  if (damaged.length) parts.push(`damaged ${itemList(damaged)}`);
  return {
    area: 'Inventory',
    action: fitAction('Inventory', truck.asset_tag || truck.name, [
      (t) => `find or replace ${count} ${tools} on ${t}`,
      (t) => `${count} ${tools} to replace on ${t}`,
    ]),
    why: truncateAtWord(`${who} found ${parts.join(' and ')} on the truck check`, 110),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'equipment', id: truck.id },
    doneWhen: 'tool_alerts_resolved',
    who: 'person',
  };
}

const issueWord = (state) => (state === 'missing' ? 'Missing' : 'Damaged');

async function openToolAlert({ line, technician, now }) {
  const alertType = ALERT_TYPE[line.state];
  const who = technician?.name || 'a technician';
  const description = `${issueWord(line.state)} at the ${etDateString(now)} truck check by ${who}${line.note ? `: ${line.note}` : ''}`;
  const open = await db('maintenance_alerts')
    .where({ equipment_id: line.equipmentId, alert_type: alertType })
    .whereIn('status', OPEN_ALERT_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id');
  if (open) {
    await db('maintenance_alerts').where({ id: open.id }).update({ description, updated_at: now });
    return open.id;
  }
  const alert = await reportEquipmentIssue({
    equipmentId: line.equipmentId,
    technicianId: technician?.id || null,
    description,
    severity: 'high',
    alertType,
    title: `${issueWord(line.state)}: ${line.name}${line.assetTag ? ` ${line.assetTag}` : ''} (truck check by ${who})`.slice(0, 300),
    // A damaged tool drops its condition like any field-reported issue; a
    // missing one has no condition to judge.
    adjustCondition: line.state === 'damaged',
  });
  return alert.id;
}

// A tool marked present on this check that still had an open alert was found
// (or repaired): the emitter clears its own alert.
async function closeFoundAlerts({ present, technician, now }) {
  if (!present.length) return 0;
  return db('maintenance_alerts')
    .whereIn('equipment_id', present.map((line) => line.equipmentId))
    .whereIn('alert_type', TOOL_ALERT_TYPES)
    .whereIn('status', OPEN_ALERT_STATUSES)
    .update({ status: 'resolved', resolved_at: now, resolved_by: `truck check by ${technician?.name || 'technician'}`, updated_at: now });
}

async function raiseTruckBell({ truck, technician, missing, damaged, check }) {
  const detail = [...missing, ...damaged]
    .map((line) => `${issueWord(line.state)}: ${line.name}${line.assetTag ? ` (${line.assetTag})` : ''}${line.note ? ` · ${line.note}` : ''}`)
    .join('\n');
  return raiseAdminAlert(CATEGORY, bellSpec({ truck, technician, missing, damaged }), {
    dedupeKey: bellKey(truck.id),
    // A closed (done) row never hides a new ring; a standing open row is
    // rewritten with the newest check and rung again.
    dedupeOpenOnly: true,
    refreshOnDedupe: true,
    bumpOnRefresh: true,
    bell: true,
    detail,
    metadata: { vehicleId: truck.id, checkId: check.id, missing: missing.length, damaged: damaged.length },
  });
}

// The truck's bell is done once no tool alert on it is open: after a check
// that found everything, or after the office resolves the last alert.
async function closeTruckBellIfClear(vehicleId, now = new Date(), conn = db) {
  const open = await conn('maintenance_alerts as a')
    .join('equipment as e', 'a.equipment_id', 'e.id')
    .where('e.assigned_vehicle_id', vehicleId)
    .whereIn('a.alert_type', TOOL_ALERT_TYPES)
    .whereIn('a.status', OPEN_ALERT_STATUSES)
    .first('a.id');
  if (open) return false;
  const episodes = require('./admin-alert-episodes');
  await episodes.closeAdminAlertKeys(conn, [bellKey(vehicleId)], 'tool_alerts_resolved', { now, resolution: 'Every tool on the truck is accounted for' });
  return true;
}

async function recordTruckCheck({ technicianId, results, now = new Date() }) {
  const truck = await truckForTechnician(technicianId);
  if (!truck) throw new TruckCheckError('no_truck', 'No truck is assigned to you');
  const wanted = normalizeResults(results);
  const kit = await kitForTruck(truck.id);
  const kitIds = new Set(kit.map((item) => item.id));
  if (wanted.size !== kit.length || [...wanted.keys()].some((id) => !kitIds.has(id))) {
    throw new TruckCheckError('kit_changed', 'The truck list changed since it was loaded', { kit });
  }
  const technician = await db('technicians').where({ id: technicianId }).first('id', 'name');
  const lines = kit.map((item) => ({ ...wanted.get(item.id), name: item.name, assetTag: item.asset_tag }));
  const missing = lines.filter((line) => line.state === 'missing');
  const damaged = lines.filter((line) => line.state === 'damaged');
  const present = lines.filter((line) => line.state === 'present');

  const [check] = await db('equipment_checks').insert({
    vehicle_id: truck.id,
    technician_id: technicianId,
    checked_at: now,
    // A JS array into a jsonb column is stringified (waves-db skill 5d).
    results: JSON.stringify(lines.map(({ equipmentId, state, note }) => ({ equipment_id: equipmentId, state, note }))),
    item_count: lines.length,
    missing_count: missing.length,
    damaged_count: damaged.length,
  }).returning('*');

  for (const line of [...missing, ...damaged]) await openToolAlert({ line, technician, now });
  await closeFoundAlerts({ present, technician, now });
  if (missing.length + damaged.length > 0) await raiseTruckBell({ truck, technician, missing, damaged, check });
  else await closeTruckBellIfClear(truck.id, now);

  logger.info(`[truck-kit] check on ${truck.name}: ${lines.length} items, ${missing.length} missing, ${damaged.length} damaged`);
  return {
    check: { id: check.id, checked_at: check.checked_at, item_count: lines.length, missing_count: missing.length, damaged_count: damaged.length },
  };
}

module.exports = {
  CHECK_INTERVAL_DAYS,
  TOOL_ALERT_TYPES,
  TruckCheckError,
  truckKitEnabled,
  truckForTechnician,
  kitForTruck,
  lastCheckForTruck,
  checkDue,
  truckKitStatus,
  recordTruckCheck,
  closeTruckBellIfClear,
  bellSpec,
  requiredToolsForLine,
  kitKeyVocabulary,
  toolGapsForTruck,
  toolGapIssue,
  toolGapsForToday,
};
