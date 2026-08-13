const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etParts, etDateString } = require('../utils/datetime-et');
const {
  buildPnlReport, getPeriodRange, paidRevenueForWindow, rateAsOf, dateCellStr,
  prorateAssetDepreciation, annotateMidQuarter, outflowTransactionsQuery,
} = require('../services/pnl-report');
const { invoiceAmountDue } = require('../services/invoice-helpers');

router.use(adminAuthenticate, requireTechOrAdmin);

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

router.get('/dashboard', async (req, res, next) => {
  try {
    const year = String(new Date().getFullYear());

    // Sales tax collected is NOT recorded anywhere in the portal (the old
    // read targeted a revenue_daily table that never existed, so this was a
    // permanent $0 masquerading as a real figure). null = "not recorded",
    // which the client renders as "—" — never as a confident $0.
    const ytdTaxCollected = null;

    // Expenses YTD
    const expenseStats = await db('expenses')
      .where('tax_year', year)
      .select(
        db.raw('COALESCE(SUM(amount), 0) as total'),
        db.raw('COALESCE(SUM(tax_deductible_amount), 0) as deductible'),
        db.raw('COUNT(*) as count'),
      ).first().catch(() => ({ total: 0, deductible: 0, count: 0 }));

    // Equipment
    const equipStats = await db('equipment_register').where('active', true)
      .select(
        db.raw('COUNT(*) as count'),
        db.raw('COALESCE(SUM(purchase_cost), 0) as total_cost'),
        db.raw('COALESCE(SUM(current_book_value), 0) as book_value'),
        db.raw('COALESCE(SUM(accumulated_depreciation), 0) as total_depreciation'),
      ).first().catch(() => ({ count: 0, total_cost: 0, book_value: 0, total_depreciation: 0 }));

    // Overdue AND upcoming deadlines, fetched SEPARATELY so a pile of old
    // overdue rows can't crowd out (and hide) current/upcoming filings. Overdue
    // leads the list most-recent-first (nearest actionable), then upcoming
    // soonest-first — so the "Next Deadline" headline shows the most pressing
    // item and both groups always have room.
    const [overdueDeadlines, upcomingDeadlines] = await Promise.all([
      db('tax_filing_calendar')
        .whereNot('status', 'filed')
        .where('due_date', '<', db.fn.now())
        .orderBy('due_date', 'desc').limit(3)
        .catch(() => []),
      db('tax_filing_calendar')
        .whereNot('status', 'filed')
        .where('due_date', '>=', db.fn.now())
        .orderBy('due_date', 'asc').limit(5)
        .catch(() => []),
    ]);
    const nextDeadlines = [...overdueDeadlines, ...upcomingDeadlines];

    // Pending advisor alerts
    const alertCounts = await db('tax_advisor_alerts')
      .where('status', 'new')
      .select('priority')
      .count('* as count')
      .groupBy('priority')
      .catch(() => []);

    // Latest advisor report
    const latestReport = await db('tax_advisor_reports')
      .orderBy('report_date', 'desc').first()
      .catch(() => null);

    // Exemptions expiring soon
    const expiringExemptions = await db('tax_exemptions')
      .where('active', true)
      .where('expiry_date', '<=', db.raw("NOW() + INTERVAL '90 days'"))
      .where('expiry_date', '>=', db.fn.now())
      .count('* as count').first()
      .catch(() => ({ count: 0 }));

    res.json({
      ytdTaxCollected,
      expenses: {
        total: parseFloat(expenseStats.total),
        deductible: parseFloat(expenseStats.deductible),
        count: parseInt(expenseStats.count),
      },
      equipment: {
        count: parseInt(equipStats.count),
        totalCost: parseFloat(equipStats.total_cost),
        bookValue: parseFloat(equipStats.book_value),
        totalDepreciation: parseFloat(equipStats.total_depreciation),
      },
      nextDeadlines: nextDeadlines.map(d => ({
        id: d.id, type: d.filing_type, title: d.title,
        period: d.period_label, dueDate: d.due_date, status: d.status,
        amountDue: d.amount_due ? parseFloat(d.amount_due) : null,
      })),
      pendingAlerts: alertCounts.reduce((a, c) => { a[c.priority] = parseInt(c.count); return a; }, {}),
      latestReport: latestReport ? {
        date: latestReport.report_date, grade: latestReport.grade,
        summary: latestReport.executive_summary,
      } : null,
      expiringExemptions: parseInt(expiringExemptions?.count || 0),
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// TAX RATES
// ═══════════════════════════════════════════════════════════════

router.get('/rates', async (req, res, next) => {
  try {
    const rates = await db('tax_rates').orderBy([{ column: 'active', order: 'desc' }, { column: 'county' }]);
    res.json({
      rates: rates.map(r => ({
        id: r.id, county: r.county, state: r.state,
        stateRate: parseFloat(r.state_rate), countySurtax: parseFloat(r.county_surtax),
        combinedRate: parseFloat(r.combined_rate),
        effectiveDate: r.effective_date, expiryDate: r.expiry_date,
        serviceZone: r.service_zone, notes: r.notes, active: r.active,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/rates', async (req, res, next) => {
  try {
    const { county, stateRate, countySurtax, effectiveDate, serviceZone, notes } = req.body;
    await db.transaction(async (trx) => {
      await trx('tax_rates').where({ county, active: true }).update({ active: false, expiry_date: effectiveDate });
      await trx('tax_rates').insert({
        county, state: 'FL', state_rate: stateRate, county_surtax: countySurtax,
        combined_rate: parseFloat(stateRate) + parseFloat(countySurtax),
        effective_date: effectiveDate, service_zone: serviceZone, notes, active: true,
      });
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// SERVICE TAXABILITY
// ═══════════════════════════════════════════════════════════════

router.get('/service-taxability', async (req, res, next) => {
  try {
    const services = await db('service_taxability').orderBy('service_label');
    res.json({
      services: services.map(s => ({
        id: s.id, serviceKey: s.service_key, serviceLabel: s.service_label,
        isTaxable: s.is_taxable, taxCategory: s.tax_category,
        flStatuteRef: s.fl_statute_ref, notes: s.notes,
      })),
    });
  } catch (err) { next(err); }
});

router.put('/service-taxability/:id', async (req, res, next) => {
  try {
    const { isTaxable, notes, flStatuteRef } = req.body;
    const update = { updated_at: new Date() };
    if (isTaxable !== undefined) update.is_taxable = isTaxable;
    if (notes !== undefined) update.notes = notes;
    if (flStatuteRef !== undefined) update.fl_statute_ref = flStatuteRef;
    await db('service_taxability').where({ id: req.params.id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// TAX EXEMPTIONS
// ═══════════════════════════════════════════════════════════════

router.get('/exemptions', async (req, res, next) => {
  try {
    const exemptions = await db('tax_exemptions')
      .leftJoin('customers', 'tax_exemptions.customer_id', 'customers.id')
      .select('tax_exemptions.*', 'customers.first_name', 'customers.last_name')
      .orderBy('tax_exemptions.created_at', 'desc');
    res.json({
      exemptions: exemptions.map(e => ({
        id: e.id, customerId: e.customer_id,
        customerName: e.customer_name || (e.first_name ? `${e.first_name} ${e.last_name}` : 'Unknown'),
        exemptionType: e.exemption_type, certificateNumber: e.certificate_number,
        issueDate: e.issue_date, expiryDate: e.expiry_date,
        verified: e.verified, active: e.active, notes: e.notes,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/exemptions', async (req, res, next) => {
  try {
    const { customerId, customerName, exemptionType, certificateNumber, issueDate, expiryDate, notes } = req.body;
    await db('tax_exemptions').insert({
      customer_id: customerId || null, customer_name: customerName,
      exemption_type: exemptionType, certificate_number: certificateNumber,
      issue_date: issueDate, expiry_date: expiryDate, notes, active: true,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.put('/exemptions/:id', async (req, res, next) => {
  try {
    const fields = req.body;
    const update = { updated_at: new Date() };
    const map = { verified: 'verified', active: 'active', expiryDate: 'expiry_date', notes: 'notes', certificateNumber: 'certificate_number' };
    for (const [k, col] of Object.entries(map)) { if (fields[k] !== undefined) update[col] = fields[k]; }
    await db('tax_exemptions').where({ id: req.params.id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// EQUIPMENT REGISTER
// ═══════════════════════════════════════════════════════════════

router.get('/equipment', async (req, res, next) => {
  try {
    const equipment = await db('equipment_register').orderBy([{ column: 'active', order: 'desc' }, { column: 'name' }]);
    res.json({
      equipment: equipment.map(e => ({
        id: e.id, name: e.name, description: e.description,
        assetCategory: e.asset_category, irsClass: e.irs_class,
        purchaseDate: e.purchase_date, placedInServiceDate: e.placed_in_service_date,
        purchaseCost: parseFloat(e.purchase_cost),
        salvageValue: parseFloat(e.salvage_value || 0),
        depreciationMethod: e.depreciation_method,
        usefulLifeYears: e.useful_life_years,
        annualDepreciation: e.annual_depreciation ? parseFloat(e.annual_depreciation) : null,
        accumulatedDepreciation: parseFloat(e.accumulated_depreciation || 0),
        currentBookValue: parseFloat(e.current_book_value || 0),
        section179Elected: e.section_179_elected,
        section179Amount: e.section_179_amount ? parseFloat(e.section_179_amount) : null,
        // Listed-property business use + MACRS averaging convention — the CPA-
        // adjustable inputs to the depreciation schedule.
        businessUsePct: e.business_use_pct != null ? parseFloat(e.business_use_pct) : 100,
        businessUseConfirmed: e.business_use_confirmed === true,
        luxuryAutoExempt: e.luxury_auto_exempt === true,
        depreciationConvention: e.depreciation_convention || 'half_year',
        serialNumber: e.serial_number, makeModel: e.make_model,
        location: e.location, active: e.active,
        disposed: e.disposed, disposalDate: e.disposal_date,
        notes: e.notes,
      })),
    });
  } catch (err) { next(err); }
});

const VALID_DEPRECIATION_METHODS = ['MACRS', 'SL', 'section_179', 'bonus_100'];
const VALID_DEPRECIATION_CONVENTIONS = ['half_year', 'mid_quarter'];
// MACRS recovery classes the P&L can compute a schedule for. The equipment
// form collects usefulLifeYears, so derive the IRS class from it when the
// caller didn't send one — otherwise a UI-created MACRS asset lands with a
// null class and silently depreciates at $0 (the exact bug this lane fixes).
const SUPPORTED_MACRS_CLASSES = { 3: '3-year', 5: '5-year', 7: '7-year' };
function irsClassFromLife(irsClass, usefulLifeYears) {
  if (irsClass) return irsClass;
  const n = parseInt(usefulLifeYears, 10);
  return SUPPORTED_MACRS_CLASSES[n] || null;
}
// IRS Section 179 annual election limits. Update each tax year.
const SECTION_179_LIMITS = { 2024: 1160000, 2025: 1220000, 2026: 1250000 };

router.post('/equipment', async (req, res, next) => {
  try {
    const { name, description, assetCategory, irsClass, purchaseDate, purchaseCost,
      salvageValue, depreciationMethod, usefulLifeYears, section179Elected,
      businessUsePct, luxuryAutoExempt, serialNumber, makeModel, location, notes } = req.body;

    if (depreciationMethod && !VALID_DEPRECIATION_METHODS.includes(depreciationMethod)) {
      return res.status(400).json({ error: `Invalid depreciation method. Must be one of: ${VALID_DEPRECIATION_METHODS.join(', ')}` });
    }
    // business_use_pct 0–100 (strict). Providing it for a vehicle CONFIRMS the
    // business use; a vehicle created without it stays unconfirmed and its
    // depreciation is flagged incomplete rather than deducting the 100% default.
    let bizUsePct;
    if (businessUsePct !== undefined) {
      bizUsePct = Number(businessUsePct);
      if (!Number.isFinite(bizUsePct) || bizUsePct < 0 || bizUsePct > 100) {
        return res.status(400).json({ error: 'businessUsePct must be a number between 0 and 100' });
      }
    }
    // §280F exemption is tax-sensitive — require a real boolean (a JSON string
    // "false" must NOT enable exemption via truthiness).
    if (luxuryAutoExempt !== undefined && typeof luxuryAutoExempt !== 'boolean') {
      return res.status(400).json({ error: 'luxuryAutoExempt must be a boolean' });
    }
    const isVehicle = assetCategory === 'vehicle';
    const businessUseConfirmed = isVehicle ? businessUsePct !== undefined : true;
    if (!name || !purchaseDate || purchaseCost == null) {
      return res.status(400).json({ error: 'name, purchaseDate, and purchaseCost are required' });
    }

    const s179 = section179Elected && depreciationMethod === 'section_179';
    if (s179) {
      const purchaseYear = new Date(purchaseDate).getFullYear();
      const limit = SECTION_179_LIMITS[purchaseYear];
      if (limit) {
        const existing = await db('equipment_register')
          .where('section_179_elected', true)
          .whereRaw("EXTRACT(YEAR FROM purchase_date) = ?", [purchaseYear])
          .sum('section_179_amount as total').first();
        const existingTotal = parseFloat(existing?.total || 0);
        if (existingTotal + parseFloat(purchaseCost) > limit) {
          return res.status(400).json({
            error: `Section 179 election would exceed ${purchaseYear} IRS limit ($${limit.toLocaleString()}). Already elected: $${existingTotal.toLocaleString()}. Consider MACRS or bonus depreciation for the excess.`,
          });
        }
      }
    }

    await db('equipment_register').insert({
      name, description, asset_category: assetCategory,
      // Derive the MACRS class from the recovery life when not supplied, so a
      // MACRS asset gets a computable schedule instead of $0.
      irs_class: irsClassFromLife(irsClass, usefulLifeYears),
      purchase_date: purchaseDate, placed_in_service_date: purchaseDate,
      purchase_cost: purchaseCost, salvage_value: salvageValue || 0,
      depreciation_method: depreciationMethod || 'MACRS',
      useful_life_years: usefulLifeYears,
      section_179_elected: s179, section_179_amount: s179 ? purchaseCost : null,
      business_use_pct: bizUsePct !== undefined ? bizUsePct : 100,
      business_use_confirmed: businessUseConfirmed,
      luxury_auto_exempt: isVehicle && luxuryAutoExempt === true,
      current_book_value: s179 ? 0 : purchaseCost,
      accumulated_depreciation: s179 ? purchaseCost : 0,
      serial_number: serialNumber, make_model: makeModel, location, notes,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.put('/equipment/:id', async (req, res, next) => {
  try {
    const fields = req.body;
    if (fields.depreciationMethod && !VALID_DEPRECIATION_METHODS.includes(fields.depreciationMethod)) {
      return res.status(400).json({ error: `Invalid depreciation method. Must be one of: ${VALID_DEPRECIATION_METHODS.join(', ')}` });
    }
    // business_use_pct must be 0–100; convention must be an allow-listed value.
    // STRICT coercion (Number, not parseFloat) so "50junk" is rejected rather
    // than validated-then-persisted as a string that Postgres 500s on.
    let businessUsePctNormalized;
    if (fields.businessUsePct !== undefined) {
      const p = Number(fields.businessUsePct);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'businessUsePct must be a number between 0 and 100' });
      }
      businessUsePctNormalized = p;
    }
    if (fields.depreciationConvention !== undefined && !VALID_DEPRECIATION_CONVENTIONS.includes(fields.depreciationConvention)) {
      return res.status(400).json({ error: `Invalid depreciation convention. Must be one of: ${VALID_DEPRECIATION_CONVENTIONS.join(', ')}` });
    }
    // Tax-sensitive booleans must be REAL booleans — a JSON string "false" must
    // not enable exemption/confirmation via truthiness.
    for (const b of ['luxuryAutoExempt', 'businessUseConfirmed']) {
      if (fields[b] !== undefined && typeof fields[b] !== 'boolean') {
        return res.status(400).json({ error: `${b} must be a boolean` });
      }
    }
    const update = { updated_at: new Date() };
    const map = {
      name: 'name', description: 'description', assetCategory: 'asset_category',
      irsClass: 'irs_class', purchaseCost: 'purchase_cost', salvageValue: 'salvage_value',
      depreciationMethod: 'depreciation_method', usefulLifeYears: 'useful_life_years',
      serialNumber: 'serial_number', makeModel: 'make_model', location: 'location',
      notes: 'notes', active: 'active', disposed: 'disposed', disposalDate: 'disposal_date',
      disposalProceeds: 'disposal_proceeds',
      businessUsePct: 'business_use_pct', depreciationConvention: 'depreciation_convention',
    };
    for (const [k, col] of Object.entries(map)) { if (fields[k] !== undefined) update[col] = fields[k]; }
    if (fields.luxuryAutoExempt !== undefined) update.luxury_auto_exempt = fields.luxuryAutoExempt === true;
    // Persist the NORMALIZED number, not the raw string. Explicitly setting a
    // vehicle's business use CONFIRMS it unless the caller says otherwise.
    if (businessUsePctNormalized !== undefined) {
      update.business_use_pct = businessUsePctNormalized;
      if (fields.businessUseConfirmed === undefined) update.business_use_confirmed = true;
    }
    if (fields.businessUseConfirmed !== undefined) update.business_use_confirmed = fields.businessUseConfirmed === true;
    // Converting an asset TO a vehicle must not inherit a non-vehicle's
    // confirmed=true — reset to unconfirmed unless this same update supplies a
    // business-use % (or an explicit confirmed flag), so its depreciation fails
    // closed until the vehicle's business use is stated.
    if (fields.assetCategory === 'vehicle'
        && businessUsePctNormalized === undefined
        && fields.businessUseConfirmed === undefined) {
      update.business_use_confirmed = false;
      if (fields.luxuryAutoExempt === undefined) update.luxury_auto_exempt = false;
    }
    // Keep the MACRS class in sync with the recovery life: when the life
    // changes without an explicit class, re-derive it — and CLEAR it (null)
    // when the new life is unsupported, so MACRS fails closed rather than
    // computing with the previous class's stale schedule.
    if (fields.usefulLifeYears !== undefined && fields.irsClass === undefined) {
      update.irs_class = irsClassFromLife(null, fields.usefulLifeYears);
    }
    await db('equipment_register').where({ id: req.params.id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════════════════════════════

router.get('/expense-categories', async (req, res, next) => {
  try {
    const cats = await db('expense_categories').orderBy('sort_order');
    res.json({ categories: cats.map(c => ({ id: c.id, name: c.name, irsLine: c.irs_line, irsDescription: c.irs_description, isDeductible: c.is_deductible, notes: c.notes })) });
  } catch (err) { next(err); }
});

router.get('/expenses', async (req, res, next) => {
  try {
    const { quarter, categoryId, page = 1, limit = 50 } = req.query;
    const year = req.query.year || String(new Date().getFullYear());
    let query = db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .select('expenses.*', 'expense_categories.name as category_name', 'expense_categories.irs_line')
      .orderBy('expenses.expense_date', 'desc');
    if (year) query = query.where('expenses.tax_year', year);
    if (quarter) query = query.where('expenses.quarter', quarter);
    if (categoryId) query = query.where('expenses.category_id', categoryId);
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const expenses = await query.limit(parseInt(limit)).offset(offset);

    // Summary
    const summary = await db('expenses')
      .where('expenses.tax_year', year)
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .select('expense_categories.name as category')
      .sum('expenses.amount as total')
      .sum('expenses.tax_deductible_amount as deductible')
      .count('* as count')
      .groupBy('expense_categories.name')
      .orderBy('total', 'desc');

    res.json({
      expenses: expenses.map(e => ({
        id: e.id, categoryId: e.category_id, categoryName: e.category_name,
        irsLine: e.irs_line, description: e.description,
        amount: parseFloat(e.amount), deductibleAmount: e.tax_deductible_amount ? parseFloat(e.tax_deductible_amount) : null,
        expenseDate: e.expense_date, vendorName: e.vendor_name,
        paymentMethod: e.payment_method, isRecurring: e.is_recurring,
        taxYear: e.tax_year, quarter: e.quarter, notes: e.notes,
      })),
      summary: summary.map(s => ({
        category: s.category, total: parseFloat(s.total || 0),
        deductible: parseFloat(s.deductible || 0), count: parseInt(s.count),
      })),
    });
  } catch (err) { next(err); }
});

router.post('/expenses', async (req, res, next) => {
  try {
    let { categoryId, description, amount, deductibleAmount, expenseDate, vendorName,
      paymentMethod, isRecurring, recurrencePeriod, notes } = req.body;
    const date = new Date(expenseDate);
    const taxYear = String(date.getFullYear());
    const quarter = `Q${Math.ceil((date.getMonth() + 1) / 3)}`;

    // Auto-categorize with Claude if no category provided
    let aiCategory = null;
    let aiCategorizeError = null;
    if (!categoryId && (vendorName || description)) {
      try {
        aiCategory = await autoCategorizeExpense(vendorName, description, amount);
        if (aiCategory?.categoryId) categoryId = aiCategory.categoryId;
      } catch (err) {
        aiCategorizeError = err.message;
        logger.warn(`[tax] AI expense categorization failed: ${err.message}`);
        // Continue without categorization — don't block the insert
      }
    }

    // tax_deductible_amount MUST be within [0, amount] — a value above the
    // expense or below zero corrupts the book-to-tax bridge (a negative
    // non-deductible add-back would understate taxable income).
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res.status(400).json({ error: 'amount must be a number ≥ 0' });
    }
    // Server-owned partial-deduction policy applied to the FINAL category —
    // whether the operator picked it or AI did — so an explicitly-selected
    // "Meals & Entertainment" still lands at 50%. An explicit client-supplied
    // deductibleAmount always wins.
    if (deductibleAmount == null && categoryId) {
      const cat = await db('expense_categories').where({ id: categoryId }).first('name');
      const partial = categoryDeductibleAmount(cat?.name, amt);
      if (partial !== null) deductibleAmount = partial;
    }
    const deductible = deductibleAmount == null ? amt : parseFloat(deductibleAmount);
    if (!Number.isFinite(deductible) || deductible < 0 || deductible > amt) {
      return res.status(400).json({ error: 'deductibleAmount must be between 0 and the expense amount' });
    }

    const [inserted] = await db('expenses').insert({
      category_id: categoryId, description, amount,
      tax_deductible_amount: deductible,
      expense_date: expenseDate, vendor_name: vendorName,
      payment_method: paymentMethod, is_recurring: isRecurring || false,
      recurrence_period: recurrencePeriod, tax_year: taxYear, quarter, notes,
    }).returning('*');

    res.json({
      success: true,
      expense: inserted,
      aiCategorized: !!(aiCategory?.categoryId),
      aiCategory: aiCategory || null,
      aiCategorizeError,
    });
  } catch (err) { next(err); }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    await db('expenses').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// FILING CALENDAR
// ═══════════════════════════════════════════════════════════════

router.get('/filings', async (req, res, next) => {
  try {
    const { year, status } = req.query;
    let query = db('tax_filing_calendar').orderBy('due_date');
    if (year) query = query.whereRaw("period_label LIKE ?", [`%${year}%`]);
    if (status) query = query.where('status', status);
    const filings = await query;
    res.json({
      filings: filings.map(f => ({
        id: f.id, filingType: f.filing_type, title: f.title,
        periodLabel: f.period_label, dueDate: f.due_date,
        extendedDueDate: f.extended_due_date, status: f.status,
        amountDue: f.amount_due ? parseFloat(f.amount_due) : null,
        amountPaid: f.amount_paid ? parseFloat(f.amount_paid) : null,
        filedDate: f.filed_date, paidDate: f.paid_date,
        confirmationNumber: f.confirmation_number, notes: f.notes,
      })),
    });
  } catch (err) { next(err); }
});

router.put('/filings/:id', async (req, res, next) => {
  try {
    const fields = req.body;
    const update = { updated_at: new Date() };
    const map = {
      status: 'status', amountDue: 'amount_due', amountPaid: 'amount_paid',
      filedDate: 'filed_date', paidDate: 'paid_date',
      confirmationNumber: 'confirmation_number', notes: 'notes',
    };
    for (const [k, col] of Object.entries(map)) { if (fields[k] !== undefined) update[col] = fields[k]; }
    await db('tax_filing_calendar').where({ id: req.params.id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// AI TAX ADVISOR
// ═══════════════════════════════════════════════════════════════

router.get('/advisor/reports', async (req, res, next) => {
  try {
    const reports = await db('tax_advisor_reports').orderBy('report_date', 'desc').limit(12);
    res.json({
      reports: reports.map(r => ({
        id: r.id, date: r.report_date, period: r.period, grade: r.grade,
        summary: r.executive_summary,
        financialSnapshot: r.financial_snapshot ? JSON.parse(r.financial_snapshot) : {},
        regulationChanges: r.regulation_changes ? JSON.parse(r.regulation_changes) : [],
        savingsOpportunities: r.savings_opportunities ? JSON.parse(r.savings_opportunities) : [],
        deductionGaps: r.deduction_gaps ? JSON.parse(r.deduction_gaps) : [],
        complianceAlerts: r.compliance_alerts ? JSON.parse(r.compliance_alerts) : [],
        actionItems: r.action_items ? JSON.parse(r.action_items) : [],
        smsSent: r.sms_sent,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/advisor/alerts', async (req, res, next) => {
  try {
    const { status = 'new' } = req.query;
    const alerts = await db('tax_advisor_alerts')
      .where('status', status)
      .orderBy([{ column: 'priority', order: 'asc' }, { column: 'created_at', order: 'desc' }]);
    const counts = await db('tax_advisor_alerts').select('status').count('* as count').groupBy('status');
    res.json({
      alerts: alerts.map(a => ({
        id: a.id, type: a.alert_type, priority: a.priority,
        title: a.title, description: a.description,
        estimatedSavings: a.estimated_savings ? parseFloat(a.estimated_savings) : null,
        status: a.status, actionByDate: a.action_by_date,
        actionTaken: a.action_taken, createdAt: a.created_at,
      })),
      counts: counts.reduce((acc, c) => { acc[c.status] = parseInt(c.count); return acc; }, {}),
    });
  } catch (err) { next(err); }
});

router.put('/advisor/alerts/:id', async (req, res, next) => {
  try {
    const { status, actionTaken } = req.body;
    const update = { updated_at: new Date() };
    if (status) update.status = status;
    if (actionTaken) update.action_taken = actionTaken;
    await db('tax_advisor_alerts').where({ id: req.params.id }).update(update);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/tax/advisor/run — manually trigger the advisor
router.post('/advisor/run', async (req, res, next) => {
  try {
    const TaxAdvisor = require('../services/tax-advisor');
    const report = await TaxAdvisor.generateWeeklyReport();
    res.json({ success: true, grade: report.grade, summary: report.executive_summary });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// AI EXPENSE AUTO-CATEGORIZATION
// ═══════════════════════════════════════════════════════════════
// Shared with the email invoice-processor — see
// server/services/expense-categorizer.js (extracted 2026-07-21 so emailed
// vendor invoices stop landing uncategorized).
const { autoCategorizeExpense, categoryDeductibleAmount } = require('../services/expense-categorizer');

// Partial-deduction policy is SERVER-owned and derived from the MATCHED
// category — never from the model's deductiblePercent. Keying off the model
// meant a meal the AI correctly filed under "Meals & Entertainment" was
// deducted at 100% whenever the model omitted the field or answered 100.
// The policy is derived from the MATCHED category name and lives in the
// shared expense-categorizer service (categoryDeductibleAmount) so the three
// call sites — this route's POST /expenses and /expenses/auto-categorize, and
// the email invoice-processor — share one source of truth.

// ═══════════════════════════════════════════════════════════════
// MILEAGE LOG (Bouncie GPS Integration)
// ═══════════════════════════════════════════════════════════════

// GET /mileage — list mileage entries with date range filter
router.get('/mileage', async (req, res, next) => {
  try {
    const { startDate, endDate, purpose, page = 1, limit = 50 } = req.query;
    let query = db('mileage_log').orderBy('trip_date', 'desc');

    if (startDate) query = query.where('trip_date', '>=', startDate);
    if (endDate) query = query.where('trip_date', '<=', endDate);
    if (purpose) query = query.where('purpose', purpose);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const entries = await query.limit(parseInt(limit)).offset(offset);

    res.json({
      entries: entries.map(e => ({
        id: e.id,
        vehicleId: e.vehicle_id,
        vehicleName: e.vehicle_name,
        tripDate: e.trip_date,
        startAddress: e.start_address,
        endAddress: e.end_address,
        distanceMiles: parseFloat(e.distance_miles),
        durationMinutes: e.duration_minutes,
        purpose: e.purpose,
        irsRate: parseFloat(e.irs_rate),
        deductionAmount: parseFloat(e.deduction_amount),
        source: e.source,
        notes: e.notes,
        createdAt: e.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /mileage — manual mileage entry
router.post('/mileage', async (req, res, next) => {
  try {
    const { vehicleName, tripDate, startAddress, endAddress, distanceMiles,
      durationMinutes, purpose, notes } = req.body;

    if (!tripDate || !distanceMiles) {
      return res.status(400).json({ error: 'tripDate and distanceMiles are required' });
    }

    // A hand-entered trip IS an operator classification — mark it as such so
    // is_business/purpose/method agree (the schema defaults are is_business=
    // true + classification_method='auto', which left manual entries looking
    // auto-classified and mis-attributed). ONLY an explicit business purpose
    // deducts: commuting (home ↔ regular workplace) and personal trips are
    // nondeductible, so anything other than 'business' is $0.
    const resolvedPurpose = purpose || 'business';
    const isBusiness = resolvedPurpose === 'business';
    // Date-effective (the IRS changes the rate mid-year).
    const irsRate = isBusiness ? require('../services/bouncie-mileage').getIrsRate(tripDate) : 0;
    // REFUSE a business trip with no verified rate (a date past the horizon →
    // rate 0), same as classifyTrips: persisting $0 would look reviewed and
    // never self-heal when the rate is added (reports sum persisted values).
    if (isBusiness && !(irsRate > 0)) {
      return res.status(422).json({
        error: 'No verified IRS mileage rate for this trip’s date yet — add the published rate before recording a business trip for it.',
      });
    }
    const deductionAmount = isBusiness ? parseFloat((distanceMiles * irsRate).toFixed(2)) : 0;

    const [inserted] = await db('mileage_log').insert({
      vehicle_name: vehicleName || 'Manual Entry',
      trip_date: tripDate,
      start_address: startAddress || null,
      end_address: endAddress || null,
      distance_miles: distanceMiles,
      duration_minutes: durationMinutes || null,
      purpose: resolvedPurpose,
      is_business: isBusiness,
      classification_method: 'manual',
      irs_rate: irsRate,
      deduction_amount: deductionAmount,
      source: 'manual',
      notes,
    }).returning('*');

    res.json({ success: true, entry: inserted });
  } catch (err) { next(err); }
});

// POST /mileage/sync-bouncie — pull from Bouncie API
router.post('/mileage/sync-bouncie', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const BouncieService = require('../services/bouncie');
    const result = await BouncieService.syncMileage(startDate, endDate);

    res.json({
      success: true,
      tripsImported: result.tripsImported,
      totalMiles: result.totalMiles,
      deductionAmount: result.deductionAmount,
      skipped: result.skipped,
    });
  } catch (err) { next(err); }
});

// GET /mileage/stats — YTD totals
router.get('/mileage/stats', async (req, res, next) => {
  try {
    const year = req.query.year || String(new Date().getFullYear());
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const totals = await db('mileage_log')
      .where('trip_date', '>=', startDate)
      .where('trip_date', '<=', endDate)
      .select(
        db.raw('COALESCE(SUM(distance_miles), 0) as total_miles'),
        db.raw('COALESCE(SUM(deduction_amount), 0) as total_deduction'),
        db.raw('COUNT(*) as trip_count'),
      ).first();

    const byPurpose = await db('mileage_log')
      .where('trip_date', '>=', startDate)
      .where('trip_date', '<=', endDate)
      .whereNotNull('purpose')
      .select('purpose')
      .sum('distance_miles as miles')
      .sum('deduction_amount as deduction')
      .count('* as count')
      .groupBy('purpose');

    const byMonth = await db('mileage_log')
      .where('trip_date', '>=', startDate)
      .where('trip_date', '<=', endDate)
      .select(db.raw("TO_CHAR(trip_date, 'YYYY-MM') as month"))
      .sum('distance_miles as miles')
      .sum('deduction_amount as deduction')
      .count('* as count')
      .groupBy(db.raw("TO_CHAR(trip_date, 'YYYY-MM')"))
      .orderBy('month');

    const tripCount = parseInt(totals.trip_count);
    const totalMiles = parseFloat(totals.total_miles);
    // Display-only "current rate" — per-trip deductions are computed at each
    // trip's date-effective rate and summed from deduction_amount above.
    const irsRate = mileageService.getIrsRate(etDateString());
    res.json({
      year,
      totalMiles,
      totalDeduction: parseFloat(totals.total_deduction),
      tripCount,
      totalTrips: tripCount,
      avgDistance: tripCount > 0 ? totalMiles / tripCount : 0,
      irsRate,
      byPurpose: byPurpose.map(p => ({
        purpose: p.purpose,
        miles: parseFloat(p.miles),
        deduction: parseFloat(p.deduction),
        count: parseInt(p.count),
      })),
      byMonth: byMonth.map(m => ({
        month: m.month,
        miles: parseFloat(m.miles),
        deduction: parseFloat(m.deduction),
        count: parseInt(m.count),
      })),
    });
  } catch (err) { next(err); }
});

// Date-effective IRS rate + canonical summary recompute live in the shared
// mileage service (the IRS changes the rate MID-YEAR — a year-keyed rate
// wrote wrong deductions for H2 trips).
const mileageService = require('../services/bouncie-mileage');
const MILEAGE_PURPOSES = ['business', 'personal', 'unclassified'];

// Classify trips (single or bulk) — the geofence classifier is RETIRED, so
// every Bouncie trip lands 'unclassified' at $0 deduction and this is the
// ONLY way to claim the miles. business → deduction at the TRIP-DATE IRS
// rate; personal/unclassified → $0. Substantiation (which trips are
// business) is the operator's call — nothing here auto-classifies.
async function classifyTrips(ids, purpose) {
  let updated = 0;
  let deductionTotal = 0;
  let skippedNoRate = 0;
  const summaryKeys = new Set();
  // ALL the row updates commit together or not at all — up to 500 rows updated
  // one at a time would otherwise leave deductions half-applied (and summaries
  // never recomputed) if one update failed midway.
  await db.transaction(async (trx) => {
    const rows = await trx('mileage_log')
      .whereIn('id', ids)
      .select('id', 'trip_date', 'distance_miles', 'equipment_id');
    for (const row of rows) {
      const tripDay = dateCellStr(row.trip_date);
      const rate = mileageService.getIrsRate(tripDay);
      // REFUSE to book a business trip with no verified IRS rate (a date past
      // the rate horizon → rate 0). Persisting $0 would look "reviewed" and
      // never self-heal when the rate is added (reports sum persisted values),
      // so leave it UNCLASSIFIED for re-review once the table is extended.
      if (purpose === 'business' && !(rate > 0)) {
        skippedNoRate++;
        continue;
      }
      const miles = parseFloat(row.distance_miles) || 0;
      const deduction = purpose === 'business' ? parseFloat((miles * rate).toFixed(2)) : 0;
      await trx('mileage_log').where({ id: row.id }).update({
        purpose,
        // Keep the canonical classification fields other surfaces read
        // (admin-mileage filters on is_business) in lockstep with purpose.
        is_business: purpose === 'business',
        classification_method: 'manual_review',
        classification_notes: 'Classified via Tax Center mileage review',
        irs_rate: purpose === 'business' ? rate : 0,
        deduction_amount: deduction,
        updated_at: new Date(),
      });
      if (row.equipment_id && tripDay) summaryKeys.add(`${row.equipment_id}|${tripDay}`);
      updated++;
      deductionTotal += deduction;
    }
  });
  // Recompute the affected daily AND monthly summaries AFTER the classification
  // commits — derived state, best-effort, and a recompute failure must not roll
  // back the now-durable classification. (The monthly cron only regenerates the
  // PREVIOUS month, so an older trip's month would otherwise stay stale.)
  let summaryRecomputeFailures = 0;
  const monthKeys = new Set();
  for (const key of summaryKeys) {
    const [equipmentId, day] = key.split('|');
    try {
      await mileageService.computeDailySummary(equipmentId, day);
    } catch (err) {
      summaryRecomputeFailures++;
      logger.warn(`[tax] mileage daily summary recompute failed for ${equipmentId} ${day}: ${err.message}`);
    }
    monthKeys.add(`${equipmentId}|${day.slice(0, 7)}`);
  }
  for (const key of monthKeys) {
    const [equipmentId, month] = key.split('|');
    try {
      await mileageService.computeMonthlySummary(equipmentId, `${month}-01`);
    } catch (err) {
      summaryRecomputeFailures++;
      logger.warn(`[tax] mileage monthly summary recompute failed for ${equipmentId} ${month}: ${err.message}`);
    }
  }
  return {
    updated,
    deductionTotal: Math.round(deductionTotal * 100) / 100,
    skippedNoRate,
    // Surfaced so the caller/UI knows dashboards may be briefly stale — the
    // classification itself is durable; only the derived summaries lagged.
    summaryRecomputeFailures,
  };
}

// PUT /mileage/:id — reclassify one trip
router.put('/mileage/:id', async (req, res, next) => {
  try {
    const { purpose } = req.body || {};
    if (!MILEAGE_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `purpose must be one of: ${MILEAGE_PURPOSES.join(', ')}` });
    }
    const result = await classifyTrips([req.params.id], purpose);
    // A business trip past the IRS-rate horizon is refused, not "not found".
    if (!result.updated && result.skippedNoRate) {
      return res.status(422).json({
        error: 'No verified IRS mileage rate for this trip’s date yet — left unclassified. Add the published rate, then reclassify.',
        ...result,
      });
    }
    if (!result.updated) return res.status(404).json({ error: 'Trip not found' });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /mileage/bulk-classify — { ids: [...], purpose }
router.post('/mileage/bulk-classify', async (req, res, next) => {
  try {
    const { ids, purpose } = req.body || {};
    if (!MILEAGE_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `purpose must be one of: ${MILEAGE_PURPOSES.join(', ')}` });
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
      return res.status(400).json({ error: 'ids must be a non-empty array (max 500)' });
    }
    const result = await classifyTrips(ids, purpose);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /expenses/auto-categorize — AI-categorize a batch of uncategorized
// expenses (oldest first). Operator-triggered from the Expenses tab; results
// come back per-expense so the picks are reviewable. Failures on one expense
// never abort the batch.
// { limit?, year?, ids? } — the scope must match what the operator can SEE.
// The tab counts its button from the rows it loaded for the selected tax
// year, so a global oldest-first sweep mutated expenses off-screen and could
// leave the visible backlog unchanged after a "successful" run.
router.post('/expenses/auto-categorize', async (req, res, next) => {
  try {
    const rawLimit = parseInt(req.body?.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
    // ids = the exact visible backlog (bounded like bulk-classify); year =
    // the tab's filter. Neither supplied keeps the old whole-table behavior
    // for callers with no view to agree with (scripts, IB tools).
    const { ids, year } = req.body || {};
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 500)) {
      return res.status(400).json({ error: 'ids must be a non-empty array (max 500)' });
    }
    if (year !== undefined && !/^\d{4}$/.test(String(year))) {
      return res.status(400).json({ error: 'year must be a 4-digit year' });
    }
    // ONE builder feeds both the batch selection and the `remaining` count —
    // a differently-scoped count is exactly what let the tab report a
    // backlog the run never touched.
    const scoped = () => {
      let q = db('expenses').whereNull('category_id');
      if (ids !== undefined) q = q.whereIn('id', ids);
      if (year !== undefined) q = q.where('tax_year', String(year));
      return q;
    };
    const uncategorized = await scoped()
      .orderBy('expense_date', 'asc')
      .limit(limit)
      .select('id', 'vendor_name', 'description', 'amount');
    // Canonical category names for the server-owned partial-deduction
    // policy — resolved from the row the AI matched, never from its echoed
    // categoryName string.
    const categoryNames = new Map(
      (await db('expense_categories').select('id', 'name')).map(c => [String(c.id), c.name]),
    );
    const results = [];
    for (const exp of uncategorized) {
      try {
        const ai = await autoCategorizeExpense(exp.vendor_name, exp.description, exp.amount);
        if (ai?.categoryId) {
          const update = {
            category_id: ai.categoryId,
            updated_at: new Date(),
            // The description can include text imported from untrusted invoice
            // emails (prompt-injectable). Categories are allow-listed and the
            // deductible % is server-owned, so the blast radius is a possibly-
            // wrong-but-valid category — FLAG the row so the operator verifies
            // the AI pick rather than trusting it silently. This route is
            // operator-triggered and returns per-row results for that review.
            notes: db.raw("COALESCE(notes,'') || ' [AI-categorized — verify]'"),
          };
          // Partial deduction follows the MATCHED CATEGORY, not the model's
          // deductiblePercent — a 50%-limited meal must land at 50% even
          // when the model omits the field or claims 100.
          const partial = categoryDeductibleAmount(categoryNames.get(String(ai.categoryId)), exp.amount);
          if (partial !== null) {
            update.tax_deductible_amount = partial;
          }
          // Re-assert still-uncategorized: the model calls run serially, so an
          // operator could categorize this row mid-batch — a bare id UPDATE
          // would clobber that manual choice with a stale AI pick. A zero-row
          // update means someone got there first; skip it.
          const changed = await db('expenses')
            .where({ id: exp.id })
            .whereNull('category_id')
            .update(update);
          if (!changed) {
            results.push({ id: exp.id, description: exp.description, applied: false, error: 'already categorized' });
            continue;
          }
          results.push({ id: exp.id, description: exp.description, category: ai.categoryName, reasoning: ai.reasoning, applied: true });
        } else {
          results.push({ id: exp.id, description: exp.description, applied: false, error: 'no matching category' });
        }
      } catch (err) {
        results.push({ id: exp.id, description: exp.description, applied: false, error: err.message });
      }
    }
    const remaining = await scoped().count('* as n').first();
    res.json({
      success: true,
      processed: results.length,
      applied: results.filter(r => r.applied).length,
      remaining: parseInt(remaining?.n || 0, 10),
      results,
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// REVENUE RECONCILIATION
// ═══════════════════════════════════════════════════════════════

// GET /revenue/reconcile?month=2026-04 — Stripe/native tax reconciliation
router.get('/revenue/reconcile', async (req, res, next) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month parameter required in YYYY-MM format' });
    }
    const [yr, mo] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    // Day 0 of the next month, built in UTC so the server's local zone can
    // never shift the month boundary.
    const endDate = new Date(Date.UTC(yr, mo, 0)).toISOString().split('T')[0];

    // Real collected revenue for the month — same refund-netted cash basis
    // as the P&L (paidRevenueForWindow), so the two surfaces can't disagree.
    // The old read targeted a revenue_daily table that never existed, so
    // this card showed $0/$0 every month. Errors propagate (except a
    // missing table in dev) — a DB failure must be a 500, not a $0 report.
    const totalRevenue = await paidRevenueForWindow(db, startDate, endDate);

    // Sales tax collected/owed are NOT computable from portal data: nothing
    // records tax_collected, and a liability figure requires the taxability
    // determination per service + exemptions — an owner/CPA decision, not a
    // flat rate. The old response fabricated taxOwed = 7% × ALL revenue.
    // null = "not recorded"; the client renders "—" and skips the
    // over/under-collected verdict rather than asserting one from fiction.
    res.json({
      month,
      startDate,
      endDate,
      totalRevenue,
      taxCollected: null,
      taxOwed: null,
      difference: null,
      note: 'Sales tax collection is not recorded in the portal, so collected/owed cannot be reconciled here. Revenue is the month\'s paid payments. Confirm taxability and any liability with your CPA.',
    });
  } catch (err) { next(err); }
});

// GET /revenue/quarterly-estimate?quarter=Q2 — estimated quarterly payment
router.get('/revenue/quarterly-estimate', async (req, res, next) => {
  try {
    const { quarter } = req.query;
    if (!quarter || !/^Q[1-4]$/.test(quarter)) {
      return res.status(400).json({ error: 'quarter parameter required (Q1, Q2, Q3, or Q4)' });
    }
    const now = new Date();
    // Optional ?year= pins the estimate to the SELECTED period's year (the
    // Revenue tab derives quarter+year from its month picker); default stays
    // the ET year so the quarter doesn't roll over late on Dec 31 ET.
    const year = /^\d{4}$/.test(String(req.query.year || ''))
      ? parseInt(req.query.year, 10)
      : etParts(now).year;
    const qNum = parseInt(quarter.replace('Q', ''));
    const startMonth = (qNum - 1) * 3;
    const pad2 = (n) => String(n).padStart(2, '0');
    const startDate = `${year}-${pad2(startMonth + 1)}-01`;
    // Day 0 of the month after the quarter's last = last day of quarter.
    const qEnd = new Date(Date.UTC(year, startMonth + 3, 0, 12, 0, 0));
    const qEndP = etParts(qEnd);
    const endDate = `${qEndP.year}-${pad2(qEndP.month)}-${pad2(qEndP.day)}`;
    const ytdStart = `${year}-01-01`;

    const revenue = await db('payments').where('status', 'paid').whereBetween('payment_date', [ytdStart, endDate]).sum('amount as total').first().catch(() => ({ total: 0 }));
    const expenses = await db('expenses').where('tax_year', String(year)).whereBetween('expense_date', [ytdStart, endDate]).sum('amount as total').first().catch(() => ({ total: 0 }));

    const ytdRevenue = parseFloat(revenue?.total || 0);
    const ytdExpenses = parseFloat(expenses?.total || 0);
    const estimatedNetIncome = Math.max(0, ytdRevenue - ytdExpenses);

    const seBase = estimatedNetIncome * 0.9235;
    const seTax = seBase * 0.153;
    const incomeTaxBase = Math.max(0, estimatedNetIncome - (seTax * 0.5));
    const incomeTax = incomeTaxBase * 0.22;
    const annualLiability = seTax + incomeTax;
    const quarterlyPayment = annualLiability / 4;

    // Quarterly due dates (1040-ES)
    const dueDates = { Q1: `${year}-04-15`, Q2: `${year}-06-15`, Q3: `${year}-09-15`, Q4: `${year + 1}-01-15` };

    res.json({
      quarter, startDate, endDate,
      ytdRevenue, ytdExpenses, estimatedNetIncome,
      seTax, incomeTax, quarterlyPayment,
      dueDate: dueDates[quarter],
      note: 'Estimates assume 22% federal bracket. SE tax is 15.3% on 92.35% of net earnings; 50% of SE tax is deducted before income tax. Consult CPA for precise figures.',
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// P&L REPORTING
// ═══════════════════════════════════════════════════════════════

router.get('/pnl', async (req, res, next) => {
  try {
    const { period = 'mtd', start_date, end_date } = req.query;
    // Shared with /export/pnl and the tax package — one window resolver, one
    // report builder, so the page and every export show the same numbers.
    const range = getPeriodRange(period, { start_date, end_date });
    if (!range) {
      return res.status(400).json({ error: 'start_date and end_date required for custom period' });
    }
    const { startDate, endDate } = range;

    const report = await buildPnlReport(db, startDate, endDate);
    res.json({ period, startDate, endDate, ...report });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// ACCOUNTS RECEIVABLE
// ═══════════════════════════════════════════════════════════════

router.get('/accounts-receivable', async (req, res, next) => {
  try {
    let invoices = [];
    try {
      invoices = await db('invoices')
        .leftJoin('customers', 'invoices.customer_id', 'customers.id')
        // 'viewed' is what 'sent' becomes the moment the customer opens the
        // invoice — omitting it made receivables VANISH from A/R on view
        // ($1,374 across 5 invoices invisible at audit time). Deliberately
        // excluded: draft/scheduled/sending (not yet receivable) and
        // processing (ACH in flight settles on its own).
        .whereIn('invoices.status', ['sent', 'viewed', 'overdue', 'unpaid', 'pending'])
        // Third-party payer invoices are owed by the PAYER's AP inbox — this
        // surface joins the service recipient's contact info and its Send
        // Reminder button texts them, so a payer-billed invoice here would
        // chase the homeowner for someone else's bill (mirrors the
        // payments-reconcile payer guard).
        .whereNull('invoices.payer_id')
        .select(
          'invoices.*',
          'customers.first_name', 'customers.last_name',
          'customers.email', 'customers.phone'
        )
        .orderBy('invoices.due_date', 'asc');
    } catch {
      // invoices table may not exist — try payments with unpaid status
      try {
        invoices = await db('payments')
          .leftJoin('customers', 'payments.customer_id', 'customers.id')
          .whereIn('payments.status', ['pending', 'unpaid', 'overdue', 'sent'])
          .select(
            'payments.*',
            'customers.first_name', 'customers.last_name',
            'customers.email', 'customers.phone'
          )
          .orderBy('payments.created_at', 'asc');
      } catch { /* */ }
    }

    const now = new Date();
    let totalOutstanding = 0, current = 0, over30 = 0, over60 = 0, over90 = 0;
    const items = invoices.map(inv => {
      // Invoice rows carry `total`: net applied account/deposit credit so
      // A/R totals (and the SMS reminder) ask for the COLLECTIBLE amount,
      // matching every other receivable query. The payments-table fallback
      // rows keep the raw-amount path.
      const amount = inv.total != null
        ? invoiceAmountDue(inv)
        : parseFloat(inv.amount || inv.amount_due || 0);
      const dueDate = inv.due_date || inv.created_at;
      const daysOverdue = dueDate ? Math.max(0, Math.floor((now - new Date(dueDate)) / 86400000)) : 0;
      let bucket = 'current';
      if (daysOverdue >= 90) { bucket = '90+'; over90 += amount; }
      else if (daysOverdue >= 60) { bucket = '60'; over60 += amount; }
      else if (daysOverdue >= 30) { bucket = '30'; over30 += amount; }
      else { current += amount; }
      totalOutstanding += amount;

      return {
        id: inv.id,
        customerId: inv.customer_id,
        customerName: inv.customer_name || (inv.first_name ? `${inv.first_name} ${inv.last_name}` : 'Unknown'),
        email: inv.email,
        phone: inv.phone,
        invoiceNumber: inv.invoice_number || inv.id,
        amount,
        dueDate,
        daysOverdue,
        bucket,
        status: inv.status,
        description: inv.description || inv.memo || '',
      };
    });

    res.json({
      summary: { total: totalOutstanding, current, over30, over60, over90, count: items.length },
      invoices: items.sort((a, b) => b.daysOverdue - a.daysOverdue),
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// CSV EXPORT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

const csv = require('../services/csv-generators');

router.get('/export/transactions', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const year = new Date().getFullYear();
    const sd = start_date || `${year}-01-01`;
    const ed = end_date || `${year}-12-31`;

    let payments = [];
    try {
      payments = await db('payments')
        .where('created_at', '>=', sd)
        .where('created_at', '<', db.raw("?::date + interval '1 day'", [ed]))
        .leftJoin('customers', 'payments.customer_id', 'customers.id')
        .select('payments.*', db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, 'Unknown') as customer_name"))
        .orderBy('payments.created_at', 'desc');
    } catch { /* */ }

    const csvStr = csv.transactionsToCSV(payments);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-transactions-${sd}-to-${ed}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/expenses', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const year = new Date().getFullYear();
    const sd = start_date || `${year}-01-01`;
    const ed = end_date || `${year}-12-31`;

    let expenses = [];
    try {
      expenses = await db('expenses')
        .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
        .where('expenses.expense_date', '>=', sd).where('expenses.expense_date', '<=', ed)
        .select('expenses.*', 'expense_categories.name as category_name', 'expense_categories.irs_line')
        .orderBy('expenses.expense_date', 'desc');
    } catch { /* */ }

    const csvStr = csv.expensesToCSV(expenses);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-expenses-${sd}-to-${ed}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/mileage', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const year = new Date().getFullYear();
    const sd = start_date || `${year}-01-01`;
    const ed = end_date || `${year}-12-31`;

    let trips = [];
    try {
      trips = await db('mileage_log')
        .where('trip_date', '>=', sd).where('trip_date', '<=', ed)
        .orderBy('trip_date', 'desc');
    } catch { /* */ }

    const csvStr = csv.mileageToCSV(trips);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-mileage-${sd}-to-${ed}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/depreciation', async (req, res, next) => {
  try {
    // Same shape as the tax-package schedule: the export covers a tax YEAR
    // (?year=, default current ET year) and computes the per-asset
    // 'Depreciation (This Period)' column with the same proration the P&L
    // uses — the generator's header promises that column, so the standalone
    // export must populate it too. Active-or-disposed matches the package.
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : String(etParts(new Date()).year);
    const sd = `${year}-01-01`;
    const ed = `${year}-12-31`;
    let equipment = [];
    try {
      equipment = await db('equipment_register')
        .where(function activeOrDisposed() {
          this.where('active', true).orWhere('disposed', true).orWhereNotNull('disposal_date');
        })
        .orderBy('name');
      // Annotate mid-quarter years across the WHOLE list first, so this export
      // reconciles with pnl.csv (which goes through buildPnlReport → same
      // annotation) instead of reporting half-year where the P&L reports $0.
      equipment = annotateMidQuarter(equipment).map(e => ({
        ...e,
        period_depreciation: prorateAssetDepreciation(e, sd, ed),
      }));
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    const csvStr = csv.depreciationToCSV(equipment);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-depreciation-${year}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/labor', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const year = new Date().getFullYear();
    const sd = start_date || `${year}-01-01`;
    const ed = end_date || `${year}-12-31`;

    let summaries = [];
    try {
      summaries = await db('time_entry_daily_summary')
        .where('date', '>=', sd).where('date', '<=', ed)
        .orderBy('date', 'desc');
    } catch { /* */ }

    const csvStr = csv.laborToCSV(summaries);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-labor-${sd}-to-${ed}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/pnl', async (req, res, next) => {
  try {
    // Same window resolver + report builder as GET /pnl — the exported CSV
    // is byte-for-byte the same numbers the page shows. (The old version
    // HTTP-fetched its own endpoint and fell back to a divergent inline
    // recomputation that ignored the period parameter.)
    // ExportsTab sends bare start_date/end_date with no period — honor the
    // picked range as a custom window instead of silently exporting YTD.
    const period = req.query.period
      || (req.query.start_date && req.query.end_date ? 'custom' : 'ytd');
    const range = getPeriodRange(period, req.query);
    if (!range) {
      return res.status(400).json({ error: 'start_date and end_date required for custom period' });
    }
    const report = await buildPnlReport(db, range.startDate, range.endDate);

    const csvStr = csv.pnlToCSV(report);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-pnl-${period}-${etDateString()}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/tax-package', async (req, res, next) => {
  try {
    const archiver = require('archiver');
    const year = req.query.year || String(new Date().getFullYear());
    const sd = `${year}-01-01`;
    const ed = `${year}-12-31`;

    // Gather all data with fallbacks. Transactions window on payment_date
    // (ET-stamped DATE) so the dump covers the same calendar year as the P&L —
    // a created_at window is UTC and shifts the year boundary by 4–5 ET hours.
    // Full-refund MARKER rows (metadata.source='invoice_refund') are dated
    // the REFUND day — exclude them here and append them re-dated to the
    // invoice's paid period below, matching paidRevenueForWindow.
    let payments = [];
    try {
      payments = await db('payments')
        .whereBetween('payment_date', [sd, ed])
        // Same receipt predicate as the P&L builder: only cash that arrived
        // (paid/refunded/disputed). Upcoming/processing/failed attempts are
        // not receipts and must not appear beside income evidence.
        .whereIn('payments.status', ['paid', 'refunded', 'disputed'])
        .whereRaw("COALESCE(payments.metadata->>'source', '') <> 'invoice_refund'")
        .leftJoin('customers', 'payments.customer_id', 'customers.id')
        .select('payments.*', db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, 'Unknown') as customer_name"))
        .orderBy('payments.payment_date', 'desc');
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    // pnl.csv revenue also counts estimate-deposit cash and paid-Stripe-
    // invoice gap rows (no payments row) — map both into transactions.csv so
    // every receipt the P&L counts has a supporting transaction row.
    try {
      // Normalize DATE cells to YYYY-MM-DD so the combined date sort (and the
      // CSV's date column) is stable across row sources.
      payments = payments.map(p => ({ ...p, payment_date: dateCellStr(p.payment_date) || p.payment_date }));
      const depositRows = await db('estimate_deposits as d')
        .leftJoin('customers as c', 'd.customer_id', 'c.id')
        .whereNotNull('d.received_at')
        .whereRaw(
          "DATE(d.received_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
          [sd, ed],
        )
        .select(
          db.raw("TO_CHAR(d.received_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as payment_date"),
          db.raw("(d.amount + COALESCE(d.card_surcharge, 0)) as amount"),
          'd.status',
          db.raw("COALESCE(c.first_name || ' ' || c.last_name, 'Unknown') as customer_name"),
        );
      payments.push(...depositRows.map(r => ({
        ...r,
        type: 'estimate_deposit',
        description: 'Estimate deposit (deposits ledger — no payments row)',
        processor: 'stripe',
      })));
      const gapRows = await db('invoices as i')
        .leftJoin('customers as c', 'i.customer_id', 'c.id')
        .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
        .whereNotNull('i.stripe_payment_intent_id')
        .whereNotExists(function gapGuard() {
          this.select(db.raw('1'))
            .from('payments as p')
            .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id')
            .whereRaw("COALESCE(p.metadata->>'source', '') <> 'invoice_refund'");
        })
        .whereRaw(
          "DATE(i.paid_at AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
          [sd, ed],
        )
        .select(
          db.raw("TO_CHAR(i.paid_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as payment_date"),
          db.raw('GREATEST(i.total - COALESCE(i.credit_applied, 0), 0) as amount'),
          'i.invoice_number',
          db.raw("COALESCE(c.first_name || ' ' || c.last_name, 'Unknown') as customer_name"),
        );
      payments.push(...gapRows.map(r => ({
        ...r,
        type: 'invoice_paid',
        status: 'paid',
        description: `Invoice ${r.invoice_number} paid via Stripe (no payments-ledger row)`,
        processor: 'stripe',
      })));
      // Fully refunded gap invoices: their receipt is the marker's amount,
      // recognized in the invoice's PAID period (same effective-date rule as
      // paidRevenueForWindow); the refund-day outflow lives in refunds.csv.
      const markerRows = await db('payments as m')
        .whereRaw("m.metadata->>'source' = 'invoice_refund'")
        .leftJoin('invoices as gi', 'gi.stripe_payment_intent_id', 'm.stripe_payment_intent_id')
        .leftJoin('customers as c', 'm.customer_id', 'c.id')
        .whereRaw(
          "DATE(COALESCE(gi.paid_at AT TIME ZONE 'America/New_York', m.payment_date::timestamp)) BETWEEN ?::date AND ?::date",
          [sd, ed],
        )
        .select(
          db.raw("TO_CHAR(DATE(COALESCE(gi.paid_at AT TIME ZONE 'America/New_York', m.payment_date::timestamp)), 'YYYY-MM-DD') as payment_date"),
          'm.amount',
          'gi.invoice_number',
          db.raw("COALESCE(c.first_name || ' ' || c.last_name, 'Unknown') as customer_name"),
        );
      payments.push(...markerRows.map(r => ({
        ...r,
        type: 'invoice_paid',
        status: 'paid (later fully refunded)',
        description: `Invoice ${r.invoice_number || ''} paid via Stripe — later fully refunded (outflow in refunds.csv)`,
        processor: 'stripe',
      })));
      payments.sort((a, b) => String(b.payment_date || '').localeCompare(String(a.payment_date || '')));
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    let expenses = [];
    try { expenses = await db('expenses').leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id').where('expenses.expense_date', '>=', sd).where('expenses.expense_date', '<=', ed).select('expenses.*', 'expense_categories.name as category_name', 'expense_categories.irs_line').orderBy('expenses.expense_date', 'desc'); } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    let trips = [];
    try { trips = await db('mileage_log').where('trip_date', '>=', sd).where('trip_date', '<=', ed).orderBy('trip_date', 'desc'); } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    // Refund ledger for the same window (ET days) — pnl.csv nets these, so
    // the package must include the rows that explain the outflow (a refund
    // in a later period than its payment has no transactions.csv row).
    let refunds = [];
    try {
      // The EXACT query the P&L nets (shared definition) — every outflow
      // figure in pnl.csv has a supporting row here by construction.
      refunds = await outflowTransactionsQuery(db, sd, ed)
        .select(
          'spt.*',
          db.raw("TO_CHAR(spt.created_at_stripe AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as refund_date_et"),
        )
        .orderBy('spt.created_at_stripe', 'desc');
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    // Same predicate as the P&L builder: active assets PLUS disposed ones,
    // so depreciation.csv lists every asset whose prorated depreciation
    // appears in pnl.csv (a disposed-this-year asset previously showed in
    // the P&L but was missing from the supporting schedule).
    let equipment = [];
    try {
      equipment = await db('equipment_register')
        .where(function activeOrDisposed() {
          this.where('active', true).orWhere('disposed', true).orWhereNotNull('disposal_date');
        })
        .orderBy('name');
      // Per-asset depreciation for THIS package's year, same proration AND
      // mid-quarter annotation the P&L uses — the schedule's period column sums
      // to pnl.csv's depreciation line by construction.
      equipment = annotateMidQuarter(equipment).map(e => ({
        ...e,
        period_depreciation: prorateAssetDepreciation(e, sd, ed),
      }));
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    // Time-tracking detail — INFORMATIONAL ONLY. The imputed cost column
    // prices job minutes at the internal job-costing rate; the sole
    // technician is the owner, whose own labor is NOT a deductible expense,
    // so this schedule deliberately does NOT feed pnl.csv (its COGS labor
    // line is real payroll/contract-labor spend only, which flows through
    // expense categories). The summary table stores MINUTES (work_date
    // keyed), not a cost column — the old query filtered a nonexistent
    // `date` column, so this export had been empty since the feature
    // shipped.
    let laborSummaries = [];
    try {
      // Effective-dated rates: each day costs at the rate in force that day
      // (rateAsOf) — same basis as per-visit job costing.
      const rateRows = await db('company_financials')
        .where('effective_date', '<=', ed)
        .orderBy('effective_date', 'asc')
        .select('effective_date', 'loaded_labor_rate')
        .catch(() => []);
      const rows = await db('time_entry_daily_summary as s')
        .leftJoin('technicians as t', 's.technician_id', 't.id')
        .whereBetween('s.work_date', [sd, ed])
        .orderBy('s.work_date', 'desc')
        .select('s.*', 't.name as technician_name');
      laborSummaries = rows.map(r => {
        // dateCellStr: node-postgres DATE cells are local-midnight Dates —
        // etDateString(new Date(...)) printed the previous calendar day.
        const day = dateCellStr(r.work_date);
        const jobHours = (parseFloat(r.total_job_minutes) || 0) / 60;
        const dayRate = rateAsOf(rateRows, day);
        return {
          date: day,
          technician_name: r.technician_name || '',
          // All job hours reported as regular (overtime_hours 0): the summary's
          // overtime_minutes tracks SHIFT overtime, not job-time OT, and the
          // owner-operator draws no OT premium — feeding it to laborToCSV would
          // add a 1.5× pay line on top of hours already counted as regular.
          total_hours: jobHours.toFixed(2),
          overtime_hours: 0,
          jobs: r.job_count || 0,
          rate: dayRate,
          total_cost: (jobHours * dayRate).toFixed(2),
        };
      });
    } catch (e) { if (e?.code !== '42P01') throw e; /* missing table in dev only */ }

    // P&L from the shared builder — identical numbers to GET /pnl and
    // /export/pnl. (The old inline version had $0 revenue via a dead query,
    // and full-year unprorated depreciation.)
    const pnlData = await buildPnlReport(db, sd, ed);

    // Stream ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="waves-tax-package-${year}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    archive.append(csv.transactionsToCSV(payments), { name: 'transactions.csv' });
    archive.append(csv.refundsToCSV(refunds), { name: 'refunds.csv' });
    archive.append(csv.expensesToCSV(expenses), { name: 'expenses.csv' });
    archive.append(csv.mileageToCSV(trips), { name: 'mileage.csv' });
    archive.append(csv.depreciationToCSV(equipment), { name: 'depreciation.csv' });
    // Renamed so a CPA can't mistake the imputed job-costing figures for a
    // payroll expense schedule (owner labor is not deductible).
    archive.append(csv.laborToCSV(laborSummaries), { name: 'labor-timetracking-informational.csv' });
    archive.append(csv.pnlToCSV(pnlData), { name: 'pnl.csv' });
    archive.append(csv.generateReadme(year, pnlData), { name: 'README.txt' });

    await archive.finalize();
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// BANK IMPORT (GATE_BANK_IMPORT) — statement CSV → staging → reconcile
// ═══════════════════════════════════════════════════════════════
// Staging only: nothing under /bank-import writes to `expenses` except the
// explicit create-expense action below, which reuses the exact policy the
// manual POST /expenses applies (server-owned partial deduction, AI-verify
// flag). See services/bank-import.js for the matching policy.

const nodeCrypto = require('crypto');
const bankImport = require('../services/bank-import');
const { gateEnvValue } = require('../config/feature-gates');

const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;

// /bank-import/status always answers (the client uses it to decide whether
// to show the tab at all); every other bank-import route 404s when dark.
router.get('/bank-import/status', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_BANK_IMPORT')) return res.json({ enabled: false });
    const counts = await db('bank_transactions').select('status').count('* as n').groupBy('status');
    res.json({
      enabled: true,
      counts: Object.fromEntries(counts.map(c => [c.status, parseInt(c.n, 10)])),
    });
  } catch (err) { next(err); }
});

router.use('/bank-import', (req, res, next) => {
  if (!gateEnvValue('GATE_BANK_IMPORT')) return res.status(404).json({ error: 'not found' });
  next();
});

router.post('/bank-import/upload', async (req, res, next) => {
  try {
    const { accountLabel, accountType, filename, csv, forceDuplicates, forceRowHashes, forceToken } = req.body || {};
    // normalized ONCE and reused everywhere below — a whitespace-only label
    // would otherwise store/hash as '' and merge unrelated accounts
    const label = typeof accountLabel === 'string' ? accountLabel.trim() : '';
    if (!label || label.length > 100) {
      return res.status(400).json({ error: 'accountLabel is required (max 100 chars)' });
    }
    if (!['bank', 'card'].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be 'bank' or 'card'" });
    }
    if (typeof csv !== 'string' || csv.length === 0) {
      return res.status(400).json({ error: 'csv text is required' });
    }
    if (Buffer.byteLength(csv, 'utf8') > MAX_STATEMENT_BYTES) {
      return res.status(400).json({ error: 'statement too large (2MB max)' });
    }
    // Force options are validated BEFORE any insert — a 400 must mean
    // "nothing changed", never "your rows imported but the force was ignored".
    if (forceDuplicates === true
      && (!Array.isArray(forceRowHashes) || forceRowHashes.length === 0 || forceRowHashes.length > 10000
        || !forceRowHashes.every(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
        || typeof forceToken !== 'string' || forceToken.length < 8 || forceToken.length > 64)) {
      return res.status(400).json({ error: 'forceDuplicates requires forceRowHashes + forceToken from the original upload response' });
    }
    const { rows, skipped } = bankImport.parseStatementCsv(csv);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'no usable rows in that CSV', skipped });
    }
    const hashed = bankImport.withRowHashes(label, rows);
    const toInsert = hashed.map(r => ({
      account_label: label,
      account_type: accountType,
      txn_date: r.txn_date,
      description: r.description,
      amount: r.amount,
      direction: r.direction,
      source: 'csv',
      source_file: String(filename || '').slice(0, 300) || null,
      row_hash: r.row_hash,
    }));
    // Chunked: 9 binds/row × 8k+ rows in one statement would blow past
    // PostgreSQL's 65,535 bind-parameter ceiling and fail the whole upload.
    // One transaction across all chunks: a mid-upload failure rolls the
    // whole import back, so an error response always means "nothing
    // imported" — never a partial commit that a retry then misreports as
    // duplicates. (Force inserts below stay outside: their retry is already
    // idempotent via the confirmation token.)
    const inserted = [];
    await db.transaction(async (trx) => {
      // Advisory xact-lock serializes uploads per canonical label, making
      // the label→type invariant race-free: two concurrent FIRST uploads
      // of the same label with different types can't both pass the check.
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`bank-import-label:${label.toUpperCase()}`]);
      // One account_type per canonical label: row_hash excludes account_type,
      // so re-using a label under the other type would silently dedupe against
      // the existing rows (and book expenses with the wrong payment_method).
      const existingType = await trx('bank_transactions')
        .whereRaw('upper(trim(account_label)) = upper(?)', [label])
        .first('account_type');
      if (existingType && existingType.account_type !== accountType) {
        const asWhat = existingType.account_type === 'bank' ? 'a bank account' : 'a credit card';
        const e = new Error(`"${label}" is already imported as ${asWhat} — keep that type, or use a different label if this is a different account`);
        e.status = 400;
        throw e; // rolls back before any insert
      }
      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = await trx('bank_transactions')
          .insert(toInsert.slice(i, i + 500))
          .onConflict('row_hash')
          .ignore()
          .returning(['id', 'row_hash']);
        inserted.push(...batch);
      }
    });
    // Duplicates are SURFACED, not silently swallowed: identical rows carry
    // no bank-side ID in a CSV, so a skipped row is *probably* a re-upload
    // but could be a genuinely distinct identical purchase from a partial
    // earlier export. The operator sees exactly which rows were skipped and
    // can add the real one by hand if it wasn't a re-upload.
    const insertedHashes = new Set(inserted.map(r => r.row_hash));
    const duplicateRows = hashed.filter(r => !insertedHashes.has(r.row_hash));
    // Force path for the split-across-uploads case: a genuinely distinct
    // identical transaction in a SEPARATE file hashes like a re-upload and
    // is skipped above. When the operator confirms these are real:
    // - Replay safety comes from the SERVER-ISSUED forceToken: a forced row
    //   records {forceToken, forcedFor} in suggestion, and a re-post of the
    //   same confirmation (double-click, network retry) finds that record
    //   and reports alreadyPresent instead of minting another copy.
    // - A LATER genuine confirmation carries a NEW token, so it walks to the
    //   next free ordinal — a third/fourth identical transaction stays
    //   importable. The walk starts past every ordinal this file occupies
    //   (tuple occurrences + row ordinal), so it can never collide with a
    //   row the same upload imported normally, and forced copies stay IN
    //   the ordinal space so a later fuller export dedupes against them.
    // ⛔ Force is scoped to EXPLICIT row hashes from the FIRST response's
    // duplicate set: on the confirming re-post every previously inserted row
    // conflicts too, so an unscoped force would duplicate the whole
    // statement, not just the skipped rows.
    let forced = 0;
    let forceAlreadyPresent = 0;
    let forceFailed = 0;
    if (forceDuplicates === true) {
      const tupleCounts = new Map();
      for (const h of hashed) tupleCounts.set(h.tuple_key, (tupleCounts.get(h.tuple_key) || 0) + 1);
      const forceSet = new Set(forceRowHashes);
      for (const r of duplicateRows.filter(d => forceSet.has(d.row_hash))) {
        const replay = await db('bank_transactions')
          .whereRaw("suggestion->>'forceToken' = ?", [forceToken])
          .whereRaw("suggestion->>'forcedFor' = ?", [r.row_hash])
          .first('id');
        if (replay) { forceAlreadyPresent++; continue; }
        const startOrdinal = tupleCounts.get(r.tuple_key) + r.ordinal;
        let landed = false;
        let lostIdentityRace = false;
        for (let ord = startOrdinal; ord < startOrdinal + 25 && !landed && !lostIdentityRace; ord++) {
          try {
            const [ins] = await db('bank_transactions')
              .insert({
                account_label: label,
                account_type: accountType,
                txn_date: r.txn_date,
                description: r.description,
                amount: r.amount,
                direction: r.direction,
                source: 'csv',
                source_file: String(filename || '').slice(0, 300) || null,
                row_hash: bankImport.hashRow(label, r, ord),
                suggestion: { forceToken, forcedFor: r.row_hash },
              })
              .onConflict('row_hash')
              .ignore()
              .returning(['id']);
            if (ins) landed = true;
          } catch (err) {
            // onConflict only swallows row_hash conflicts; a 23505 that
            // surfaces here is the partial unique index on
            // (forceToken, forcedFor) — a concurrent retry of this SAME
            // confirmation won the race, which IS replay safety. The
            // SELECT above is just the fast path; this is the guarantee.
            if (err.code !== '23505') throw err;
            lostIdentityRace = true;
          }
        }
        if (landed) forced++;
        else if (lostIdentityRace) forceAlreadyPresent++;
        // walk exhausted with THIS token unrecorded = the copy was NOT
        // imported — reporting it as already-present would silently drop a
        // real transaction from review; surface it as an explicit failure
        else forceFailed++;
      }
    }
    // The inserts above are already committed — a matching failure must NOT
    // turn the response into an error, or a retry re-reports every committed
    // row as a duplicate and dangles the force-import footgun. Imports are
    // reported as what they are; matching is retryable via "Run matching".
    let matching = null;
    let matchingError = null;
    try {
      // bounded: a multi-thousand-row backfill must not run thousands of
      // serial per-row queries inside this request — the response reports
      // moreRemaining and "Run matching" continues the pass
      matching = await bankImport.runDeterministicMatching({ limit: 500 });
    } catch (err) {
      logger.warn(`[bank-import] upload imported rows but the matching pass failed: ${err.message}`);
      matchingError = 'rows imported, but the matching pass failed — use "Run matching" to retry';
    }
    res.json({
      success: true,
      parsed: rows.length,
      imported: inserted.length + forced,
      forced,
      forceAlreadyPresent,
      forceFailed,
      duplicates: duplicateRows.length,
      duplicateHashes: duplicateRows.map(r => r.row_hash),
      // one-time confirmation identity for a force re-post (replay-safe)
      forceToken: duplicateRows.length > 0 ? nodeCrypto.randomUUID() : null,
      duplicateSamples: duplicateRows.slice(0, 10).map(r => ({ txn_date: r.txn_date, description: r.description, amount: r.amount, direction: r.direction })),
      skipped,
      matching,
      matchingError,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/bank-import/transactions', async (req, res, next) => {
  try {
    const { status, month, account } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    // limit+1 sentinel row answers hasMore without a second count query.
    // id tie-breaker makes the order TOTAL — bulk-inserted rows share
    // txn_date+created_at, and an unstable order across offset pages would
    // repeat some rows and silently drop others from review.
    let q = db('bank_transactions').orderBy('txn_date', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).offset(offset);
    if (status) q = q.where('status', String(status));
    if (account) q = q.where('account_label', String(account));
    if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      q = q.whereRaw("to_char(txn_date, 'YYYY-MM') = ?", [String(month)]);
    }
    const rows = await q.select('*');
    res.json({ transactions: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit });
  } catch (err) { next(err); }
});

router.post('/bank-import/match', async (req, res, next) => {
  try {
    res.json({ success: true, matching: await bankImport.runDeterministicMatching({ limit: 2000 }) });
  } catch (err) { next(err); }
});

// AI category suggestions for unmatched debits — operator-triggered and
// bounded like /expenses/auto-categorize; writes only the suggestion jsonb,
// never an expense row. `ids` scopes the pass to the rows the operator is
// LOOKING AT (same principle as /expenses/auto-categorize's scoped ids —
// a global oldest-first pass can report "20 processed" while changing
// nothing on screen); without ids it falls back to oldest-first.
router.post('/bank-import/suggest', async (req, res, next) => {
  try {
    const rawLimit = parseInt(req.body?.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter(x => typeof x === 'string').slice(0, 50)
      : null;
    let q = db('bank_transactions')
      .where({ status: 'unmatched', direction: 'debit' })
      .whereRaw("(suggestion is null or (suggestion->>'categoryId') is null)")
      .whereRaw("coalesce(suggestion->>'ignore','') <> 'true'")
      .orderBy('txn_date', 'asc')
      .limit(limit)
      .select('id', 'description', 'amount', 'suggestion');
    if (ids && ids.length) q = q.whereIn('id', ids);
    const rows = await q;
    const results = [];
    for (const row of rows) {
      try {
        const ai = await autoCategorizeExpense(null, row.description, row.amount);
        if (ai?.categoryId) {
          // atomic jsonb merge: the matching pass can write transfer flags
          // or candidates into suggestion DURING the model call — a rebuild
          // from the pre-call snapshot would erase them (same guard the
          // expenses auto-categorize path applies to its post-model write)
          await db('bank_transactions').where({ id: row.id, status: 'unmatched' }).update({
            suggestion: db.raw("coalesce(suggestion, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ categoryId: ai.categoryId, categoryName: ai.categoryName, reasoning: ai.reasoning })]),
            updated_at: new Date(),
          });
          results.push({ id: row.id, category: ai.categoryName, applied: true });
        } else {
          results.push({ id: row.id, applied: false, error: 'no matching category' });
        }
      } catch (err) {
        results.push({ id: row.id, applied: false, error: err.message });
      }
    }
    res.json({ success: true, processed: results.length, results });
  } catch (err) { next(err); }
});

// Create a real expense from a staged debit. Card-statement credits
// (refunds) do NOT create rows here — negative expenses would violate the
// ledger's [0, amount] deductible invariant and the P&L clamps; refunds go
// through /bank-import/:id/apply-refund, which REDUCES the original
// expense instead. The insert and the bank-row claim happen in ONE
// transaction with a CAS on status='unmatched' — a double-click, a match
// landing mid-flight, or a crash between the two statements can never
// leave an orphan expense feeding the P&L.
router.post('/bank-import/:id/create-expense', async (req, res, next) => {
  try {
    const row = await db('bank_transactions').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'row not found' });
    if (row.direction !== 'debit') return res.status(400).json({ error: 'only debits become expenses — card refunds use apply-refund' });
    if (row.status !== 'unmatched') return res.status(409).json({ error: `row is ${row.status}, not unmatched` });

    const suggested = row.suggestion?.categoryId || null;
    const categoryId = req.body?.categoryId || suggested;
    const usedAi = !req.body?.categoryId && !!suggested;
    let deductible = parseFloat(row.amount);
    if (categoryId) {
      const cat = await db('expense_categories').where({ id: categoryId }).first('name');
      if (!cat) return res.status(400).json({ error: 'unknown categoryId' });
      const partial = categoryDeductibleAmount(cat.name, deductible);
      if (partial !== null) deductible = partial;
    }
    const txnDate = dateCellStr(row.txn_date);
    const quarter = `Q${Math.ceil(Number(txnDate.slice(5, 7)) / 3)}`;
    let expense;
    try {
      expense = await db.transaction(async trx => {
        const [inserted] = await trx('expenses').insert({
          category_id: categoryId,
          description: row.description.slice(0, 300),
          amount: row.amount,
          tax_deductible_amount: deductible,
          expense_date: txnDate,
          vendor_name: row.description.slice(0, 200),
          // debit-card/ACH spend from checking books as 'ach'; card accounts as 'card'
          payment_method: row.account_type === 'card' ? 'card' : 'ach',
          tax_year: txnDate.slice(0, 4),
          quarter,
          notes: `[Bank import ${row.account_label}]${usedAi ? ' [AI-categorized — verify]' : ''}`,
        }).returning('*');
        const claimed = await trx('bank_transactions')
          .where({ id: row.id, status: 'unmatched' })
          .update({ status: 'created_expense', matched_expense_id: inserted.id, match_method: 'created', matched_at: new Date(), updated_at: new Date() });
        if (!claimed) {
          const e = new Error('row was matched by someone else mid-flight');
          e.code = 'CLAIM_LOST';
          throw e; // rolls the expense insert back with it
        }
        return inserted;
      });
    } catch (err) {
      if (err.code === 'CLAIM_LOST') return res.status(409).json({ error: err.message });
      throw err;
    }
    res.json({ success: true, expense });
  } catch (err) { next(err); }
});

// Manually link a staged debit to an EXISTING expense (the ambiguous-
// candidates path — creating would duplicate the ledger row, ignoring would
// drop it from coverage). Atomic: CAS on status='unmatched' plus the partial
// unique index on matched_expense_id; losing either race answers 409.
router.post('/bank-import/:id/link-expense', async (req, res, next) => {
  try {
    const { expenseId } = req.body || {};
    if (!expenseId) return res.status(400).json({ error: 'expenseId is required' });
    const row = await db('bank_transactions').where({ id: req.params.id }).first('id', 'direction', 'status', 'amount', 'txn_date');
    if (!row) return res.status(404).json({ error: 'row not found' });
    if (row.direction !== 'debit') return res.status(400).json({ error: 'only debits link to expenses' });
    if (row.status !== 'unmatched') return res.status(409).json({ error: `row is ${row.status}, not unmatched` });
    const expense = await db('expenses').where({ id: expenseId }).first('id', 'amount', 'expense_date');
    if (!expense) return res.status(404).json({ error: 'expense not found' });
    // same amount tolerance + date window the matcher's candidates satisfy —
    // a stale/crafted id outside them would falsify coverage
    if (!bankImport.isPlausibleExpenseLink(row, expense)) {
      return res.status(400).json({ error: 'that expense does not plausibly match this bank row (amount/date outside the matching window)' });
    }
    let claimed;
    try {
      claimed = await db('bank_transactions')
        .where({ id: row.id, status: 'unmatched' })
        .update({ status: 'matched_expense', matched_expense_id: expenseId, match_method: 'manual', matched_at: new Date(), updated_at: new Date() });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'that expense is already linked to another bank row' });
      throw err;
    }
    if (!claimed) return res.status(409).json({ error: 'row was matched by someone else mid-flight' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Apply a card-statement credit (merchant refund) to the ORIGINAL expense:
// the expense's amount is REDUCED and its deductible scaled proportionally
// (floor 0) — never a negative ledger row, which would violate the
// [0, amount] deductible invariant and the P&L clamps. Operator-picked from
// the matcher's parked refundCandidates; the adjustment and the bank-row
// claim commit in one transaction with the expense row locked.
router.post('/bank-import/:id/apply-refund', async (req, res, next) => {
  try {
    const { expenseId } = req.body || {};
    if (!expenseId) return res.status(400).json({ error: 'expenseId is required' });
    const row = await db('bank_transactions').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'row not found' });
    if (row.direction !== 'credit' || row.account_type !== 'card') {
      return res.status(400).json({ error: 'only card-statement credits apply as refunds' });
    }
    if (row.status !== 'unmatched') return res.status(409).json({ error: `row is ${row.status}, not unmatched` });
    // Money-correctness: the target must be one of THIS credit's persisted
    // refundCandidates — a stale or crafted id must never reduce an
    // arbitrary ledger expense. The vendor/method checks re-run under the
    // lock below (the expense can change between parking and applying).
    const parkedIds = (row.suggestion?.refundCandidates || []).map(c => c.id);
    if (!parkedIds.includes(expenseId)) {
      return res.status(400).json({ error: 'that expense is not one of this credit\'s refund candidates — run matching to refresh them' });
    }
    const refund = Number(row.amount);
    let adjusted;
    try {
      adjusted = await db.transaction(async trx => {
        const expense = await trx('expenses').where({ id: expenseId }).forUpdate().first('id', 'amount', 'tax_deductible_amount', 'notes', 'vendor_name', 'description', 'payment_method');
        if (!expense) { const e = new Error('expense not found'); e.status = 404; throw e; }
        if (!bankImport.vendorEvidence(row.description, expense) || bankImport.methodIncompatible(row.account_type, expense.payment_method)) {
          const e = new Error('expense no longer matches this credit (vendor/payment-method) — run matching to refresh candidates');
          e.status = 409;
          throw e;
        }
        const oldAmount = Number(expense.amount);
        if (!(refund <= oldAmount) || oldAmount <= 0) {
          const e = new Error(`refund ($${refund.toFixed(2)}) exceeds the expense's remaining amount ($${oldAmount.toFixed(2)})`);
          e.status = 400;
          throw e;
        }
        const newAmount = Math.round((oldAmount - refund) * 100) / 100;
        // proportional: preserves category policies AND operator-set custom
        // percentages, clamped to the ledger invariant [0, newAmount].
        // NULL stays NULL — the P&L's COALESCE(deductible, amount) fallback
        // means NULL is "fully deductible", and it keeps scaling correctly
        // on its own; converting it to a number here would silently flip
        // the expense to zero-deductible.
        const newDeductible = expense.tax_deductible_amount == null
          ? null
          : Math.min(newAmount, Math.max(0, Math.round(Number(expense.tax_deductible_amount) * (oldAmount ? newAmount / oldAmount : 0) * 100) / 100));
        const [updated] = await trx('expenses').where({ id: expenseId }).update({
          amount: newAmount,
          tax_deductible_amount: newDeductible,
          // etDateString: a business-date stamp — UTC would say "tomorrow"
          // during evening ET hours on Railway. Appended UNSLICED — notes is
          // unrestricted text and truncation would destroy prior audit trail.
          notes: `${expense.notes ? `${expense.notes} ` : ''}[Refund $${refund.toFixed(2)} applied ${etDateString()} from bank import ${row.account_label}]`,
        }).returning(['id', 'amount', 'tax_deductible_amount']);
        const claimed = await trx('bank_transactions')
          .where({ id: row.id, status: 'unmatched' })
          .update({
            status: 'refund_applied',
            match_method: 'refund',
            matched_at: new Date(),
            updated_at: new Date(),
            // refundRestore = exact pre-adjustment values, so undo can
            // restore the expense byte-for-byte (and verify nothing else
            // changed it in between)
            suggestion: bankImport.suggestionMerge({
              refundAppliedTo: expenseId,
              refundAmount: refund,
              // prev = exact pre-adjustment values; applied = what we wrote,
              // so undo can verify NOTHING ELSE edited the expense since
              refundRestore: {
                prevAmount: oldAmount,
                prevDeductible: expense.tax_deductible_amount == null ? null : Number(expense.tax_deductible_amount),
                appliedDeductible: newDeductible,
              },
            }),
          });
        if (!claimed) {
          const e = new Error('row was matched by someone else mid-flight');
          e.code = 'CLAIM_LOST';
          throw e; // rolls the expense adjustment back with it
        }
        return updated;
      });
    } catch (err) {
      if (err.code === 'CLAIM_LOST') return res.status(409).json({ error: err.message });
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    res.json({ success: true, expense: adjusted });
  } catch (err) { next(err); }
});

// Manually link a staged BANK credit to an existing Stripe payout (the
// ambiguous-payout path — the automatic matcher parks candidates when more
// than one paid payout fits). Atomic claim via CAS + the partial unique
// index on matched_payout_id; the reconciliation echo reuses the exact
// mechanism the automatic path uses (pending flag persisted with the claim,
// guarded echo, sweep retry on failure).
router.post('/bank-import/:id/link-payout', async (req, res, next) => {
  try {
    const { payoutId } = req.body || {};
    if (!payoutId) return res.status(400).json({ error: 'payoutId is required' });
    const row = await db('bank_transactions').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'row not found' });
    if (row.direction !== 'credit' || row.account_type !== 'bank') {
      return res.status(400).json({ error: 'only bank-account credits link to payouts' });
    }
    if (row.status !== 'unmatched') return res.status(409).json({ error: `row is ${row.status}, not unmatched` });
    const payout = await db('stripe_payouts').where({ id: payoutId }).first('id', 'status', 'amount', 'arrival_date', 'reconciled');
    if (!payout) return res.status(404).json({ error: 'payout not found' });
    // Only money that actually REACHED the bank can explain a bank credit —
    // the same rule the automatic matcher applies, enforced server-side so
    // a stale or crafted request can't link a pending/failed payout.
    if (payout.status !== 'paid') {
      return res.status(400).json({ error: `payout is ${payout.status}, not paid — only settled payouts can explain a bank credit` });
    }
    // same amount tolerance + arrival window the matcher's candidates
    // satisfy — an unrelated payout would falsify the reconciliation. A
    // reconciled payout compares against its confirmed ACTUAL banked amount.
    const effectiveAmount = await bankImport.effectivePayoutAmount(payout);
    if (!bankImport.isPlausiblePayoutLink(row, { amount: effectiveAmount, arrival_date: payout.arrival_date })) {
      return res.status(400).json({ error: 'that payout does not plausibly match this bank row (amount/arrival outside the matching window)' });
    }
    // The pending flag ALWAYS rides in the claim (an unlocked reconciled
    // pre-read can go stale); the guarded echo below resolves current state.
    let claimed;
    try {
      claimed = await db('bank_transactions')
        .where({ id: row.id, status: 'unmatched' })
        .update({
          status: 'matched_payout',
          matched_payout_id: payoutId,
          match_method: 'manual',
          matched_at: new Date(),
          updated_at: new Date(),
          suggestion: bankImport.suggestionMerge({ reconcilePending: true }),
        });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'that payout is already linked to another bank row' });
      throw err;
    }
    if (!claimed) return res.status(409).json({ error: 'row was matched by someone else mid-flight' });
    let reconciliation;
    try {
      const result = await bankImport.echoPayoutReconciliation(row.id, payoutId, Number(row.amount), `Manually linked to bank import row ${row.id}`);
      if (result && result.skipped && result.reason === 'human_rejected') {
        // the helper REVERTED the link (a human rejected this payout's
        // reconciliation on the Banking page) — success:true would have the
        // UI silently clear the selection while the link no longer exists
        return res.status(409).json({ error: "a human rejected this payout's reconciliation on the Banking page — the link was not kept, and this payout is now excluded for this row" });
      }
      if (result && result.skipped && result.reason === 'precondition') {
        return res.status(409).json({ error: 'row changed mid-flight — reload' });
      }
      if (result && result.amountMismatchReverted) {
        return res.status(409).json({ error: 'that payout was just reconciled with a different banked amount — the link was not kept' });
      }
      reconciliation = result && result.skipped ? 'already_reconciled' : 'confirmed';
    } catch (err) {
      // pending flag persisted with the claim — the matching sweep retries
      logger.warn(`[bank-import] manual payout link ${row.id}→${payoutId} succeeded but reconciliation write failed (sweep will retry): ${err.message}`);
      reconciliation = 'pending';
    }
    res.json({ success: true, reconciliation });
  } catch (err) { next(err); }
});

router.post('/bank-import/:id/ignore', async (req, res, next) => {
  try {
    const changed = await db('bank_transactions')
      .where({ id: req.params.id }).whereIn('status', ['unmatched'])
      .update({ status: 'ignored', updated_at: new Date() });
    if (!changed) return res.status(409).json({ error: 'only unmatched rows can be ignored' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/bank-import/:id/unignore', async (req, res, next) => {
  try {
    const changed = await db('bank_transactions')
      .where({ id: req.params.id, status: 'ignored' })
      .update({ status: 'unmatched', updated_at: new Date() });
    if (!changed) return res.status(409).json({ error: 'row is not ignored' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Undo a wrong link — automatic, manual, or a mis-picked ambiguous candidate.
// The row returns to unmatched with the undo recorded in suggestion.lastUnlink;
// the ledger side is never touched for expenses (deleting a real expense is an
// Expenses-tab decision). For payout rows, releasing the claim and REVERSING
// the reconciliation echo are ONE transaction: the unlink CAS runs inside
// reconcilePayout's precondition hook, so the payout stays claimed until the
// reversal commits with it — another matching pass can never observe a
// released-but-still-reconciled payout (which would link it with no echo and
// then lose the reconciliation to this reversal). The row-specific author
// guard means only the reconciliation THIS row authored can be undone; a
// human's reconciliation is never overridden from here.
// created_expense rows are deliberately excluded: the expense EXISTS because
// of this row, so the undo is deleting it in the Expenses tab — the FK SET
// NULL plus the matcher's self-heal then returns this row to unmatched.
router.post('/bank-import/:id/unlink', async (req, res, next) => {
  try {
    const row = await db('bank_transactions').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'row not found' });
    if (!['matched_expense', 'matched_payout', 'refund_applied'].includes(row.status)) {
      return res.status(409).json({ error: `only matched rows can be unlinked (row is ${row.status})` });
    }

    // refund_applied undo: atomically RESTORE the adjusted expense from the
    // refundRestore snapshot (verifying nothing else changed it since) and
    // return the credit row to review. If the expense was deleted, the undo
    // just releases the row — there is nothing left to restore.
    if (row.status === 'refund_applied') {
      const target = row.suggestion?.refundAppliedTo;
      const restore = row.suggestion?.refundRestore;
      const refund = Number(row.amount);
      try {
        await db.transaction(async (trx) => {
          const expense = target ? await trx('expenses').where({ id: target }).forUpdate().first('id', 'amount', 'tax_deductible_amount', 'notes') : null;
          if (expense && restore) {
            const expected = Math.round((Number(restore.prevAmount) - refund) * 100) / 100;
            const amountUntouched = Math.round(Number(expense.amount) * 100) === Math.round(expected * 100);
            // deductible must ALSO equal what apply-refund wrote — an
            // operator's later deductible/category edit would otherwise be
            // silently destroyed by restoring the old snapshot
            const appliedDeductible = restore.appliedDeductible === undefined ? null : restore.appliedDeductible;
            const deductibleUntouched = (expense.tax_deductible_amount == null && appliedDeductible == null)
              || (expense.tax_deductible_amount != null && appliedDeductible != null
                && Math.round(Number(expense.tax_deductible_amount) * 100) === Math.round(Number(appliedDeductible) * 100));
            if (!amountUntouched || !deductibleUntouched) {
              const e = new Error('the expense changed since this refund was applied — undo it manually on the Expenses tab');
              e.status = 409;
              throw e;
            }
            await trx('expenses').where({ id: target }).update({
              amount: restore.prevAmount,
              tax_deductible_amount: restore.prevDeductible,
              notes: `${expense.notes ? `${expense.notes} ` : ''}[Refund $${refund.toFixed(2)} UNDONE ${etDateString()}]`,
            });
          }
          const changed = await trx('bank_transactions')
            .where({ id: row.id, status: 'refund_applied' })
            .update({
              status: 'unmatched',
              match_method: null,
              matched_at: null,
              suggestion: bankImport.suggestionMerge({ refundUndone: { at: new Date().toISOString(), expenseId: target || null } }, ['refundAppliedTo', 'refundAmount', 'refundRestore']),
              updated_at: new Date(),
            });
          if (!changed) {
            const e = new Error('row changed mid-flight — reload');
            e.status = 409;
            throw e;
          }
        });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      return res.json({ success: true, reconciliation: null });
    }
    const baseSuggestion = row.suggestion || {};
    // rejections are CUMULATIVE: unlinking B after A must not let the
    // matcher re-propose A — every rejected id stays excluded forever
    const rejectedExpenseIds = [...new Set([
      ...(baseSuggestion.rejectedExpenseIds || []),
      ...(row.matched_expense_id ? [row.matched_expense_id] : []),
    ])];
    const rejectedPayoutIds = [...new Set([
      ...(baseSuggestion.rejectedPayoutIds || []),
      ...(row.matched_payout_id ? [row.matched_payout_id] : []),
    ])];
    // atomic jsonb merge (stale confirm-pending flag subtracted): concurrent
    // suggestion writers are appended to, never erased by a snapshot rebuild
    const suggestion = bankImport.suggestionMerge({
      ...(rejectedExpenseIds.length ? { rejectedExpenseIds } : {}),
      ...(rejectedPayoutIds.length ? { rejectedPayoutIds } : {}),
      lastUnlink: {
        at: new Date().toISOString(),
        was: row.status,
        method: row.match_method,
        ...(row.matched_expense_id ? { expenseId: row.matched_expense_id } : {}),
        ...(row.matched_payout_id ? { payoutId: row.matched_payout_id } : {}),
      },
    }, ['reconcilePending']);
    // CAS on the status (and, for payouts, the exact payout id) so a
    // concurrent change 409s instead of being clobbered.
    const doUnlink = (dbOrTrx) => dbOrTrx('bank_transactions')
      .where({
        id: row.id,
        status: row.status,
        ...(row.status === 'matched_payout' ? { matched_payout_id: row.matched_payout_id } : {}),
      })
      .update({
        status: 'unmatched',
        matched_expense_id: null,
        matched_payout_id: null,
        match_method: null,
        matched_at: null,
        suggestion,
        updated_at: new Date(),
      });

    if (row.status === 'matched_expense' || !row.matched_payout_id) {
      const changed = await doUnlink(db);
      if (!changed) return res.status(409).json({ error: 'row changed mid-flight — reload' });
      return res.json({ success: true, reconciliation: null });
    }

    // ONE transaction, payout row locked FIRST (same payout→bank-row lock
    // order as the matcher's echo): the reconciliation decision — reverse
    // ours / keep a human's or a newer claim's / nothing to do — and the
    // unlink commit together. A pending echo retry can't land in the gap:
    // it blocks on the payout lock, and after our commit its still-linked
    // precondition fails.
    const { reconcilePayout } = require('../services/stripe-banking');
    let reconciliation = null;
    try {
      await db.transaction(async (trx) => {
        const payout = await trx('stripe_payouts').where('id', row.matched_payout_id).forUpdate().first('reconciled', 'reconciled_by');
        const changed = await doUnlink(trx);
        if (!changed) {
          const e = new Error('row changed mid-flight — reload');
          e.code = 'CAS_LOST';
          throw e; // rolls everything back
        }
        if (payout && payout.reconciled && payout.reconciled_by === `bank-import:${row.id}`) {
          // reverse OUR OWN reconciliation inside this same transaction; the
          // ownership check just happened under the payout lock, so no
          // further guard is needed
          await reconcilePayout(row.matched_payout_id, Number(row.amount), `Unlinked from bank import row ${row.id}`, `bank-import:${row.id}`, 'rejected', { trx });
          reconciliation = 'reversed';
        } else if (payout && payout.reconciled) {
          // a human or a newer claim owns the reconciliation — never touched
          reconciliation = 'kept';
        }
      });
    } catch (err) {
      if (err.code === 'CAS_LOST') return res.status(409).json({ error: err.message });
      logger.warn(`[bank-import] unlink of row ${row.id} rolled back — reconciliation reversal failed: ${err.message}`);
      return res.status(502).json({ error: `reconciliation reversal failed (${err.message}) — the row is still linked; retry` });
    }
    res.json({ success: true, reconciliation });
  } catch (err) { next(err); }
});

router.get('/bank-import/coverage', async (req, res, next) => {
  try {
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : String(etParts().year);
    res.json({ year, months: await bankImport.ledgerCoverage(year) });
  } catch (err) { next(err); }
});

module.exports = router;
