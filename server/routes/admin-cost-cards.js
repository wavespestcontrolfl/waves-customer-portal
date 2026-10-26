/**
 * Admin cost cards (L11a), dark behind GATE_TECH_COST_RATES. Admin only.
 *
 * GET  /                              { enabled, technicians, vehicles }: every technician and every
 *                                     vehicle (equipment category 'vehicle') with its card history,
 *                                     newest first.
 * POST /technicians/:id               add a technician card (201 { card }). A card is never edited;
 *                                     a change is a new card with a later effective date.
 * POST /vehicles/:equipmentId         add a vehicle card (201 { card }).
 * GET  /rates?date=YYYY-MM-DD         each technician's and vehicle's computed rates and breakdown
 *                                     on that date (default today, Eastern).
 *
 * Off answers 404 { enabled: false } on every route but GET /, which answers 200 { enabled: false }
 * so the Settings page can tell "off" from an error. Every write is audited (ids only).
 */
const express = require('express');
const Joi = require('joi');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { recordAuditEvent } = require('../services/audit-log');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { techCostRatesLive } = require('../config/feature-gates');
const { loadRatesForDate, dateString } = require('../services/tech-cost-rates');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const on = () => typeof techCostRatesLive === 'function' && techCostRatesLive();

class CardError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CardError';
    this.status = status;
  }
}

// A number with at most `places` decimals (the column's own scale), so a typo is
// refused, never silently rounded.
const num = (min, max, places) => Joi.number().min(min).max(max).custom((value, helpers) => {
  const scaled = value * (10 ** places);
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return helpers.error('number.precision', { limit: places });
  return value;
}).messages({ 'number.precision': `{{#label}} can have at most ${places} decimal places` });

const dateField = Joi.string().custom((value, helpers) => (validCalendarDate(value) ? value : helpers.error('any.invalid')))
  .messages({ 'any.invalid': '{{#label}} must be a real date (YYYY-MM-DD)' });
const noteField = Joi.string().trim().allow('', null).max(500);

const technicianCardSchema = Joi.object({
  effectiveDate: dateField,
  kind: Joi.string().valid('w2', 'imputed').required(),
  imputedHourlyRate: num(0, 1000, 2).allow(null),
  paidHoursPerWeek: num(0.01, 168, 2).default(40),
  paidHoursPerDay: num(0.01, 24, 2).default(10),
  healthMoneyMonthly: num(0, 100000, 2).default(0),
  retirementPct: num(0, 100, 2).default(0),
  workersCompPct: num(0, 100, 2).default(0),
  paidDaysOffPerYear: num(0, 120, 1).default(0),
  vehicleEquipmentId: Joi.string().pattern(UUID_RE).allow(null, ''),
  note: noteField,
});

const vehicleCardSchema = Joi.object({
  effectiveDate: dateField,
  lossOfValuePerYear: num(0, 10000000, 2).default(0),
  insurancePerYear: num(0, 10000000, 2).default(0),
  loanInterestPerYear: num(0, 10000000, 2).default(0),
  otherFixedPerYear: num(0, 10000000, 2).default(0),
  fuelPerMile: num(0, 100, 4).default(0),
  upkeepPerMile: num(0, 100, 4).default(0),
  note: noteField,
});

function validate(schema, body) {
  const { value, error } = schema.validate(body || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new CardError(400, error.details[0].message);
  return value;
}

function fail(res, what, err) {
  if (err && err.name === 'CardError') return res.status(err.status).json({ error: err.message });
  logger.error(`[admin-cost-cards] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
  return res.status(500).json({ error: 'Cost cards failed. Try again.' });
}

const n = (v) => (v == null ? null : Number(v));

function technicianCardOut(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    effectiveDate: dateString(row.effective_date),
    kind: row.kind,
    imputedHourlyRate: n(row.imputed_hourly_rate),
    paidHoursPerWeek: n(row.paid_hours_per_week),
    paidHoursPerDay: n(row.paid_hours_per_day),
    healthMoneyMonthly: n(row.health_money_monthly),
    retirementPct: n(row.retirement_pct),
    workersCompPct: n(row.workers_comp_pct),
    paidDaysOffPerYear: n(row.paid_days_off_per_year),
    vehicleEquipmentId: row.vehicle_equipment_id || null,
    note: row.note || null,
    createdAt: row.created_at,
  };
}

function vehicleCardOut(row) {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    effectiveDate: dateString(row.effective_date),
    lossOfValuePerYear: n(row.loss_of_value_per_year),
    insurancePerYear: n(row.insurance_per_year),
    loanInterestPerYear: n(row.loan_interest_per_year),
    otherFixedPerYear: n(row.other_fixed_per_year),
    fuelPerMile: n(row.fuel_per_mile),
    upkeepPerMile: n(row.upkeep_per_mile),
    note: row.note || null,
    createdAt: row.created_at,
  };
}

const HISTORY_ORDER = [
  { column: 'effective_date', order: 'desc' },
  { column: 'created_at', order: 'desc', nulls: 'last' },
  { column: 'id', order: 'desc' },
];

router.get('/', async (req, res) => {
  if (!on()) return res.json({ enabled: false });
  try {
    const technicians = await db('technicians').orderBy('name')
      .select('id', 'name', 'pay_rate', 'employment_type', 'employment_status');
    const techCards = await db('technician_cost_cards').orderBy(HISTORY_ORDER);
    const vehicles = await db('equipment').where({ category: 'vehicle' }).orderBy('name').select('id', 'name', 'status');
    const vehicleCards = await db('vehicle_cost_cards').orderBy(HISTORY_ORDER);
    return res.json({
      enabled: true,
      today: etDateString(),
      technicians: technicians.map((t) => ({
        id: t.id,
        name: t.name,
        payRate: n(t.pay_rate),
        employmentType: t.employment_type || null,
        employmentStatus: t.employment_status || null,
        cards: techCards.filter((c) => c.technician_id === t.id).map(technicianCardOut),
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        name: v.name,
        status: v.status || null,
        cards: vehicleCards.filter((c) => c.equipment_id === v.id).map(vehicleCardOut),
      })),
    });
  } catch (err) { return fail(res, 'list cards', err); }
});

router.use((req, res, next) => {
  if (!on()) return res.status(404).json({ enabled: false });
  return next();
});

router.get('/rates', async (req, res) => {
  try {
    const date = req.query.date == null || req.query.date === '' ? etDateString() : String(req.query.date);
    if (!validCalendarDate(date)) throw new CardError(400, 'date must be a real date (YYYY-MM-DD)');
    return res.json(await loadRatesForDate(db, date));
  } catch (err) { return fail(res, 'read rates', err); }
});

router.post('/technicians/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) throw new CardError(404, 'Technician not found.');
    const v = validate(technicianCardSchema, req.body);
    if (v.kind === 'imputed' && !(v.imputedHourlyRate > 0)) {
      throw new CardError(400, 'An imputed card needs an hourly rate above zero.');
    }
    const tech = await db('technicians').where({ id: req.params.id }).first('id', 'pay_rate');
    if (!tech) throw new CardError(404, 'Technician not found.');
    if (v.kind === 'w2' && !(Number(tech.pay_rate) > 0)) {
      throw new CardError(400, 'Set the technician\'s pay rate before adding a W-2 card.');
    }
    const vehicleId = v.vehicleEquipmentId || null;
    if (vehicleId) {
      const vehicle = await db('equipment').where({ id: vehicleId, category: 'vehicle' }).first('id');
      if (!vehicle) throw new CardError(400, 'That vehicle was not found.');
    }
    const actorId = req.technicianId || null;
    const card = await db.transaction(async (trx) => {
      const [inserted] = await trx('technician_cost_cards').insert({
        technician_id: req.params.id,
        effective_date: v.effectiveDate || etDateString(),
        kind: v.kind,
        imputed_hourly_rate: v.kind === 'imputed' ? v.imputedHourlyRate : null,
        paid_hours_per_week: v.paidHoursPerWeek,
        paid_hours_per_day: v.paidHoursPerDay,
        health_money_monthly: v.healthMoneyMonthly,
        retirement_pct: v.retirementPct,
        workers_comp_pct: v.workersCompPct,
        paid_days_off_per_year: v.paidDaysOffPerYear,
        vehicle_equipment_id: vehicleId,
        note: v.note || null,
        created_by: actorId,
      }).returning('*');
      // Audit metadata is ids only: no amounts, no note.
      await recordAuditEvent({
        trx, critical: true, actor_type: 'admin', actor_id: actorId,
        action: 'cost_cards.technician_card_added', resource_type: 'technician_cost_cards', resource_id: inserted.id,
        metadata: { technician_id: req.params.id, card_id: inserted.id },
      });
      return inserted;
    });
    return res.status(201).json({ card: technicianCardOut(card) });
  } catch (err) { return fail(res, 'add technician card', err); }
});

router.post('/vehicles/:equipmentId', async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.equipmentId))) throw new CardError(404, 'Vehicle not found.');
    const v = validate(vehicleCardSchema, req.body);
    const vehicle = await db('equipment').where({ id: req.params.equipmentId, category: 'vehicle' }).first('id');
    if (!vehicle) throw new CardError(404, 'Vehicle not found.');
    const actorId = req.technicianId || null;
    const card = await db.transaction(async (trx) => {
      const [inserted] = await trx('vehicle_cost_cards').insert({
        equipment_id: req.params.equipmentId,
        effective_date: v.effectiveDate || etDateString(),
        loss_of_value_per_year: v.lossOfValuePerYear,
        insurance_per_year: v.insurancePerYear,
        loan_interest_per_year: v.loanInterestPerYear,
        other_fixed_per_year: v.otherFixedPerYear,
        fuel_per_mile: v.fuelPerMile,
        upkeep_per_mile: v.upkeepPerMile,
        note: v.note || null,
        created_by: actorId,
      }).returning('*');
      await recordAuditEvent({
        trx, critical: true, actor_type: 'admin', actor_id: actorId,
        action: 'cost_cards.vehicle_card_added', resource_type: 'vehicle_cost_cards', resource_id: inserted.id,
        metadata: { equipment_id: req.params.equipmentId, card_id: inserted.id },
      });
      return inserted;
    });
    return res.status(201).json({ card: vehicleCardOut(card) });
  } catch (err) { return fail(res, 'add vehicle card', err); }
});

module.exports = router;
