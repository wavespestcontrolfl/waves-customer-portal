const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

router.get('/dashboard', async (req, res, next) => {
  try {
    const year = String(new Date().getFullYear());

    // Tax collected YTD (from revenue tables)
    let ytdTaxCollected = 0;
    try {
      const rev = await db('revenue_daily')
        .where('date', '>=', `${year}-01-01`)
        .sum('tax_collected as total').first();
      ytdTaxCollected = parseFloat(rev?.total || 0);
    } catch { /* table may not exist */ }

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

    // Upcoming deadlines
    const nextDeadlines = await db('tax_filing_calendar')
      .where('due_date', '>=', db.fn.now())
      .whereNot('status', 'filed')
      .orderBy('due_date').limit(5)
      .catch(() => []);

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
    // Deactivate old rate for this county
    await db('tax_rates').where({ county, active: true }).update({ active: false, expiry_date: effectiveDate });
    await db('tax_rates').insert({
      county, state: 'FL', state_rate: stateRate, county_surtax: countySurtax,
      combined_rate: parseFloat(stateRate) + parseFloat(countySurtax),
      effective_date: effectiveDate, service_zone: serviceZone, notes, active: true,
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
        serialNumber: e.serial_number, makeModel: e.make_model,
        location: e.location, active: e.active,
        disposed: e.disposed, disposalDate: e.disposal_date,
        notes: e.notes,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/equipment', async (req, res, next) => {
  try {
    const { name, description, assetCategory, irsClass, purchaseDate, purchaseCost,
      salvageValue, depreciationMethod, usefulLifeYears, section179Elected,
      serialNumber, makeModel, location, notes } = req.body;

    const s179 = section179Elected && depreciationMethod === 'section_179';
    await db('equipment_register').insert({
      name, description, asset_category: assetCategory, irs_class: irsClass,
      purchase_date: purchaseDate, placed_in_service_date: purchaseDate,
      purchase_cost: purchaseCost, salvage_value: salvageValue || 0,
      depreciation_method: depreciationMethod || 'MACRS',
      useful_life_years: usefulLifeYears,
      section_179_elected: s179, section_179_amount: s179 ? purchaseCost : null,
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
    const update = { updated_at: new Date() };
    const map = {
      name: 'name', description: 'description', assetCategory: 'asset_category',
      irsClass: 'irs_class', purchaseCost: 'purchase_cost', salvageValue: 'salvage_value',
      depreciationMethod: 'depreciation_method', usefulLifeYears: 'useful_life_years',
      serialNumber: 'serial_number', makeModel: 'make_model', location: 'location',
      notes: 'notes', active: 'active', disposed: 'disposed', disposalDate: 'disposal_date',
      disposalProceeds: 'disposal_proceeds',
    };
    for (const [k, col] of Object.entries(map)) { if (fields[k] !== undefined) update[col] = fields[k]; }
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
    const { year, quarter, categoryId, page = 1, limit = 50 } = req.query;
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
      .where(function () { if (year) this.where('tax_year', year); })
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
    if (!categoryId && (vendorName || description)) {
      try {
        aiCategory = await autoCategorizeExpense(vendorName, description, amount);
        if (aiCategory?.categoryId) {
          categoryId = aiCategory.categoryId;
          // If AI says partially deductible, adjust
          if (aiCategory.deductiblePercent !== undefined && aiCategory.deductiblePercent < 100) {
            deductibleAmount = deductibleAmount ?? parseFloat((amount * aiCategory.deductiblePercent / 100).toFixed(2));
          }
        }
      } catch (err) {
        logger.warn(`[tax] AI expense categorization failed: ${err.message}`);
        // Continue without categorization — don't block the insert
      }
    }

    const [inserted] = await db('expenses').insert({
      category_id: categoryId, description, amount,
      tax_deductible_amount: deductibleAmount ?? amount,
      expense_date: expenseDate, vendor_name: vendorName,
      payment_method: paymentMethod, is_recurring: isRecurring || false,
      recurrence_period: recurrencePeriod, tax_year: taxYear, quarter, notes,
    }).returning('*');

    res.json({
      success: true,
      expense: inserted,
      aiCategorized: !!aiCategory,
      aiCategory: aiCategory || null,
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

/**
 * Use Claude to auto-categorize an expense into an IRS Schedule C category.
 * Returns { categoryId, categoryName, irsLine, deductiblePercent, reasoning }
 */
async function autoCategorizeExpense(vendorName, description, amount) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  // Get expense categories from the DB to match against
  const categories = await db('expense_categories').orderBy('sort_order');
  const categoryList = categories.map(c =>
    `- ${c.name} (IRS Line ${c.irs_line}): ${c.irs_description}${c.notes ? ` — ${c.notes}` : ''}`
  ).join('\n');

  const prompt = `You are a tax categorization assistant for a pest control / lawn care business in Florida.

Given this expense, categorize it into the correct IRS Schedule C category and determine deductibility.

Expense details:
- Vendor: ${vendorName || 'Unknown'}
- Description: ${description || 'None provided'}
- Amount: $${amount}

Available categories:
${categoryList}

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "categoryName": "exact category name from the list above",
  "irsLine": "the IRS line number",
  "deductiblePercent": 100,
  "reasoning": "one sentence why"
}

Rules:
- Business meals are 50% deductible
- Vehicle expenses: use "Vehicle Expenses" category
- Software, SaaS, hosting: use "Software & Technology"
- Chemicals, PPE, equipment supplies: use "Supplies"
- If truly unclear, use "Office Expenses" as default`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try extracting JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : {};
  }

  // Match the AI's category name to an actual DB record
  if (parsed.categoryName) {
    const match = categories.find(c =>
      c.name.toLowerCase() === parsed.categoryName.toLowerCase()
    );
    if (match) {
      parsed.categoryId = match.id;
    }
  }

  return parsed;
}

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

    const year = new Date(tripDate).getFullYear();
    // IRS rates by year
    const rateMap = { 2024: 0.67, 2025: 0.70, 2026: 0.70 };
    const irsRate = rateMap[year] || 0.70;
    const deductionAmount = parseFloat((distanceMiles * irsRate).toFixed(2));

    const [inserted] = await db('mileage_log').insert({
      vehicle_name: vehicleName || 'Manual Entry',
      trip_date: tripDate,
      start_address: startAddress || null,
      end_address: endAddress || null,
      distance_miles: distanceMiles,
      duration_minutes: durationMinutes || null,
      purpose: purpose || 'business',
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

    res.json({
      year,
      totalMiles: parseFloat(totals.total_miles),
      totalDeduction: parseFloat(totals.total_deduction),
      tripCount: parseInt(totals.trip_count),
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

// ═══════════════════════════════════════════════════════════════
// REVENUE RECONCILIATION (Square Integration)
// ═══════════════════════════════════════════════════════════════

// GET /revenue/reconcile?month=2026-04 — Square tax reconciliation
router.get('/revenue/reconcile', async (req, res, next) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month parameter required in YYYY-MM format' });
    }

    const SquareTaxReconciliation = require('../services/square-tax-reconciliation');
    const result = await SquareTaxReconciliation.reconcileSalesTax(month);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /revenue/quarterly-estimate?quarter=Q2 — estimated quarterly payment
router.get('/revenue/quarterly-estimate', async (req, res, next) => {
  try {
    const { quarter } = req.query;
    if (!quarter || !/^Q[1-4]$/.test(quarter)) {
      return res.status(400).json({ error: 'quarter parameter required (Q1, Q2, Q3, or Q4)' });
    }

    const SquareTaxReconciliation = require('../services/square-tax-reconciliation');
    const result = await SquareTaxReconciliation.calculateQuarterlyEstimate(quarter);
    res.json(result);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// P&L REPORTING
// ═══════════════════════════════════════════════════════════════

router.get('/pnl', async (req, res, next) => {
  try {
    const { period = 'mtd', start_date, end_date } = req.query;
    const now = new Date();
    let startDate, endDate;

    switch (period) {
      case 'monthly':
      case 'mtd':
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        endDate = now.toISOString().split('T')[0];
        break;
      case 'last_month': {
        const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-01`;
        const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = `${lmEnd.getFullYear()}-${String(lmEnd.getMonth() + 1).padStart(2, '0')}-${String(lmEnd.getDate()).padStart(2, '0')}`;
        break;
      }
      case 'quarterly': {
        const qMonth = Math.floor(now.getMonth() / 3) * 3;
        startDate = `${now.getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;
        endDate = now.toISOString().split('T')[0];
        break;
      }
      case 'ytd':
        startDate = `${now.getFullYear()}-01-01`;
        endDate = now.toISOString().split('T')[0];
        break;
      case 'annual':
      case 'last_year':
        startDate = `${now.getFullYear() - 1}-01-01`;
        endDate = `${now.getFullYear() - 1}-12-31`;
        break;
      case 'custom':
        startDate = start_date;
        endDate = end_date;
        break;
      default:
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        endDate = now.toISOString().split('T')[0];
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'start_date and end_date required for custom period' });
    }

    // Revenue from payments
    let serviceRevenue = 0, otherRevenue = 0;
    try {
      const rev = await db('payments')
        .where('created_at', '>=', startDate)
        .where('created_at', '<=', endDate + ' 23:59:59')
        .where('status', 'completed')
        .select(
          db.raw("COALESCE(SUM(CASE WHEN type != 'refund' THEN amount ELSE 0 END), 0) as revenue"),
          db.raw("COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END), 0) as refunds")
        ).first();
      serviceRevenue = parseFloat(rev?.revenue || 0) - parseFloat(rev?.refunds || 0);
    } catch {
      try {
        const rev = await db('revenue_daily')
          .where('date', '>=', startDate).where('date', '<=', endDate)
          .sum('total_revenue as total').first();
        serviceRevenue = parseFloat(rev?.total || 0);
      } catch { /* tables may not exist */ }
    }

    // Labor costs from time_entry_daily_summary
    let laborCost = 0;
    try {
      const labor = await db('time_entry_daily_summary')
        .where('date', '>=', startDate).where('date', '<=', endDate)
        .select(
          db.raw('COALESCE(SUM(total_cost), 0) as total')
        ).first();
      laborCost = parseFloat(labor?.total || 0);
    } catch { /* table may not exist */ }

    // Materials / supplies expenses (COGS)
    let materialsCost = 0;
    try {
      const mats = await db('expenses')
        .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
        .where('expenses.expense_date', '>=', startDate)
        .where('expenses.expense_date', '<=', endDate)
        .whereIn('expense_categories.name', ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'])
        .sum('expenses.amount as total').first();
      materialsCost = parseFloat(mats?.total || 0);
    } catch { /* */ }

    // Operating expenses by category (excluding COGS categories)
    let opexCategories = [];
    let opexTotal = 0;
    try {
      opexCategories = await db('expenses')
        .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
        .where('expenses.expense_date', '>=', startDate)
        .where('expenses.expense_date', '<=', endDate)
        .whereNotIn('expense_categories.name', ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'])
        .select('expense_categories.name as category', 'expense_categories.irs_line')
        .sum('expenses.amount as total')
        .groupBy('expense_categories.name', 'expense_categories.irs_line')
        .orderBy('total', 'desc');
      opexTotal = opexCategories.reduce((s, c) => s + parseFloat(c.total || 0), 0);
    } catch {
      try {
        const allExp = await db('expenses')
          .where('expense_date', '>=', startDate).where('expense_date', '<=', endDate)
          .sum('amount as total').first();
        opexTotal = parseFloat(allExp?.total || 0) - materialsCost;
      } catch { /* */ }
    }

    // Mileage deduction
    let mileageDeduction = 0;
    try {
      const mil = await db('mileage_log')
        .where('trip_date', '>=', startDate).where('trip_date', '<=', endDate)
        .sum('deduction_amount as total').first();
      mileageDeduction = parseFloat(mil?.total || 0);
    } catch { /* */ }

    // Depreciation
    let depreciationTotal = 0;
    try {
      const depr = await db('equipment_register').where('active', true)
        .sum('annual_depreciation as total').first();
      // Prorate based on period length
      const days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
      const yearFraction = days / 365;
      depreciationTotal = parseFloat(depr?.total || 0) * yearFraction;
    } catch { /* */ }

    const totalRevenue = serviceRevenue + otherRevenue;
    const cogsTotal = laborCost + materialsCost;
    const grossProfit = totalRevenue - cogsTotal;
    const grossMargin = totalRevenue > 0 ? grossProfit / totalRevenue : 0;
    const deductionsTotal = mileageDeduction + depreciationTotal;
    const netIncome = grossProfit - opexTotal - deductionsTotal;
    const netMargin = totalRevenue > 0 ? netIncome / totalRevenue : 0;

    res.json({
      period, startDate, endDate,
      revenue: { serviceRevenue, otherRevenue, total: totalRevenue },
      cogs: { labor: laborCost, materials: materialsCost, total: cogsTotal },
      grossProfit,
      grossMargin,
      operatingExpenses: {
        categories: opexCategories.map(c => ({
          name: c.category || 'Uncategorized', irsLine: c.irs_line, amount: parseFloat(c.total || 0),
        })),
        total: opexTotal,
      },
      deductions: { mileage: mileageDeduction, depreciation: depreciationTotal, total: deductionsTotal },
      netIncome,
      netMargin,
    });
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
        .whereIn('invoices.status', ['sent', 'overdue', 'unpaid', 'pending'])
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
      const amount = parseFloat(inv.amount || inv.total || inv.amount_due || 0);
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
        .where('created_at', '>=', sd).where('created_at', '<=', ed + ' 23:59:59')
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
    let equipment = [];
    try {
      equipment = await db('equipment_register').where('active', true).orderBy('name');
    } catch { /* */ }

    const csvStr = csv.depreciationToCSV(equipment);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-depreciation-${new Date().getFullYear()}.csv"`);
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
    // Reuse the /pnl endpoint logic by making an internal call
    const period = req.query.period || 'ytd';
    const params = new URLSearchParams({ period, ...req.query });
    const pnlRes = await new Promise((resolve, reject) => {
      const mockReq = { ...req, query: Object.fromEntries(params) };
      const data = {};
      const mockRes = { json: (d) => resolve(d), status: () => mockRes, setHeader: () => {} };
      // Inline the P&L logic instead
      reject(new Error('use_fetch'));
    }).catch(async () => {
      // Fetch P&L data via the same route handler logic
      const url = `${req.protocol}://${req.get('host')}/api/admin/tax/pnl?${params}`;
      const resp = await fetch(url, { headers: { Authorization: req.headers.authorization } });
      return resp.json();
    }).catch(async () => {
      // Fallback: build P&L inline
      const now = new Date();
      const year = now.getFullYear();
      const startDate = req.query.start_date || `${year}-01-01`;
      const endDate = req.query.end_date || now.toISOString().split('T')[0];

      let serviceRevenue = 0;
      try {
        const rev = await db('payments').where('created_at', '>=', startDate).where('created_at', '<=', endDate + ' 23:59:59').where('status', 'completed')
          .select(db.raw("COALESCE(SUM(CASE WHEN type != 'refund' THEN amount ELSE 0 END), 0) as revenue")).first();
        serviceRevenue = parseFloat(rev?.revenue || 0);
      } catch { try { const rev = await db('revenue_daily').where('date', '>=', startDate).where('date', '<=', endDate).sum('total_revenue as total').first(); serviceRevenue = parseFloat(rev?.total || 0); } catch { /* */ } }

      let laborCost = 0;
      try { const l = await db('time_entry_daily_summary').where('date', '>=', startDate).where('date', '<=', endDate).sum('total_cost as total').first(); laborCost = parseFloat(l?.total || 0); } catch { /* */ }

      let materialsCost = 0;
      try { const m = await db('expenses').leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id').where('expenses.expense_date', '>=', startDate).where('expenses.expense_date', '<=', endDate).whereIn('expense_categories.name', ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals']).sum('expenses.amount as total').first(); materialsCost = parseFloat(m?.total || 0); } catch { /* */ }

      let opexCats = [];
      try { opexCats = await db('expenses').leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id').where('expenses.expense_date', '>=', startDate).where('expenses.expense_date', '<=', endDate).whereNotIn('expense_categories.name', ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals']).select('expense_categories.name as category').sum('expenses.amount as total').groupBy('expense_categories.name').orderBy('total', 'desc'); } catch { /* */ }
      const opexTotal = opexCats.reduce((s, c) => s + parseFloat(c.total || 0), 0);

      let mileageDed = 0;
      try { const ml = await db('mileage_log').where('trip_date', '>=', startDate).where('trip_date', '<=', endDate).sum('deduction_amount as total').first(); mileageDed = parseFloat(ml?.total || 0); } catch { /* */ }

      let depreciation = 0;
      try { const dp = await db('equipment_register').where('active', true).sum('annual_depreciation as total').first(); const days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1; depreciation = parseFloat(dp?.total || 0) * (days / 365); } catch { /* */ }

      const cogsTotal = laborCost + materialsCost;
      const grossProfit = serviceRevenue - cogsTotal;
      const deductionsTotal = mileageDed + depreciation;
      const netIncome = grossProfit - opexTotal - deductionsTotal;

      return {
        revenue: { serviceRevenue, otherRevenue: 0, total: serviceRevenue },
        cogs: { labor: laborCost, materials: materialsCost, total: cogsTotal },
        grossProfit,
        grossMargin: serviceRevenue > 0 ? grossProfit / serviceRevenue : 0,
        operatingExpenses: { categories: opexCats.map(c => ({ name: c.category || 'Uncategorized', amount: parseFloat(c.total || 0) })), total: opexTotal },
        deductions: { mileage: mileageDed, depreciation, total: deductionsTotal },
        netIncome,
        netMargin: serviceRevenue > 0 ? netIncome / serviceRevenue : 0,
      };
    });

    const csvStr = csv.pnlToCSV(pnlRes);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves-pnl-${req.query.period || 'ytd'}-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csvStr);
  } catch (err) { next(err); }
});

router.get('/export/tax-package', async (req, res, next) => {
  try {
    const archiver = require('archiver');
    const year = req.query.year || String(new Date().getFullYear());
    const sd = `${year}-01-01`;
    const ed = `${year}-12-31`;

    // Gather all data with fallbacks
    let payments = [];
    try { payments = await db('payments').where('created_at', '>=', sd).where('created_at', '<=', ed + ' 23:59:59').leftJoin('customers', 'payments.customer_id', 'customers.id').select('payments.*', db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, 'Unknown') as customer_name")).orderBy('payments.created_at', 'desc'); } catch { /* */ }

    let expenses = [];
    try { expenses = await db('expenses').leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id').where('expenses.expense_date', '>=', sd).where('expenses.expense_date', '<=', ed).select('expenses.*', 'expense_categories.name as category_name', 'expense_categories.irs_line').orderBy('expenses.expense_date', 'desc'); } catch { /* */ }

    let trips = [];
    try { trips = await db('mileage_log').where('trip_date', '>=', sd).where('trip_date', '<=', ed).orderBy('trip_date', 'desc'); } catch { /* */ }

    let equipment = [];
    try { equipment = await db('equipment_register').where('active', true).orderBy('name'); } catch { /* */ }

    let laborSummaries = [];
    try { laborSummaries = await db('time_entry_daily_summary').where('date', '>=', sd).where('date', '<=', ed).orderBy('date', 'desc'); } catch { /* */ }

    // Build P&L data
    let serviceRevenue = 0;
    try { const rev = await db('payments').where('created_at', '>=', sd).where('created_at', '<=', ed + ' 23:59:59').where('status', 'completed').select(db.raw("COALESCE(SUM(CASE WHEN type != 'refund' THEN amount ELSE 0 END), 0) as revenue")).first(); serviceRevenue = parseFloat(rev?.revenue || 0); } catch { /* */ }
    const laborCost = laborSummaries.reduce((s, l) => s + parseFloat(l.total_cost || 0), 0);
    const materialsCost = expenses.filter(e => ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'].includes(e.category_name)).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const opexItems = expenses.filter(e => !['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'].includes(e.category_name));
    const opexByCategory = {};
    opexItems.forEach(e => { const cat = e.category_name || 'Uncategorized'; opexByCategory[cat] = (opexByCategory[cat] || 0) + parseFloat(e.amount || 0); });
    const opexTotal = Object.values(opexByCategory).reduce((s, v) => s + v, 0);
    const mileageDed = trips.reduce((s, t) => s + parseFloat(t.deduction_amount || 0), 0);
    const depreciation = equipment.reduce((s, e) => s + parseFloat(e.annual_depreciation || 0), 0);
    const cogsTotal = laborCost + materialsCost;
    const grossProfit = serviceRevenue - cogsTotal;
    const deductionsTotal = mileageDed + depreciation;
    const netIncome = grossProfit - opexTotal - deductionsTotal;

    const pnlData = {
      revenue: { serviceRevenue, otherRevenue: 0, total: serviceRevenue },
      cogs: { labor: laborCost, materials: materialsCost, total: cogsTotal },
      grossProfit,
      grossMargin: serviceRevenue > 0 ? grossProfit / serviceRevenue : 0,
      operatingExpenses: {
        categories: Object.entries(opexByCategory).map(([name, amount]) => ({ name, amount })),
        total: opexTotal,
      },
      deductions: { mileage: mileageDed, depreciation, total: deductionsTotal },
      netIncome,
      netMargin: serviceRevenue > 0 ? netIncome / serviceRevenue : 0,
    };

    // Stream ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="waves-tax-package-${year}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    archive.append(csv.transactionsToCSV(payments), { name: 'transactions.csv' });
    archive.append(csv.expensesToCSV(expenses), { name: 'expenses.csv' });
    archive.append(csv.mileageToCSV(trips), { name: 'mileage.csv' });
    archive.append(csv.depreciationToCSV(equipment), { name: 'depreciation.csv' });
    archive.append(csv.laborToCSV(laborSummaries), { name: 'labor.csv' });
    archive.append(csv.pnlToCSV(pnlData), { name: 'pnl.csv' });
    archive.append(csv.generateReadme(year, pnlData), { name: 'README.txt' });

    await archive.finalize();
  } catch (err) { next(err); }
});

module.exports = router;
