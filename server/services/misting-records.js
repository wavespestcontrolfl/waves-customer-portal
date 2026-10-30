'use strict';

// Misting system records: the install calibration and the refill log for an automatic mosquito misting
// system (dark behind GATE_MOSQUITO_MISTING; routes/admin-misting-records.js, tables from
// migrations/20261030120000_misting_records.js).
//
// Both tables are append-only. A re-calibration, or any correction, is a new misting_calibrations row;
// the newest non-voided row for a property is that system's current record. A refill must be logged
// against the current calibration and match its product and mix, because the calibration's daily limit
// only holds for the product and mix it was worked out with. Voiding keeps the row and says why.
//
// PROPERTY RULE (this supersedes the migration header, which is frozen and says NULL means primary):
// a new calibration ALWAYS stores the real customer_properties id of the home it is at, the primary
// included, so a later change of the primary never moves a system to another home. property_id is NULL
// only after its property row was hard-deleted (ON DELETE SET NULL). Such rows are history: they list
// under "Removed property", are never current for any property, and take no refills.
//
// The server is the authority: the computed numbers (volume, output per cycle, daily output, daily cap)
// come from services/misting-calibration-math.js and are stored, never taken from the client. The label
// rules of a KNOWN product (shared/misting-products.json) are enforced here; an unknown product keeps
// the limit staff enter.
//
// Writes for one customer run one at a time (a transaction-scoped advisory lock). No FOR UPDATE row
// locks on customers, visits or invoices (house rule).

const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const customerProperties = require('./customer-properties');
const { computeCalibration, overLabelMessage, roundTo, formatOzPair, capAtMix, mixWithinLabelRange } = require('./misting-calibration-math');
const PRODUCTS = require('../../shared/misting-products.json').products;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id) => UUID_RE.test(String(id || ''));

const LIST_LIMIT = 200;
const REFILL_MIX_TOLERANCE = 0.1; // a refill's mix against the calibration's

/** Read at call time. Off = the routes answer 404 before any DB read. */
function recordsEnabled() {
  return featureGates.mosquitoMistingLive();
}

function opError(statusCode, code, message) {
  const err = new Error(message);
  err.isOperational = true;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
const bad = (message) => opError(400, 'MISTING_BAD_INPUT', message);

// ── Input reading ────────────────────────────────────────────────────────

function readNumber(input, key, label, { min, max, integer = false, unit = '', optional = false } = {}) {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === '') {
    if (optional) return null;
    throw bad(`${label} is required.`);
  }
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  const range = `${min}${unit ? ` ${unit}` : ''} to ${max}${unit ? ` ${unit}` : ''}`;
  if (!Number.isFinite(value)) throw bad(`${label} must be a number.`);
  if (integer && !Number.isInteger(value)) throw bad(`${label} must be a whole number.`);
  if (value < min || value > max) throw bad(`${label} must be ${range}.`);
  return value;
}

function readText(input, key, label, { min = 1, max, optional = false } = {}) {
  const raw = input[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (optional) return null;
    throw bad(`${label} is required.`);
  }
  if (typeof raw !== 'string') throw bad(`${label} must be text.`);
  const value = raw.trim();
  if (value.length < min || value.length > max) throw bad(`${label} must be ${min} to ${max} characters.`);
  return value;
}

function readDate(input, key, label) {
  const raw = input[key];
  const m = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  if (!m) throw bad(`${label} must be a date (YYYY-MM-DD).`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw bad(`${label} is not a real date.`);
  }
  if (raw > etDateString()) throw bad(`${label} cannot be in the future.`);
  return raw;
}

const EPA_RE = /^\d{1,7}-\d{1,7}(-\d{1,7})?$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function readEpa(input) {
  const value = readText(input, 'epaRegNo', 'EPA reg. no.', { max: 40 });
  if (value !== '25(b)' && !EPA_RE.test(value)) {
    throw bad('EPA reg. no. looks like 1021-1834, or 25(b) for an exempt product.');
  }
  return value;
}

function readMistTimes(input) {
  const raw = input.mistTimes;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) throw bad('Mist times: add 1 to 12 times.');
  if (raw.some((t) => typeof t !== 'string' || !TIME_RE.test(t))) throw bad('Mist times must look like 06:30 (24-hour, Eastern).');
  if (new Set(raw).size !== raw.length) throw bad('Mist times: each time can be listed once.');
  return [...raw].sort();
}

function knownProduct(epaRegNo) {
  const key = String(epaRegNo || '').trim().toLowerCase();
  return PRODUCTS.find((p) => p.epaRegNo.toLowerCase() === key) || null;
}

// ── Reads ────────────────────────────────────────────────────────────────

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

// pg returns a date column as a local-midnight Date (or a string when a parser is set).
function dateOnly(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

const person = (id, name) => (id ? { id, name: name || null } : null);

function toCalibration(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    propertyId: row.property_id || null,
    installedOn: dateOnly(row.installed_on),
    vendor: row.vendor,
    model: row.model,
    serialNumber: row.serial_number || null,
    tankGallons: num(row.tank_gallons),
    zoneCount: num(row.zone_count),
    nozzleCount: num(row.nozzle_count),
    riserCount: num(row.riser_count),
    nozzleFlowFlOzPerMin: num(row.nozzle_flow_fl_oz_per_min),
    cycleSeconds: num(row.cycle_seconds),
    mistTimes: row.mist_times || [],
    productName: row.product_name,
    epaRegNo: row.epa_reg_no,
    concentrateFlOzPerTank: num(row.concentrate_fl_oz_per_tank),
    mixFlOzPerGal: roundTo(Number(row.concentrate_fl_oz_per_tank) / Number(row.tank_gallons), 3),
    labelMaxFlOzPer1000CuFtDay: num(row.label_max_fl_oz_per_1000_cu_ft_day),
    treatedAreaSqFt: num(row.treated_area_sq_ft),
    treatedHeightFt: num(row.treated_height_ft),
    treatedVolumeCuFt: num(row.treated_volume_cu_ft),
    outputFlOzPerCycle: num(row.output_fl_oz_per_cycle),
    dailyOutputFlOz: num(row.daily_output_fl_oz),
    labelDailyCapFlOz: num(row.label_daily_cap_fl_oz),
    cabinetLocked: row.cabinet_locked === true,
    labelPosted: row.label_posted === true,
    scheduleAvoidsPeople: row.schedule_avoids_people === true,
    notes: row.notes || null,
    source: row.source,
    recordedBy: person(row.recorded_by, row.recorded_by_name),
    createdAt: iso(row.created_at),
    voidedAt: iso(row.voided_at),
    voidedBy: row.voided_by || null,
    voidReason: row.void_reason || null,
  };
}

function toRefill(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    calibrationId: row.calibration_id,
    propertyId: row.property_id || null,
    refilledOn: dateOnly(row.refilled_on),
    productName: row.product_name,
    epaRegNo: row.epa_reg_no,
    concentrateFlOzAdded: num(row.concentrate_fl_oz_added),
    waterGallonsAdded: num(row.water_gallons_added),
    levelBeforePct: num(row.level_before_pct),
    counterReset: row.counter_reset === true,
    notes: row.notes || null,
    source: row.source,
    recordedBy: person(row.recorded_by, row.recorded_by_name),
    createdAt: iso(row.created_at),
    voidedAt: iso(row.voided_at),
    voidedBy: row.voided_by || null,
    voidReason: row.void_reason || null,
  };
}

const calibrationRows = (knex) => knex('misting_calibrations as c')
  .leftJoin('technicians as t', 't.id', 'c.recorded_by')
  .select('c.*', 't.name as recorded_by_name');
const refillRows = (knex) => knex('misting_refills as r')
  .leftJoin('technicians as t', 't.id', 'r.recorded_by')
  .select('r.*', 't.name as recorded_by_name');

async function customerExists(knex, customerId) {
  return Boolean(await knex('customers').where({ id: customerId }).first('id'));
}

const activeProperties = (knex, customerId) => knex('customer_properties')
  .where({ customer_id: customerId, active: true })
  .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at', order: 'asc' }])
  .select('id', 'is_primary', 'label', 'address_line1', 'address_line2', 'city', 'state', 'zip');

function addressOf(p) {
  const street = [p.address_line1, p.address_line2].filter(Boolean).join(' ');
  const place = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, place].filter(Boolean).join(', ') || null;
}

/**
 * Everything staff see on Customer 360: the active properties, then calibrations and refills newest
 * first (voided rows included and flagged; 200 each). Each calibration says whether it is the current
 * one for its property.
 */
async function listCustomerRecords(customerId, { knex = db } = {}) {
  if (!isUuid(customerId) || !(await customerExists(knex, customerId))) {
    throw opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.');
  }
  const [props, calRows, refRows] = await Promise.all([
    activeProperties(knex, customerId),
    calibrationRows(knex).where('c.customer_id', customerId).orderBy([{ column: 'c.created_at', order: 'desc' }, { column: 'c.id', order: 'desc' }]).limit(LIST_LIMIT),
    refillRows(knex).where('r.customer_id', customerId)
      .orderBy([{ column: 'r.refilled_on', order: 'desc' }, { column: 'r.created_at', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(LIST_LIMIT),
  ]);
  const seen = new Set();
  const calibrations = calRows.map((row) => {
    const payload = toCalibration(row);
    // A NULL property (its row was deleted) is history: never current.
    const key = payload.propertyId;
    payload.isCurrent = Boolean(key) && !payload.voidedAt && !seen.has(key);
    if (payload.isCurrent) seen.add(key);
    return payload;
  });
  return {
    properties: props.map((p) => ({
      id: p.id,
      label: p.label || addressOf(p) || 'Property',
      address: addressOf(p),
      isPrimary: p.is_primary === true,
    })),
    calibrations,
    refills: refRows.map(toRefill),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

const lockCustomer = (trx, customerId) => trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`misting-records:${customerId}`]);

/**
 * The current calibration for a property: the newest non-voided row with EXACTLY that property_id.
 * A NULL property (a deleted property row) is never current. The customer-app card imports this so it
 * and the staff service pick "current" the same way.
 */
async function currentCalibration(knex, customerId, propertyId) {
  if (!propertyId) return undefined;
  return knex('misting_calibrations')
    .where({ customer_id: customerId, property_id: propertyId })
    .whereNull('voided_at')
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first();
}

// The home a new calibration belongs to: always a real, active customer_properties row. A given id must
// be one of the customer's active rows; without one, a single active row is used and 2+ must be picked.
async function resolveProperty(knex, customerId, rawPropertyId) {
  const props = await activeProperties(knex, customerId);
  if (rawPropertyId !== undefined && rawPropertyId !== null && rawPropertyId !== '') {
    const hit = isUuid(rawPropertyId) ? props.find((p) => p.id === String(rawPropertyId).toLowerCase()) : null;
    if (!hit) throw bad('That property is not an active property of this customer.');
    return hit.id;
  }
  if (props.length >= 2) throw bad('Pick which property the system is at.');
  if (props.length === 1) return props[0].id;
  throw bad('This customer has no active property.');
}

// A customer who never had a property row gets the primary created lazily, the way resolveSessionScope
// does. It runs BEFORE the transaction: ensurePrimaryProperty takes a FOR UPDATE on the customers row, and
// this service does not hold that lock through its own writes.
async function ensureHomeRow(knex, customerId) {
  if (await knex('customer_properties').where({ customer_id: customerId }).first('id')) return;
  await customerProperties.ensurePrimaryProperty(customerId);
}

const CHECK_LABELS = [
  ['cabinetLocked', 'Lock the cabinet'],
  ['labelPosted', 'Post the label and dilution statement at the unit'],
  ['scheduleAvoidsPeople', 'Set mist times when people and pets are not outside'],
];

function readCalibration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the calibration as an object.');
  const fields = {
    installedOn: readDate(input, 'installedOn', 'Install date'),
    vendor: readText(input, 'vendor', 'Vendor', { max: 60 }),
    model: readText(input, 'model', 'Model', { max: 120 }),
    serialNumber: readText(input, 'serialNumber', 'Serial number', { max: 80, optional: true }),
    tankGallons: roundTo(readNumber(input, 'tankGallons', 'Tank size', { min: 1, max: 300, unit: 'gallons' }), 2),
    zoneCount: readNumber(input, 'zoneCount', 'Zones', { min: 1, max: 4, integer: true }),
    nozzleCount: readNumber(input, 'nozzleCount', 'Nozzles', { min: 0, max: 240, integer: true }),
    riserCount: readNumber(input, 'riserCount', 'Risers', { min: 0, max: 240, integer: true }),
    nozzleFlowFlOzPerMin: roundTo(readNumber(input, 'nozzleFlowFlOzPerMin', 'Nozzle flow', { min: 0.01, max: 10, unit: 'fl oz a minute' }), 3),
    cycleSeconds: readNumber(input, 'cycleSeconds', 'Mist length', { min: 5, max: 600, integer: true, unit: 'seconds' }),
    mistTimes: readMistTimes(input),
    productName: readText(input, 'productName', 'Product', { max: 120 }),
    epaRegNo: readEpa(input),
    labelMaxFlOzPer1000CuFtDay: roundTo(readNumber(input, 'labelMaxFlOzPer1000CuFtDay', 'Label limit', { min: 0.01, max: 1000, unit: 'fl oz per 1,000 cu ft a day' }), 3),
    treatedAreaSqFt: roundTo(readNumber(input, 'treatedAreaSqFt', 'Treated area', { min: 100, max: 200000, unit: 'sq ft' }), 1),
    treatedHeightFt: roundTo(readNumber(input, 'treatedHeightFt', 'Treated height', { min: 1, max: 15, unit: 'ft' }), 1),
    notes: readText(input, 'notes', 'Notes', { max: 2000, optional: true }),
  };
  if (fields.nozzleCount + fields.riserCount < 1 || fields.nozzleCount + fields.riserCount > 240) {
    throw bad('Nozzles plus risers must be 1 to 240.');
  }
  const concentrate = readNumber(input, 'concentrateFlOzPerTank', 'Concentrate per tank', { min: 0.01, max: 300 * 128, unit: 'fl oz' });
  fields.concentrateFlOzPerTank = roundTo(concentrate, 2);
  if (!(fields.concentrateFlOzPerTank > 0) || fields.concentrateFlOzPerTank > fields.tankGallons * 128) {
    throw bad('Concentrate per tank cannot be more than the tank holds (128 fl oz a gallon).');
  }
  fields.checks = Object.fromEntries(CHECK_LABELS.map(([key]) => [key, input[key] === true]));
  return fields;
}

// The rules a known product's label sets. Unknown products keep the limit staff entered.
function enforceProductLabel(fields, product) {
  if (!product) return;
  if (fields.labelMaxFlOzPer1000CuFtDay > product.labelMaxFlOzPer1000CuFtPerDay) {
    throw opError(422, 'MISTING_LABEL_LIMIT_MISMATCH',
      `The ${product.shortName} label allows at most ${product.labelMaxFlOzPer1000CuFtPerDay} fl oz per 1,000 cu ft a day.`);
  }
  enforceMixRange(product, fields.concentrateFlOzPerTank / fields.tankGallons);
}

// A known product's label mix range, with 2% slack on each end (calibration and refill alike).
function enforceMixRange(product, perGal) {
  if (mixWithinLabelRange(product, perGal)) return;
  const a = product.labelRateMix;
  const b = product.maxMix;
  throw opError(422, 'MISTING_MIX_OFF_LABEL',
    `The ${product.shortName} label mixes ${a.concentrateFlOz} to ${b.concentrateFlOz} fl oz of concentrate in ${a.waterGal} gallons `
    + `(${(a.concentrateFlOz / a.waterGal).toFixed(2)} to ${(b.concentrateFlOz / b.waterGal).toFixed(2)} fl oz a gallon). `
    + `This mix is ${perGal.toFixed(2)} fl oz a gallon.`);
}

/** Record an install calibration. Throws operational errors (400 shape, 404 customer, 422 rule). */
async function createCalibration({ customerId, input, actorId = null, knex = db }) {
  if (!isUuid(customerId)) throw opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.');
  const fields = readCalibration(input);
  const missing = CHECK_LABELS.filter(([key]) => !fields.checks[key]).map(([, label]) => label);
  const product = knownProduct(fields.epaRegNo);
  if (!input.propertyId) await ensureHomeRow(knex, customerId);

  const id = await knex.transaction(async (trx) => {
    await lockCustomer(trx, customerId);
    if (!(await customerExists(trx, customerId))) throw opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.');
    const propertyId = await resolveProperty(trx, customerId, input.propertyId);

    if (missing.length) {
      throw opError(422, 'MISTING_CHECKS_INCOMPLETE', `Check every box before saving. Not checked: ${missing.join('; ')}.`);
    }
    enforceProductLabel(fields, product);
    const math = computeCalibration(fields, product);
    if (!math.withinLabel) {
      throw opError(422, 'MISTING_OVER_LABEL', overLabelMessage(math.dailyOutputFlOz, math.labelDailyCapFlOz));
    }

    const [row] = await trx('misting_calibrations').insert({
      customer_id: customerId,
      property_id: propertyId,
      installed_on: fields.installedOn,
      vendor: fields.vendor,
      model: fields.model,
      serial_number: fields.serialNumber,
      tank_gallons: fields.tankGallons,
      zone_count: fields.zoneCount,
      nozzle_count: fields.nozzleCount,
      riser_count: fields.riserCount,
      nozzle_flow_fl_oz_per_min: fields.nozzleFlowFlOzPerMin,
      cycle_seconds: fields.cycleSeconds,
      mist_times: fields.mistTimes,
      product_name: fields.productName,
      epa_reg_no: fields.epaRegNo,
      concentrate_fl_oz_per_tank: fields.concentrateFlOzPerTank,
      label_max_fl_oz_per_1000_cu_ft_day: fields.labelMaxFlOzPer1000CuFtDay,
      treated_area_sq_ft: fields.treatedAreaSqFt,
      treated_height_ft: fields.treatedHeightFt,
      treated_volume_cu_ft: math.treatedVolumeCuFt,
      output_fl_oz_per_cycle: math.outputFlOzPerCycle,
      daily_output_fl_oz: math.dailyOutputFlOz,
      label_daily_cap_fl_oz: math.labelDailyCapFlOz,
      cabinet_locked: true,
      label_posted: true,
      schedule_avoids_people: true,
      notes: fields.notes,
      source: 'staff',
      recorded_by: actorId || null,
      // The lock is held, so the clock here orders rows even if this transaction began before the last writer's.
      created_at: trx.raw('clock_timestamp()'),
      updated_at: trx.raw('clock_timestamp()'),
    }).returning('id');
    return row.id || row;
  });
  return toCalibration(await calibrationRows(knex).where('c.id', id).first());
}

function readRefill(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the refill as an object.');
  const level = readNumber(input, 'levelBeforePct', 'Level before', { min: 0, max: 100, integer: true, unit: '%', optional: true });
  return {
    refilledOn: readDate(input, 'refilledOn', 'Refill date'),
    productName: readText(input, 'productName', 'Product', { max: 120, optional: true }),
    epaRegNo: input.epaRegNo === undefined || input.epaRegNo === null || input.epaRegNo === '' ? null : readEpa(input),
    concentrateFlOzAdded: roundTo(readNumber(input, 'concentrateFlOzAdded', 'Concentrate added', { min: 0.01, max: 300 * 128, unit: 'fl oz' }), 2),
    waterGallonsAdded: roundTo(readNumber(input, 'waterGallonsAdded', 'Water added', { min: 0.01, max: 300, unit: 'gallons' }), 2),
    levelBeforePct: level,
    counterReset: input.counterReset === true,
    notes: readText(input, 'notes', 'Notes', { max: 2000, optional: true }),
    calibrationId: input.calibrationId,
  };
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Log a tank refill against the customer's current calibration for that system. */
async function createRefill({ customerId, input, actorId = null, knex = db }) {
  if (!isUuid(customerId)) throw opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.');
  const fields = readRefill(input);
  if (!isUuid(fields.calibrationId)) throw bad('Pick the calibration this refill is for.');

  const id = await knex.transaction(async (trx) => {
    await lockCustomer(trx, customerId);
    if (!(await customerExists(trx, customerId))) throw opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.');
    const cal = await trx('misting_calibrations').where({ id: fields.calibrationId, customer_id: customerId }).first();
    if (!cal) throw opError(404, 'MISTING_CALIBRATION_NOT_FOUND', 'Calibration not found.');
    // A NULL property is history and never current, so a refill against it is refused here too.
    const current = cal.voided_at ? null : await currentCalibration(trx, customerId, cal.property_id);
    if (!current || current.id !== cal.id) {
      throw opError(409, 'MISTING_CALIBRATION_NOT_CURRENT', 'This calibration has been replaced. Reload and log the refill against the current one.');
    }

    const installedOn = dateOnly(cal.installed_on);
    if (fields.refilledOn < installedOn) throw bad(`Refill date cannot be before the install date (${installedOn}).`);
    if (fields.waterGallonsAdded > Number(cal.tank_gallons)) {
      throw bad(`Water added cannot be more than the tank size (${Number(cal.tank_gallons)} gallons).`);
    }
    if ((fields.productName && !same(fields.productName, cal.product_name)) || (fields.epaRegNo && !same(fields.epaRegNo, cal.epa_reg_no))) {
      throw opError(422, 'MISTING_PRODUCT_CHANGED', 'Record a new calibration first: the product changed.');
    }
    const calMix = Number(cal.concentrate_fl_oz_per_tank) / Number(cal.tank_gallons);
    const mix = fields.concentrateFlOzAdded / fields.waterGallonsAdded;
    if (Math.abs(mix - calMix) > REFILL_MIX_TOLERANCE * calMix) {
      throw opError(422, 'MISTING_MIX_CHANGED',
        `This mix is ${mix.toFixed(2)} fl oz per gallon; the calibration is ${calMix.toFixed(2)}. Record a new calibration first if the mix changed.`);
    }
    // The 10% slack must not carry a refill past the label: a known product's mix stays in its label range,
    // and at the refill's strength the system's daily output must still fit under the daily cap.
    const product = knownProduct(cal.epa_reg_no);
    if (product) enforceMixRange(product, mix);
    const calibrationPayload = toCalibration(cal);
    const cap = capAtMix({ calibration: calibrationPayload, mixFlOzPerGal: mix, product });
    if (calibrationPayload.dailyOutputFlOz > cap) {
      const [allowed, puts] = formatOzPair(cap, calibrationPayload.dailyOutputFlOz);
      throw opError(422, 'MISTING_REFILL_OVER_LABEL',
        `At this mix the label allows ${allowed} fl oz a day, and this system puts out ${puts}. Use the calibration's mix, or record a new calibration.`);
    }

    const [row] = await trx('misting_refills').insert({
      customer_id: customerId,
      calibration_id: cal.id,
      property_id: cal.property_id || null,
      refilled_on: fields.refilledOn,
      product_name: cal.product_name,
      epa_reg_no: cal.epa_reg_no,
      concentrate_fl_oz_added: fields.concentrateFlOzAdded,
      water_gallons_added: fields.waterGallonsAdded,
      level_before_pct: fields.levelBeforePct,
      counter_reset: fields.counterReset,
      notes: fields.notes,
      source: 'staff',
      recorded_by: actorId || null,
      created_at: trx.raw('clock_timestamp()'),
      updated_at: trx.raw('clock_timestamp()'),
    }).returning('id');
    return row.id || row;
  });
  return toRefill(await refillRows(knex).where('r.id', id).first());
}

function readReason(reason) {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < 3 || value.length > 300) throw bad('Say why in 3 to 300 characters.');
  return value;
}

async function voidRow({ table, id, reason, actorId, knex, notFound, blocker }) {
  if (!isUuid(id)) throw opError(404, 'MISTING_RECORD_NOT_FOUND', notFound);
  const why = readReason(reason);
  const peek = await knex(table).where({ id }).first('customer_id');
  if (!peek) throw opError(404, 'MISTING_RECORD_NOT_FOUND', notFound);
  await knex.transaction(async (trx) => {
    await lockCustomer(trx, peek.customer_id);
    const row = await trx(table).where({ id }).first('id', 'voided_at');
    if (!row) throw opError(404, 'MISTING_RECORD_NOT_FOUND', notFound);
    if (row.voided_at) throw opError(409, 'MISTING_ALREADY_VOIDED', 'This record is already voided.');
    if (blocker) await blocker(trx, id);
    await trx(table).where({ id }).update({
      voided_at: trx.fn.now(),
      voided_by: actorId || null,
      void_reason: why,
      updated_at: trx.fn.now(),
    });
  });
}

/** Void a calibration. Refused while it still has non-voided refills. */
async function voidCalibration({ id, reason, actorId = null, knex = db }) {
  await voidRow({
    table: 'misting_calibrations', id, reason, actorId, knex, notFound: 'Calibration not found.',
    blocker: async (trx, calibrationId) => {
      const open = await trx('misting_refills').where({ calibration_id: calibrationId }).whereNull('voided_at').first('id');
      if (open) throw opError(409, 'MISTING_CALIBRATION_HAS_REFILLS', 'Void its refills first, or record a new calibration instead.');
    },
  });
  return toCalibration(await calibrationRows(knex).where('c.id', id).first());
}

async function voidRefill({ id, reason, actorId = null, knex = db }) {
  await voidRow({ table: 'misting_refills', id, reason, actorId, knex, notFound: 'Refill not found.' });
  return toRefill(await refillRows(knex).where('r.id', id).first());
}

module.exports = {
  isUuid,
  recordsEnabled,
  listCustomerRecords,
  createCalibration,
  createRefill,
  voidCalibration,
  voidRefill,
  currentCalibration,
  toCalibration,
  toRefill,
  knownProduct,
};
