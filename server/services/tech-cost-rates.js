/**
 * Technician and vehicle cost rates (L11a, GATE_TECH_COST_RATES).
 *
 * Owner 2026-10-26: "we need real actual calculation, this ($35) was a number I
 * just thought." A cost card states what one technician and one vehicle cost the
 * company; this module turns a card into the two numbers job costing needs:
 * labor cost per worked hour, and vehicle cost (fixed per worked hour plus per
 * mile). It reads the cards and a technician's pay rate; it writes nothing.
 *
 * W-2 card, per year:
 *   paid hours   = paid_hours_per_week x 52
 *   wages        = technicians.pay_rate x paid hours
 *   health money = health_money_monthly x 12
 *   employer Social Security + Medicare = 7.65% of (wages + health money)
 *   FUTA and Florida reemployment tax = their rates on the first $7,000 of wages
 *                  only (payroll-calc.js RATES, never a second copy)
 *   workers' comp and retirement = their % of (wages + health money)
 *   worked hours = paid hours - paid_days_off_per_year x paid_hours_per_day
 *   labor per worked hour = total / worked hours (also shown per paid hour)
 * Imputed card: labor per worked hour = imputed_hourly_rate.
 *
 * Vehicle card: fixed per year = loss of value + insurance + loan interest +
 * other fixed. Fixed per worked hour = fixed per year / the worked hours of the
 * technician whose card names that vehicle (a technician's worked hours use the
 * same formula for both kinds of card). Per mile = fuel + upkeep.
 *
 * Rounding, stated once: every dollar line is rounded half up to the cent per
 * year; every per-hour figure is rounded half up to the cent from the yearly
 * cents; job costing uses those cent-rounded rates. A per-mile rate keeps four
 * decimals (the card stores four). The lines of a breakdown are each rounded on
 * their own, so per-hour lines can differ from their total by a cent.
 *
 * A card is in effect on a date when it has the greatest effective_date <= that
 * date (tie: newest created_at, then id). Before the first card there is NO
 * card: callers fall back to company_financials, never to the oldest card.
 */
const { RATES } = require('./payroll-calc');
const { payrollUnits } = require('../utils/payroll-units');

const WEEKS_PER_YEAR = 52;
const MONTHS_PER_YEAR = 12;

const cents = (value) => Number(payrollUnits(value == null ? 0 : value));
const hundredths = (value) => Number(payrollUnits(value == null ? 0 : value));
const tenThousandths = (value) => Math.round((Number(value) || 0) * 10000);
// Half-up integer division for non-negative integers.
const divRound = (numerator, denominator) => Math.floor((numerator * 2 + denominator) / (denominator * 2));
// pct is a percent in hundredths of a percent (2.00% -> 200), base is cents.
const pctOf = (baseCents, pctHundredths) => Math.floor((baseCents * pctHundredths + 5000) / 10000);
const bpOf = (baseCents, bp) => Math.floor((baseCents * bp + 5000) / 10000);

function dateString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // node-postgres reads a DATE as local midnight: read it with local getters.
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  }
  return null;
}

// Hours a technician works in a year, in hundredths of an hour. Both card kinds.
function yearHours(card) {
  const paid = hundredths(card.paid_hours_per_week) * WEEKS_PER_YEAR;
  const off = Math.round((hundredths(card.paid_days_off_per_year) * hundredths(card.paid_hours_per_day)) / 100);
  return { paidH: paid, workedH: paid - off };
}

function line(key, label, perYearCents, paidH, workedH) {
  return {
    key,
    label,
    perYearCents,
    perPaidHourCents: paidH > 0 ? divRound(perYearCents * 100, paidH) : 0,
    perWorkedHourCents: workedH > 0 ? divRound(perYearCents * 100, workedH) : 0,
  };
}

/**
 * Labor rate for one technician card. Returns { ok: true, ... } or
 * { ok: false, reason }. `payRate` is technicians.pay_rate (W-2 cards only).
 */
function computeTechnicianRate(card, payRate) {
  if (!card) return { ok: false, reason: 'no_card' };
  const { paidH, workedH } = yearHours(card);
  if (workedH <= 0) return { ok: false, reason: 'no_worked_hours' };
  const base = {
    kind: card.kind,
    paidHoursPerYear: paidH / 100,
    workedHoursPerYear: workedH / 100,
    workedHoursPerYearHundredths: workedH,
  };

  if (card.kind === 'imputed') {
    const rateCents = cents(card.imputed_hourly_rate);
    if (!(rateCents > 0)) return { ok: false, reason: 'no_imputed_rate' };
    const perYear = divRound(rateCents * workedH, 100);
    return {
      ok: true,
      ...base,
      laborPerWorkedHourCents: rateCents,
      laborPerPaidHourCents: divRound(perYear * 100, paidH),
      totalPerYearCents: perYear,
      lines: [line('stated_rate', 'Stated hourly rate x worked hours', perYear, paidH, workedH)],
    };
  }

  const payRateCents = cents(payRate);
  if (!(payRateCents > 0)) return { ok: false, reason: 'no_pay_rate' };
  const wages = divRound(payRateCents * paidH, 100);
  const health = cents(card.health_money_monthly) * MONTHS_PER_YEAR;
  const taxableBase = wages + health;
  const socialAndMedicare = bpOf(taxableBase, RATES.socialSecurityBp + RATES.medicareBp);
  const cappedWages = Math.min(wages, RATES.futaAndStateWageBaseCents);
  const futa = bpOf(cappedWages, RATES.futaBp);
  const reemployment = bpOf(cappedWages, RATES.floridaNewEmployerBp);
  const workersComp = pctOf(taxableBase, hundredths(card.workers_comp_pct));
  const retirement = pctOf(taxableBase, hundredths(card.retirement_pct));
  const total = wages + health + socialAndMedicare + futa + reemployment + workersComp + retirement;
  return {
    ok: true,
    ...base,
    laborPerWorkedHourCents: divRound(total * 100, workedH),
    laborPerPaidHourCents: divRound(total * 100, paidH),
    totalPerYearCents: total,
    lines: [
      line('wages', 'Wages', wages, paidH, workedH),
      line('health', 'Health money', health, paidH, workedH),
      line('social_medicare', 'Employer Social Security and Medicare', socialAndMedicare, paidH, workedH),
      line('futa', 'Federal unemployment tax (first $7,000)', futa, paidH, workedH),
      line('reemployment', 'Florida reemployment tax (first $7,000)', reemployment, paidH, workedH),
      line('workers_comp', 'Workers\' comp', workersComp, paidH, workedH),
      line('retirement', 'Retirement match', retirement, paidH, workedH),
    ],
  };
}

/**
 * Vehicle rate for one vehicle card, spread over `workedHundredths` hours (the
 * worked hours per year of the technician whose card names the vehicle).
 */
function computeVehicleRate(card, workedHundredths) {
  if (!card) return { ok: false, reason: 'no_card' };
  const fixed = [
    ['loss_of_value', 'Loss of value', card.loss_of_value_per_year],
    ['insurance', 'Insurance', card.insurance_per_year],
    ['loan_interest', 'Loan interest', card.loan_interest_per_year],
    ['other_fixed', 'Other fixed costs', card.other_fixed_per_year],
  ].map(([key, label, value]) => ({ key, label, perYearCents: cents(value) }));
  const fixedPerYearCents = fixed.reduce((sum, l) => sum + l.perYearCents, 0);
  const perMileTenThousandths = tenThousandths(card.fuel_per_mile) + tenThousandths(card.upkeep_per_mile);
  const hasHours = workedHundredths > 0;
  return {
    ok: true,
    fixedPerYearCents,
    fixedPerWorkedHourCents: hasHours ? divRound(fixedPerYearCents * 100, workedHundredths) : 0,
    perMileTenThousandths,
    perMile: perMileTenThousandths / 10000,
    fixedLines: fixed.map((l) => ({
      ...l,
      perWorkedHourCents: hasHours ? divRound(l.perYearCents * 100, workedHundredths) : 0,
    })),
    spreadOverHoursPerYear: hasHours ? workedHundredths / 100 : null,
  };
}

const CARD_ORDER = [
  { column: 'effective_date', order: 'desc' },
  { column: 'created_at', order: 'desc', nulls: 'last' },
  { column: 'id', order: 'desc' },
];

// The card in effect on a date, or null (before the first card: none).
async function cardInEffect(conn, table, keyColumn, keyId, onDate) {
  const dateStr = dateString(onDate);
  if (!keyId || !dateStr) return null;
  return (await conn(table)
    .where(keyColumn, keyId)
    .where('effective_date', '<=', dateStr)
    .orderBy(CARD_ORDER)
    .first()) || null;
}

/**
 * The rates job costing needs for one visit: null when the technician has no
 * card in effect on the visit date, or the card cannot give a rate (W-2 card
 * with no pay rate). Never throws; a read failure is "no rate" so costing falls
 * back to today's path.
 */
async function loadVisitRates(conn, technicianId, onDate) {
  try {
    const card = await cardInEffect(conn, 'technician_cost_cards', 'technician_id', technicianId, onDate);
    if (!card) return null;
    let payRate = null;
    if (card.kind === 'w2') {
      const tech = await conn('technicians').where({ id: technicianId }).first('pay_rate');
      payRate = tech ? tech.pay_rate : null;
    }
    const labor = computeTechnicianRate(card, payRate);
    if (!labor.ok) return null;
    let vehicle = null;
    if (card.vehicle_equipment_id) {
      const vehicleCard = await cardInEffect(conn, 'vehicle_cost_cards', 'equipment_id', card.vehicle_equipment_id, onDate);
      const rate = vehicleCard ? computeVehicleRate(vehicleCard, labor.workedHoursPerYearHundredths) : null;
      if (rate && rate.ok) {
        vehicle = {
          cardId: vehicleCard.id,
          equipmentId: card.vehicle_equipment_id,
          perMileTenThousandths: rate.perMileTenThousandths,
          fixedPerWorkedHourCents: rate.fixedPerWorkedHourCents,
        };
      }
    }
    return {
      cardId: card.id,
      kind: card.kind,
      laborPerWorkedHourCents: labor.laborPerWorkedHourCents,
      vehicle,
    };
  } catch {
    return null;
  }
}

// For the admin screen: every technician and vehicle with the rates in effect on a date.
async function loadRatesForDate(conn, onDate) {
  const dateStr = dateString(onDate);
  const technicians = await conn('technicians').orderBy('name').select('id', 'name', 'pay_rate', 'employment_type', 'employment_status');
  const out = { date: dateStr, technicians: [], vehicles: [] };
  const vehicleHours = new Map();
  for (const tech of technicians) {
    const card = await cardInEffect(conn, 'technician_cost_cards', 'technician_id', tech.id, dateStr);
    if (!card) continue;
    const labor = computeTechnicianRate(card, tech.pay_rate);
    out.technicians.push({
      technicianId: tech.id,
      name: tech.name,
      cardId: card.id,
      effectiveDate: dateString(card.effective_date),
      vehicleEquipmentId: card.vehicle_equipment_id || null,
      ...(labor.ok ? labor : { ok: false, reason: labor.reason }),
    });
    if (labor.ok && card.vehicle_equipment_id) {
      vehicleHours.set(card.vehicle_equipment_id, labor.workedHoursPerYearHundredths);
    }
  }
  const equipment = await conn('equipment').where({ category: 'vehicle' }).orderBy('name').select('id', 'name');
  for (const item of equipment) {
    const card = await cardInEffect(conn, 'vehicle_cost_cards', 'equipment_id', item.id, dateStr);
    if (!card) continue;
    const rate = computeVehicleRate(card, vehicleHours.get(item.id) || 0);
    out.vehicles.push({
      equipmentId: item.id,
      name: item.name,
      cardId: card.id,
      effectiveDate: dateString(card.effective_date),
      ...rate,
    });
  }
  return out;
}

module.exports = {
  computeTechnicianRate,
  computeVehicleRate,
  cardInEffect,
  loadVisitRates,
  loadRatesForDate,
  dateString,
};
