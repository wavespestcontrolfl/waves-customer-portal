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
const { isMistingDesignConsultation } = require('../utils/mosquito-misting-system');

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
// A combined job ("Quarterly Pest + Termite Bait Station") reads as ONE line
// for the report layout (detectServiceLine) but needs every named line's
// tools. A companion line is any checklist line the service name mentions.
const COMPANION_LINES = [
  ['termite', /\b(termite|wdo)\b/],
  ['rodent', /\b(rodent|rat|rats|mouse|mice)\b/],
  ['mosquito', /\bmosquito\b/],
  ['pest', /\bpest\b/],
  ['lawn', /\b(lawn|turf)\b/],
  ['tree_shrub', /\b(tree|shrub|ornamental)\b/],
];

const bellKey = (vehicleId) => `truck-kit:${vehicleId}`;
// One advisory lock per truck: a check and an office resolve on the same
// truck never interleave (both take it inside their transaction).
const lockTruck = (conn, vehicleId) => conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [bellKey(vehicleId)]);
// One lock per technician for "one live truck per technician": two
// assignments to the same person serialize on it (routes/admin-equipment.js).
const lockTechnician = (conn, technicianId) => conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`truck-kit:tech:${technicianId}`]);

// A consultation (the Waves Assessment, a consultation link, a walkthrough)
// treats nothing and needs no tools. A diagnostic inspection (WDO letter,
// lawn health inspection) DOES: its checklist names the instruments, so the
// catalog category alone never exempts a visit, only a consultation identity.
// new_customer_inspection is the first-visit walkthrough (catalog: assess
// the property and recommend services), a consultation by another name.
// pest_inspection is the same: identify conditions and recommend a plan, no
// treatment. The misting design visit uses the repository's shared predicate.
const CONSULTATION_KEYS = new Set(['waves_assessment', 'lead_consultation_link', 'consultation', 'new_customer_inspection', 'pest_inspection']);
const CONSULTATION_NAME = /\b(assessment|consultation|walk-?through|new customer property inspection|pest inspection service)\b/i;
// A known diagnostic identity (the lawn assessment is the lawn_inspection
// row, renamed) needs its instruments whatever its name says.
const DIAGNOSTIC_KEYS = new Set(['lawn_inspection', 'wdo_inspection', 'termite_inspection']);
const isConsultation = (serviceType, serviceKey) => {
  const key = serviceKey ? String(serviceKey).toLowerCase() : null;
  if (key && DIAGNOSTIC_KEYS.has(key)) return false;
  return (key ? CONSULTATION_KEYS.has(key) : false)
    || CONSULTATION_NAME.test(String(serviceType || ''))
    || isMistingDesignConsultation({ serviceKey, name: serviceType });
};
// Catalog identity picks the line before the name does: a fire ant yard
// add-on is lawn_care (a spreader job) whatever its name reads as.
const CATEGORY_LINE = { lawn_care: 'lawn', pest_control: 'pest', tree_shrub: 'tree_shrub', termite: 'termite', mosquito: 'mosquito', rodent: 'rodent' };
// Mechanical lawn work (job-card.js ADDON_PROGRAMS lawn_care.nonChemical)
// and the web sweep use their own machines, not the spray checklist: no
// treatment-tool hold. Legacy rows without a key match by name.
const MECHANICAL_KEYS = new Set(['lawn_aeration', 'dethatching', 'plugging', 'top_dressing', 'area_addon_web_sweep']);
const MECHANICAL_NAME = /\b(dethatch\w*|aerat\w*|plugging|top\s*-?dress\w*|web sweep)\b/i;
const isMechanical = (serviceType, serviceKey) =>
  (serviceKey ? MECHANICAL_KEYS.has(String(serviceKey).toLowerCase()) : false) || MECHANICAL_NAME.test(String(serviceType || ''));

// The checklist lines ONE service's tools come from: its line plus every
// companion line its name mentions, in that order, once each.
function linesForService(serviceType, serviceKey, serviceCategory = null) {
  const lines = [];
  if (!String(serviceType || '').trim() || isConsultation(serviceType, serviceKey) || isMechanical(serviceType, serviceKey)) return lines;
  const primary = CATEGORY_LINE[String(serviceCategory || '').toLowerCase()] || detectServiceLine(serviceType);
  if (primary) lines.push(primary);
  const text = String(serviceType || '').toLowerCase();
  for (const [line, re] of COMPANION_LINES) if (re.test(text) && !lines.includes(line)) lines.push(line);
  return lines;
}

// Treatment-specific kits the generic checklist marks optional: the job's
// identity promotes them to required (a bait station visit needs the station
// key, a foam job the drill kit), by service key or by name for legacy rows.
const PROMOTED_KITS = [
  { keys: ['bait_station_key'], key: /bait|cartridge|monitoring|station/i, name: /\b(bait\s*station|termite\s*bait|cartridge|monitoring)\b/i },
  { keys: ['foam_drill_kit'], key: /foam|drill/i, name: /\b(foam|drill)\b/i },
];
function promotedKeysFor(serviceType, serviceKey) {
  const out = [];
  for (const kit of PROMOTED_KITS) {
    if ((serviceKey && kit.key.test(String(serviceKey))) || kit.name.test(String(serviceType || ''))) out.push(...kit.keys);
  }
  return out;
}

// What a visit requires: the primary service's lines, then each booked
// add-on's (a Tree & Shrub add-on on a pest visit needs the tree and shrub
// tools too), plus the keys its identity promotes. `addons` is [{ name, serviceKey }].
function requirementsFor(serviceType, { serviceKey = null, serviceCategory = null, addons = [] } = {}) {
  const lines = linesForService(serviceType, serviceKey, serviceCategory);
  const promote = new Set(lines.length ? promotedKeysFor(serviceType, serviceKey) : []);
  for (const addon of Array.isArray(addons) ? addons : []) {
    const addonLines = linesForService(addon?.name, addon?.serviceKey, addon?.category);
    for (const line of addonLines) if (!lines.includes(line)) lines.push(line);
    if (addonLines.length) for (const key of promotedKeysFor(addon?.name, addon?.serviceKey)) promote.add(key);
  }
  return { lines, promote };
}
const serviceLinesFor = (serviceType, opts) => requirementsFor(serviceType, opts).lines;

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

// One live truck per technician. Two is a data error the office must fix
// (the Assets dialog refuses it, routes/admin-equipment.js); a check or a
// readiness read never guesses which roster to use.
async function truckForTechnician(technicianId, conn = db) {
  if (!technicianId) return null;
  const rows = await conn('equipment')
    .where({ category: 'vehicle', assigned_to: technicianId })
    .whereNotIn('status', DEAD_VEHICLE_STATUSES)
    .orderBy('name')
    .limit(2)
    .select('id', 'name', 'asset_tag');
  if (rows.length > 1) throw new TruckCheckError('ambiguous_truck', 'More than one truck is assigned to you. Ask the office to fix the assignment.');
  return rows[0] || null;
}

const AMBIGUOUS_HOLD = { kind: 'tools', status: 'hold', label: 'Two trucks assigned to the technician', tools: [] };

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

// The open tool alert on one item, if any (a moved item must not carry one).
async function openToolAlertFor(equipmentId, conn = db) {
  const row = await conn('maintenance_alerts')
    .where({ equipment_id: equipmentId })
    .whereIn('alert_type', TOOL_ALERT_TYPES)
    .whereIn('status', OPEN_ALERT_STATUSES)
    .first('id');
  return row || null;
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
  return requiredToolsForLines([serviceLine], conn);
}

// The same across several lines (a combined job), once per key. `promote`
// names optional keyed items this job makes required.
async function requiredToolsForLines(serviceLines, conn = db, promote = new Set()) {
  const lines = [...new Set((Array.isArray(serviceLines) ? serviceLines : [serviceLines]).filter(Boolean))];
  if (!lines.length) return [];
  const rows = await conn('equipment_checklists').whereIn('service_line', lines).select('service_line', 'checklist_items');
  const byKey = new Map();
  // Primary line's tools first, then each companion's, whatever the table order.
  for (const row of lines.flatMap((line) => rows.filter((r) => r.service_line === line))) {
    for (const group of parseGroups(row.checklist_items)) {
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        const key = normalizeKitKey(item?.kit_key);
        if (!key || (item.required === false && !promote.has(key)) || byKey.has(key)) continue;
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

// Keys are set up for a truck once ANY row assigned to it carries one, whatever
// its status: a truck whose last keyed tool was just marked lost is not
// unconfigured, it is missing a tool (pre-push P1 on #6497).
// Durable: a truck stays configured after its last keyed tool moves away,
// because the latest check's roster still names a keyed row (the next check,
// on the unkeyed roster, is the explicit new state).
async function truckHasKeys(vehicleId, conn = db) {
  const row = await conn('equipment').where({ assigned_vehicle_id: vehicleId }).whereNotNull('kit_key').first('id');
  if (row) return true;
  const last = await conn('equipment_checks').where({ vehicle_id: vehicleId }).orderBy('checked_at', 'desc').first('results');
  const results = last ? parseGroups(last.results) : [];
  const ids = results.map((r) => r?.equipment_id).filter((id) => UUID_RE.test(String(id || '')));
  if (!ids.length) return false;
  const keyed = await conn('equipment').whereIn('id', ids).whereNotNull('kit_key').first('id');
  return Boolean(keyed);
}

// The keyed tools a truck carries today: keyed live rows minus any with an open
// tool alert (reported missing or damaged on the last check).
const keysOnTruck = (kit) => new Set(kit.filter((item) => item.kit_key && !item.open_issue).map((item) => normalizeKitKey(item.kit_key)));

// What a truck lacks for a service line (or several, for a combined job).
// Empty when the truck has no keyed row at all (keys are not set up for it)
// or the lines require nothing keyed.
async function toolGapsForTruck(vehicleId, serviceLines, conn = db, promote = new Set()) {
  if (!(await truckHasKeys(vehicleId, conn))) return [];
  const required = await requiredToolsForLines(serviceLines, conn, promote);
  if (!required.length) return [];
  const onTruck = keysOnTruck(await kitForTruck(vehicleId, conn));
  return required.filter((tool) => !onTruck.has(tool.kit_key));
}

// The job card's readiness call (job-card.js buildJobCard, readinessOnly):
// nothing while the kit is dark, and a failed read is reported, never fatal,
// so the stock and weather holds always stand.
async function readinessToolIssue(facts, conn = db) {
  if (!truckKitLive()) return null;
  try {
    return await module.exports.toolGapIssue({
      technicianId: facts.technicianId, serviceLine: facts.serviceLine, serviceType: facts.serviceType,
      serviceKey: facts.serviceKey || null, serviceCategory: facts.serviceCategory || null, addons: facts.addons || [],
    }, conn);
  } catch (err) {
    logger.warn(`[truck-kit] readiness read failed for ${facts.serviceId}: ${err?.message || err}`);
    return null;
  }
}

// Adds the hold to a readiness result (no branch left in buildJobCard).
async function addReadinessToolIssue(readiness, facts, conn = db) {
  const issue = await readinessToolIssue(facts, conn);
  if (issue) readiness.issues.push(issue);
  return readiness;
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
// serviceType, when given, adds the companion lines of a combined job.
async function toolGapIssue({ technicianId, serviceLine, serviceType, serviceKey = null, serviceCategory = null, addons = [] }, conn = db) {
  if (!truckKitLive() || !technicianId) return null;
  const { lines, promote } = serviceType ? requirementsFor(serviceType, { serviceKey, serviceCategory, addons }) : { lines: [serviceLine].filter(Boolean), promote: new Set() };
  if (!lines.length) return null;
  let truck;
  try { truck = await truckForTechnician(technicianId, conn); } catch (err) {
    if (err.code === 'ambiguous_truck') return AMBIGUOUS_HOLD;
    throw err;
  }
  if (!truck) return null;
  const gaps = await toolGapsForTruck(truck.id, lines, conn, promote);
  if (!gaps.length) return null;
  return { kind: 'tools', status: 'hold', label: toolGapLabel(gaps), tools: gaps.map((gap) => gap.kit_key) };
}

// Today's visits of the technician that need a tool their truck lacks (the
// Today page's Up next line), keyed by scheduled service.
async function toolGapsForToday(technicianId, truck, { now = new Date(), conn = db } = {}) {
  const visits = await conn('scheduled_services')
    .where({ technician_id: technicianId, scheduled_date: etDateString(now) })
    .whereIn('status', LIVE_VISIT_STATUSES)
    .select('id', 'service_type', 'service_key_snapshot', 'service_category_snapshot');
  if (!visits.length) return [];
  if (!(await truckHasKeys(truck.id, conn))) return [];
  const onTruck = keysOnTruck(await kitForTruck(truck.id, conn));
  // Booked add-ons bring their own line's tools.
  const addonRows = await conn('scheduled_service_addons')
    .whereIn('scheduled_service_id', visits.map((v) => v.id))
    .select('scheduled_service_id', 'service_name', 'service_key_snapshot', 'service_category_snapshot');
  const addonsByVisit = new Map();
  for (const row of addonRows) {
    if (!addonsByVisit.has(row.scheduled_service_id)) addonsByVisit.set(row.scheduled_service_id, []);
    addonsByVisit.get(row.scheduled_service_id).push({ name: row.service_name, serviceKey: row.service_key_snapshot || null, category: row.service_category_snapshot || null });
  }
  const requiredByLines = new Map();
  const out = [];
  for (const visit of visits) {
    const { lines, promote } = requirementsFor(visit.service_type, { serviceKey: visit.service_key_snapshot, serviceCategory: visit.service_category_snapshot, addons: addonsByVisit.get(visit.id) || [] });
    if (!lines.length) continue;
    const key = `${lines.join('+')}|${[...promote].sort().join('+')}`;
    if (!requiredByLines.has(key)) requiredByLines.set(key, await requiredToolsForLines(lines, conn, promote));
    const missing = requiredByLines.get(key).filter((tool) => !onTruck.has(tool.kit_key));
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

async function openToolAlert({ line, technician, now, conn }) {
  const alertType = ALERT_TYPE[line.state];
  const who = technician?.name || 'a technician';
  const description = `${issueWord(line.state)} at the ${etDateString(now)} truck check by ${who}${line.note ? `: ${line.note}` : ''}`;
  const open = await conn('maintenance_alerts')
    .where({ equipment_id: line.equipmentId, alert_type: alertType })
    .whereIn('status', OPEN_ALERT_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id');
  // A tool reported missing last time and damaged now (or the reverse) keeps
  // one open alert: the other type's alert is closed as superseded.
  await conn('maintenance_alerts')
    .where({ equipment_id: line.equipmentId })
    .whereIn('alert_type', TOOL_ALERT_TYPES)
    .whereNot('alert_type', alertType)
    .whereIn('status', OPEN_ALERT_STATUSES)
    .update({ status: 'resolved', resolved_at: now, resolved_by: `truck check by ${who}: now ${line.state}`, updated_at: now });
  if (open) {
    // A repeat report with no new note keeps the earlier description: the
    // first report may say where the tool was last seen.
    await conn('maintenance_alerts').where({ id: open.id }).update(line.note ? { description, updated_at: now } : { updated_at: now });
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
    conn,
  });
  return alert.id;
}

// A tool marked present on this check that still had an open alert was found
// (or repaired): the emitter clears its own alert.
async function closeFoundAlerts({ present, technician, now, conn }) {
  if (!present.length) return 0;
  return conn('maintenance_alerts')
    .whereIn('equipment_id', present.map((line) => line.equipmentId))
    .whereIn('alert_type', TOOL_ALERT_TYPES)
    .whereIn('status', OPEN_ALERT_STATUSES)
    .update({ status: 'resolved', resolved_at: now, resolved_by: `truck check by ${technician?.name || 'technician'}`, updated_at: now });
}

async function raiseTruckBell({ truck, technician, missing, damaged, check, trx }) {
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
    // Each check is a new version: the same items still missing rings again.
    dedupeVersion: `check:${check.id}`,
    // Rings by default; the owner can silence the truck_kit category in
    // Settings (bellDefault sits below the saved category override).
    bellDefault: true,
    trx,
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

// The check row, its alerts and the bell commit together, or not at all: a
// check must never read as done while the office was not told. One
// transaction, serialized per truck by an advisory lock, so two devices (or a
// retry after a timeout) can never open the same item's alert twice.
async function recordTruckCheck({ technicianId, results, now = new Date() }) {
  const wanted = normalizeResults(results);
  return db.transaction(async (trx) => {
    const found = await truckForTechnician(technicianId, trx);
    if (!found) throw new TruckCheckError('no_truck', 'No truck is assigned to you');
    await lockTruck(trx, found.id);
    // Ownership is re-read under the lock: the office hands a truck over
    // under the same lock (routes/admin-equipment.js), so a check that
    // started on a truck the technician no longer has writes nothing.
    const truck = await truckForTechnician(technicianId, trx);
    if (!truck || truck.id !== found.id) throw new TruckCheckError('kit_changed', 'The truck list changed since it was loaded', { kit: [] });
    const kit = await kitForTruck(truck.id, trx);
    const kitIds = new Set(kit.map((item) => item.id));
    if (wanted.size !== kit.length || [...wanted.keys()].some((id) => !kitIds.has(id))) {
      throw new TruckCheckError('kit_changed', 'The truck list changed since it was loaded', { kit });
    }
    const technician = await trx('technicians').where({ id: technicianId }).first('id', 'name');
    const lines = kit.map((item) => ({ ...wanted.get(item.id), name: item.name, assetTag: item.asset_tag }));
    const missing = lines.filter((line) => line.state === 'missing');
    const damaged = lines.filter((line) => line.state === 'damaged');
    const present = lines.filter((line) => line.state === 'present');

    const [check] = await trx('equipment_checks').insert({
      vehicle_id: truck.id,
      technician_id: technicianId,
      checked_at: now,
      // A JS array into a jsonb column is stringified (waves-db skill 5d).
      results: JSON.stringify(lines.map(({ equipmentId, state, note }) => ({ equipment_id: equipmentId, state, note }))),
      item_count: lines.length,
      missing_count: missing.length,
      damaged_count: damaged.length,
    }).returning('*');

    for (const line of [...missing, ...damaged]) await openToolAlert({ line, technician, now, conn: trx });
    await closeFoundAlerts({ present, technician, now, conn: trx });
    if (missing.length + damaged.length > 0) await raiseTruckBell({ truck, technician, missing, damaged, check, trx });
    else await closeTruckBellIfClear(truck.id, now, trx);

    logger.info(`[truck-kit] check on ${truck.name}: ${lines.length} items, ${missing.length} missing, ${damaged.length} damaged`);
    return {
      check: { id: check.id, checked_at: check.checked_at, item_count: lines.length, missing_count: missing.length, damaged_count: damaged.length },
    };
  });
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
  requiredToolsForLines,
  serviceLinesFor,
  requirementsFor,
  lockTruck,
  lockTechnician,
  readinessToolIssue,
  addReadinessToolIssue,
  truckHasKeys,
  openToolAlertFor,
  kitKeyVocabulary,
  toolGapsForTruck,
  toolGapIssue,
  toolGapsForToday,
};
