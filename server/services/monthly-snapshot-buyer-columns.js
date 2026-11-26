/**
 * The buyer-view columns of the monthly financial snapshot (owner approved 2026-11-26). Read-only: sends nothing,
 * charges nothing, writes nothing. monthly-financial-snapshot.js calls buyerColumns() inside its REPEATABLE READ
 * transaction and stores the result.
 *
 *   owner_field_hours / owner_field_allowance   the owner's completed stops x the job-costing standard minutes, x the
 *                                               owner field hourly rate in effect on the month's last day
 *   book_gross_margin_pct                       P&L basis (buildPnlReport): revenue - COGS categories - pay-run wages (when
 *                                               GATE_PNL_PAY_RUN_WAGES) - owner field allowance, over revenue
 *   sde                                         EBITDA = P&L net income + depreciation + interest. The books carry no owner
 *                                               pay, so this is the cash before any owner pay.
 *   owner_paid_profit                           sde - owner office allowance - owner field allowance
 *   recurring_revenue / recurring_mature_revenue / autopay_renewing_share
 *                                               visit revenue (service_records.revenue, job-costing's stored figure) of plan
 *                                               members, of members at least 12 months old, and its share on chargeable autopay
 *   prepaid_owed                                annual-prepay money collected for visits not done by month end
 *
 * Where each rule lives (CLAUDE.md rule 22): standard minutes = job-costing JOB_COST_STANDARD / standardLaborMinutesFor;
 * what a visit earns = job-costing (read from service_records.revenue, never restated); plan members = billing-lane
 * MEMBERSHIP_TIER_SQL; internal test accounts = mrr-breakdown excludeInternalTestCustomers; chargeable autopay =
 * autopay-eligibility autopayActivePredicate; paid prepay terms = annual-prepay-renewals coveredTermsAsOf; the owner =
 * the owner login (intelligence-bar/ib-access fullAccessAllowlist); the P&L = pnl-report buildPnlReport.
 */

const { MEMBERSHIP_TIER_SQL } = require('./billing-lane');
const { excludeInternalTestCustomers } = require('./mrr-breakdown');
const { autopayActivePredicate } = require('./autopay-eligibility');
const { fullAccessAllowlist } = require('./intelligence-bar/ib-access');
const { standardLaborMinutesFor, JOB_COST_STANDARD } = require('./job-costing');

const ADD_BACK_CATEGORIES = ['Interest', 'Depreciation'];
const MATURE_PLAN_MONTHS = 12;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Hours x hourly rate in dollars, taken on integers (hundredths of an hour x cents) and rounded once to whole cents:
 * 2.50 h x $21.29 = 53.225 -> 53.23. Both inputs are exact to two decimals (numeric(6,2), numeric(8,2)). Null or 0 on
 * either one = not counted (0).
 */
function timeAllowance(hours, hourlyRate) {
  const hundredths = Math.round(num(hours) * 100);
  const rateCents = Math.round(num(hourlyRate) * 100);
  if (hundredths <= 0 || rateCents <= 0) return 0;
  return Math.round((hundredths * rateCents) / 100) / 100;
}

/**
 * The owner's technician row: the one admin login on the owner allow-list (IB_FULL_ACCESS_EMAILS, default the owner's
 * contact address), the same identity the owner-only actions use. { id, onPayroll } or null when zero or several rows
 * match: an ambiguous owner is "unavailable", never a guess. onPayroll = the row is a W-2 employee, so a paycheck (not
 * an allowance) pays for the owner's time.
 */
async function resolveOwnerTechnician(db) {
  const rows = await db('technicians')
    .where('role', 'admin')
    .whereRaw('lower(btrim(email)) = ANY(?)', [fullAccessAllowlist()])
    .select('id', 'employment_type');
  if (rows.length !== 1) return null;
  return { id: rows[0].id, onPayroll: rows[0].employment_type === 'w2' };
}

/**
 * Minutes of the owner's field time in [startDate, endDate]: per physical stop (a grouped visit, scheduled_services.
 * visit_id, is one stop) the sum of its services' standard on-site minutes, plus one standard drive. A service type
 * with no standard (a specialty or one-off job) keeps job-costing's costed labor_hours. App tap spans are never read.
 * Every completed stop counts, callbacks included: the owner's time was spent.
 */
async function ownerFieldMinutes(db, ownerId, startDate, endDate) {
  const rows = await db('service_records as sr')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.status', 'completed')
    .whereBetween('sr.service_date', [startDate, endDate])
    .whereRaw('COALESCE(sr.technician_id, ss.technician_id) = ?', [ownerId])
    .select(db.raw('COALESCE(ss.visit_id::text, sr.id::text) AS stop_key'), 'sr.service_type', 'sr.labor_hours');
  const onSiteByStop = new Map();
  for (const row of rows) {
    const standard = standardLaborMinutesFor(row.service_type);
    const minutes = standard != null ? standard : num(row.labor_hours) * 60;
    onSiteByStop.set(row.stop_key, (onSiteByStop.get(row.stop_key) || 0) + minutes);
  }
  let total = 0;
  for (const onSite of onSiteByStop.values()) total += onSite + JOB_COST_STANDARD.defaultDriveMinutes;
  return { minutes: total, stops: onSiteByStop.size };
}

/**
 * Owner field hours and allowance for a month. hours: null when the owner cannot be resolved. allowance: 0 when no rate
 * is set or a paycheck covers the time; null when a rate is set but the owner is not resolvable (unavailable).
 */
async function ownerFieldTime(db, financials, startDate, endDate) {
  const rate = num(financials && financials.owner_field_hourly_rate);
  const owner = await resolveOwnerTechnician(db);
  if (!owner) return { hours: null, allowance: rate > 0 ? null : 0, onPayroll: false };
  const { minutes } = await ownerFieldMinutes(db, owner.id, startDate, endDate);
  // Hundredths of an hour, the precision the column and the allowance both use.
  const hours = Math.round((minutes / 60) * 100) / 100;
  return { hours, allowance: owner.onPayroll ? 0 : timeAllowance(hours, rate), onPayroll: owner.onPayroll };
}

/** The P&L's EBITDA: net income with depreciation (the asset schedule) and interest (ledger categories) added back. */
function ebitdaOf(pnl) {
  const categories = (pnl.operatingExpenses && pnl.operatingExpenses.categories) || [];
  const addedBack = categories
    .filter((c) => ADD_BACK_CATEGORIES.includes(c.name))
    .reduce((sum, c) => sum + num(c.amount), 0);
  return round2(num(pnl.netIncome) + num((pnl.deductions || {}).depreciation) + addedBack);
}

/** Profit figures of a month; all three are null when a paycheck covers the owner (the paycheck would have to be added back). */
function profitColumns({ pnl, officeAllowance, field, cashRevenue }) {
  const empty = { book_gross_margin_pct: null, owner_paid_profit: null, sde: null };
  if (field.onPayroll) return empty;
  const sde = ebitdaOf(pnl);
  if (field.allowance == null) return { ...empty, sde };
  return {
    book_gross_margin_pct: cashRevenue > 0 ? round2(((num(pnl.grossProfit) - field.allowance) / cashRevenue) * 100) : null,
    owner_paid_profit: round2(sde - officeAllowance - field.allowance),
    sde,
  };
}

/**
 * Visit revenue of plan members in the window, with the part from members at least 12 months old at the window start
 * and the part from customers on chargeable autopay (as of now: no history of a customer's payment method is kept).
 * Same revenue basis as the snapshot's completed_job_revenue, so recurring_revenue is a slice of it.
 */
async function recurringRevenue(db, startDate, endDate, now) {
  const autopay = autopayActivePredicate(now);
  const row = await db('service_records as sr')
    .join('customers as c', 'c.id', 'sr.customer_id')
    .whereBetween('sr.service_date', [startDate, endDate])
    .whereNotNull('sr.revenue')
    .whereRaw(MEMBERSHIP_TIER_SQL)
    .modify(excludeInternalTestCustomers(db))
    .select(
      db.raw('COALESCE(SUM(sr.revenue), 0)::text AS recurring'),
      db.raw(
        `COALESCE(SUM(sr.revenue) FILTER (WHERE COALESCE(c.member_since, (c.created_at AT TIME ZONE 'America/New_York')::date)
          <= (?::date - make_interval(months => ?))), 0)::text AS mature`,
        [startDate, MATURE_PLAN_MONTHS],
      ),
      db.raw(`COALESCE(SUM(sr.revenue) FILTER (WHERE ${autopay.sql}), 0)::text AS autopay`, [autopay.binding]),
    )
    .first();
  const recurring = round2(row && row.recurring);
  return {
    recurring_revenue: recurring,
    recurring_mature_revenue: round2(row && row.mature),
    autopay_renewing_share: recurring > 0 ? Math.round((num(row.autopay) / recurring) * 10000) / 10000 : null,
  };
}

/**
 * Annual-prepay money collected and not yet earned at month end: for each term with paid coverage (coveredTermsAsOf with
 * no date: a paid status, an invoice not void or refunded, a payment not fully refunded) whose window holds the month's
 * last day and whose invoice was paid by then, the prepay amount less the revenue of its visits completed by then.
 * A visit's revenue is its prepay share (job-costing rule 1), so the difference is the share of visits still to do.
 * This is NOT the dashboard's "Deposits on Hand" (the retired estimate-deposit ledger, a different pool of money).
 * Coverage status is read as of today: a term that was later cancelled or refunded is not counted for older months.
 */
async function prepaidOwed(db, endDate) {
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const row = await coveredTermsAsOf(db, null)
    .where('t.prepay_amount', '>', 0)
    .where('t.term_start', '<=', endDate)
    .where('t.term_end', '>=', endDate)
    .whereRaw("COALESCE((i.paid_at AT TIME ZONE 'America/New_York')::date, (t.created_at AT TIME ZONE 'America/New_York')::date) <= ?::date", [endDate])
    .select(db.raw(
      `COALESCE(SUM(GREATEST(t.prepay_amount - COALESCE((
         SELECT SUM(sr.revenue) FROM scheduled_services ss
           JOIN service_records sr ON sr.scheduled_service_id = ss.id
          WHERE ss.annual_prepay_term_id = t.id AND sr.status = 'completed'
            AND sr.service_date <= ?::date AND sr.revenue IS NOT NULL), 0), 0))::text, '0') AS owed`,
      [endDate],
    ))
    .first();
  return round2(row && row.owed);
}

/** Every buyer-view column of one month. `pnl` is the month's buildPnlReport result; pure reads on `db`. */
async function buyerColumns(db, { startDate, endDate, financials, pnl, officeAllowance, cashRevenue, now = new Date() }) {
  const [field, recurring, owed] = await Promise.all([
    ownerFieldTime(db, financials, startDate, endDate),
    recurringRevenue(db, startDate, endDate, now),
    prepaidOwed(db, endDate),
  ]);
  return {
    owner_field_hours: field.hours,
    owner_field_allowance: field.allowance,
    ...profitColumns({ pnl, officeAllowance, field, cashRevenue }),
    ...recurring,
    prepaid_owed: owed,
  };
}

module.exports = {
  timeAllowance,
  resolveOwnerTechnician,
  ownerFieldMinutes,
  ownerFieldTime,
  ebitdaOf,
  profitColumns,
  recurringRevenue,
  prepaidOwed,
  buyerColumns,
  ADD_BACK_CATEGORIES,
};
