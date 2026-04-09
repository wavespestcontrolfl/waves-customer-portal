// DEPRECATED — Square has been removed. Migrated to Stripe.
// This file is kept for reference only. Safe to delete.

/**
 * Square Tax Reconciliation Service
 *
 * Pulls revenue data from Square Orders API and reconciles against
 * tax_rates table. Calculates quarterly estimated tax payments.
 *
 * Florida has no state income tax, so estimates focus on:
 * - Self-employment tax (15.3% on 92.35% of net income)
 * - Federal income tax (estimated brackets)
 * - FL sales tax collected vs owed
 */

const { Client, Environment } = require('square');
const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');

// Initialize Square client
let squareClient, ordersApi, paymentsApi;
try {
  if (config.square?.accessToken) {
    squareClient = new Client({
      accessToken: config.square.accessToken,
      environment: config.square.environment === 'production'
        ? Environment.Production
        : Environment.Sandbox,
    });
    ordersApi = squareClient.ordersApi;
    paymentsApi = squareClient.paymentsApi;
  }
} catch { /* square not available */ }

// 2026 Federal income tax brackets (single / sole prop)
const FEDERAL_BRACKETS = [
  { min: 0, max: 11600, rate: 0.10 },
  { min: 11600, max: 47150, rate: 0.12 },
  { min: 47150, max: 100525, rate: 0.22 },
  { min: 100525, max: 191950, rate: 0.24 },
  { min: 191950, max: 243725, rate: 0.32 },
  { min: 243725, max: 609350, rate: 0.35 },
  { min: 609350, max: Infinity, rate: 0.37 },
];

// Self-employment tax constants
const SE_TAX_RATE = 0.153; // 12.4% Social Security + 2.9% Medicare
const SE_INCOME_FACTOR = 0.9235; // only 92.35% of net income is subject to SE tax
const SE_DEDUCTION_FACTOR = 0.5; // deduct half of SE tax from income

class SquareTaxReconciliation {
  /**
   * Pull all Square orders in a date range and calculate revenue + tax collected
   *
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD
   * @returns {{ totalRevenue, taxCollected, orderCount, byServiceType, byLocation }}
   */
  async getRevenueByPeriod(startDate, endDate) {
    if (!ordersApi) throw new Error('Square not configured — check SQUARE_ACCESS_TOKEN');

    const locationId = config.square.locationId;
    const locationIds = locationId ? [locationId] : [];

    // If no location configured, try to list all
    if (!locationIds.length) {
      try {
        const locRes = await squareClient.locationsApi.listLocations();
        (locRes.result?.locations || []).forEach(l => locationIds.push(l.id));
      } catch { /* empty */ }
    }

    if (!locationIds.length) throw new Error('No Square location found');

    let allOrders = [];
    let cursor = undefined;

    // Paginate through all orders in the date range
    do {
      const response = await ordersApi.searchOrders({
        locationIds,
        query: {
          filter: {
            dateTimeFilter: {
              createdAt: {
                startAt: `${startDate}T00:00:00Z`,
                endAt: `${endDate}T23:59:59Z`,
              },
            },
            stateFilter: { states: ['COMPLETED'] },
          },
          sort: { sortField: 'CREATED_AT', sortOrder: 'ASC' },
        },
        cursor,
        limit: 100,
      });

      const orders = response.result?.orders || [];
      allOrders = allOrders.concat(orders);
      cursor = response.result?.cursor;
    } while (cursor);

    // Aggregate
    let totalRevenue = 0;
    let taxCollected = 0;
    const byServiceType = {};
    const byLocation = {};

    for (const order of allOrders) {
      const totalMoney = order.totalMoney?.amount ? Number(order.totalMoney.amount) / 100 : 0;
      const totalTax = order.totalTaxMoney?.amount ? Number(order.totalTaxMoney.amount) / 100 : 0;
      const revenueExTax = totalMoney - totalTax;

      totalRevenue += revenueExTax;
      taxCollected += totalTax;

      // By location
      const locId = order.locationId || 'unknown';
      if (!byLocation[locId]) byLocation[locId] = { revenue: 0, tax: 0, count: 0 };
      byLocation[locId].revenue += revenueExTax;
      byLocation[locId].tax += totalTax;
      byLocation[locId].count++;

      // By service type (from line items)
      for (const item of (order.lineItems || [])) {
        const name = item.name || 'Other';
        if (!byServiceType[name]) byServiceType[name] = { revenue: 0, count: 0 };
        const itemTotal = item.totalMoney?.amount ? Number(item.totalMoney.amount) / 100 : 0;
        const itemTax = item.totalTaxMoney?.amount ? Number(item.totalTaxMoney.amount) / 100 : 0;
        byServiceType[name].revenue += (itemTotal - itemTax);
        byServiceType[name].count++;
      }
    }

    return {
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      taxCollected: parseFloat(taxCollected.toFixed(2)),
      orderCount: allOrders.length,
      startDate,
      endDate,
      byServiceType,
      byLocation,
    };
  }

  /**
   * Calculate quarterly estimated tax payment
   *
   * Estimates SE tax + federal income tax based on YTD revenue
   * minus YTD deductible expenses. FL has no state income tax.
   *
   * @param {string} quarter - Q1, Q2, Q3, or Q4
   * @returns {{ quarterLabel, ytdRevenue, ytdExpenses, estimatedNetIncome, seTax, federalIncomeTax, totalEstimated, quarterlyPayment }}
   */
  async calculateQuarterlyEstimate(quarter) {
    const year = new Date().getFullYear();
    const yearStr = String(year);
    const quarterNum = parseInt(quarter.replace('Q', ''));
    if (quarterNum < 1 || quarterNum > 4) throw new Error('Invalid quarter — use Q1, Q2, Q3, or Q4');

    // End date for the estimate (end of the quarter month range)
    const quarterEndMonths = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
    const startDate = `${year}-01-01`;
    const endDate = `${year}-${quarterEndMonths[quarterNum]}`;

    // YTD Revenue from Square
    let ytdRevenue = 0;
    try {
      const rev = await this.getRevenueByPeriod(startDate, endDate);
      ytdRevenue = rev.totalRevenue;
    } catch (err) {
      logger.warn(`[tax-reconciliation] Could not pull Square revenue: ${err.message}`);
      // Fallback: try revenue_daily table
      const dbRev = await db('revenue_daily')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .sum('total_revenue as total')
        .first()
        .catch(() => ({ total: 0 }));
      ytdRevenue = parseFloat(dbRev?.total || 0);
    }

    // YTD Expenses (deductible)
    const expResult = await db('expenses')
      .where('tax_year', yearStr)
      .sum('tax_deductible_amount as total')
      .first()
      .catch(() => ({ total: 0 }));
    const ytdExpenses = parseFloat(expResult?.total || 0);

    // Mileage deductions
    const mileageResult = await db('mileage_log')
      .where('trip_date', '>=', startDate)
      .where('trip_date', '<=', endDate)
      .where('purpose', 'business')
      .sum('deduction_amount as total')
      .first()
      .catch(() => ({ total: 0 }));
    const mileageDeduction = parseFloat(mileageResult?.total || 0);

    // Equipment depreciation
    const depResult = await db('equipment_register')
      .where('active', true)
      .sum('annual_depreciation as total')
      .first()
      .catch(() => ({ total: 0 }));
    // Prorate depreciation to YTD
    const annualDep = parseFloat(depResult?.total || 0);
    const monthsElapsed = quarterNum * 3;
    const ytdDepreciation = parseFloat(((annualDep / 12) * monthsElapsed).toFixed(2));

    const totalDeductions = ytdExpenses + mileageDeduction + ytdDepreciation;
    const estimatedNetIncome = Math.max(0, ytdRevenue - totalDeductions);

    // Annualize the income to project full-year tax
    const annualizedIncome = (estimatedNetIncome / quarterNum) * 4;

    // Self-employment tax
    const seIncome = annualizedIncome * SE_INCOME_FACTOR;
    const seTax = parseFloat((seIncome * SE_TAX_RATE).toFixed(2));
    const seDeduction = seTax * SE_DEDUCTION_FACTOR;

    // Federal income tax (on income after SE deduction)
    const taxableIncome = Math.max(0, annualizedIncome - seDeduction - 14600); // standard deduction 2026 est
    let federalIncomeTax = 0;
    for (const bracket of FEDERAL_BRACKETS) {
      if (taxableIncome <= bracket.min) break;
      const taxableInBracket = Math.min(taxableIncome, bracket.max) - bracket.min;
      federalIncomeTax += taxableInBracket * bracket.rate;
    }
    federalIncomeTax = parseFloat(federalIncomeTax.toFixed(2));

    const totalEstimated = seTax + federalIncomeTax;
    const quarterlyPayment = parseFloat((totalEstimated / 4).toFixed(2));

    // Check what has already been paid this year
    const paidResult = await db('tax_filing_calendar')
      .where('filing_type', '1040es_quarterly')
      .where('period_label', 'like', `%${year}%`)
      .where('status', 'filed')
      .sum('amount_paid as total')
      .first()
      .catch(() => ({ total: 0 }));
    const alreadyPaid = parseFloat(paidResult?.total || 0);

    return {
      quarter: `${quarter} ${year}`,
      ytdRevenue,
      ytdExpenses: totalDeductions,
      estimatedNetIncome,
      annualizedIncome: parseFloat(annualizedIncome.toFixed(2)),
      seTax,
      federalIncomeTax,
      totalAnnualEstimated: parseFloat(totalEstimated.toFixed(2)),
      quarterlyPayment,
      alreadyPaid,
      remainingDue: parseFloat(Math.max(0, quarterlyPayment - alreadyPaid).toFixed(2)),
      breakdown: {
        mileageDeduction,
        expenseDeduction: ytdExpenses,
        depreciation: ytdDepreciation,
        standardDeduction: 14600,
        seDeduction: parseFloat(seDeduction.toFixed(2)),
      },
    };
  }

  /**
   * Reconcile sales tax: compare tax collected in Square vs tax owed based on tax_rates
   *
   * @param {string} month - YYYY-MM format (e.g., "2026-04")
   * @returns {{ month, revenueSubjectToTax, taxCollected, taxOwed, difference, byCounty }}
   */
  async reconcileSalesTax(month) {
    const [year, mon] = month.split('-');
    const startDate = `${month}-01`;
    // Last day of the month
    const endDate = new Date(parseInt(year), parseInt(mon), 0).toISOString().split('T')[0];

    // Get revenue from Square for this month
    let squareData;
    try {
      squareData = await this.getRevenueByPeriod(startDate, endDate);
    } catch (err) {
      logger.warn(`[tax-reconciliation] Square pull failed, using DB: ${err.message}`);
      // Fallback to revenue_daily
      const dbData = await db('revenue_daily')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .select(
          db.raw('COALESCE(SUM(total_revenue), 0) as revenue'),
          db.raw('COALESCE(SUM(tax_collected), 0) as tax'),
          db.raw('COUNT(*) as days'),
        ).first();
      squareData = {
        totalRevenue: parseFloat(dbData?.revenue || 0),
        taxCollected: parseFloat(dbData?.tax || 0),
        orderCount: parseInt(dbData?.days || 0),
      };
    }

    // Get active tax rates
    const rates = await db('tax_rates')
      .where('active', true)
      .orderBy('county');

    // Calculate what tax SHOULD have been collected
    // Use weighted average rate across all service zones
    let avgRate = 0.07; // default FL 7%
    if (rates.length > 0) {
      avgRate = rates.reduce((sum, r) => sum + parseFloat(r.combined_rate), 0) / rates.length;
    }

    const taxOwed = parseFloat((squareData.totalRevenue * avgRate).toFixed(2));
    const difference = parseFloat((squareData.taxCollected - taxOwed).toFixed(2));

    const byCounty = rates.map(r => ({
      county: r.county,
      combinedRate: parseFloat(r.combined_rate),
      stateRate: parseFloat(r.state_rate),
      countySurtax: parseFloat(r.county_surtax),
    }));

    return {
      month,
      revenueSubjectToTax: squareData.totalRevenue,
      taxCollected: squareData.taxCollected,
      taxOwed,
      difference,
      status: Math.abs(difference) < 1 ? 'balanced' : difference > 0 ? 'over_collected' : 'under_collected',
      avgTaxRate: parseFloat(avgRate.toFixed(4)),
      orderCount: squareData.orderCount,
      byCounty,
    };
  }

  /**
   * Sync Square revenue into a summary format
   * Stores daily aggregates for dashboard use
   *
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD
   * @returns {{ daysSynced, totalRevenue, totalTax }}
   */
  async syncRevenue(startDate, endDate) {
    let revenueData;
    try {
      revenueData = await this.getRevenueByPeriod(startDate, endDate);
    } catch (err) {
      logger.error(`[tax-reconciliation] syncRevenue failed: ${err.message}`);
      throw err;
    }

    // Upsert into revenue_daily if table exists
    try {
      const hasTable = await db.schema.hasTable('revenue_daily');
      if (hasTable) {
        await db('revenue_daily')
          .insert({
            date: startDate,
            total_revenue: revenueData.totalRevenue,
            tax_collected: revenueData.taxCollected,
            order_count: revenueData.orderCount,
            source: 'square_sync',
          })
          .onConflict('date')
          .merge();
      }
    } catch (err) {
      logger.warn(`[tax-reconciliation] Could not save to revenue_daily: ${err.message}`);
    }

    logger.info(`[tax-reconciliation] Revenue synced: $${revenueData.totalRevenue} revenue, $${revenueData.taxCollected} tax, ${revenueData.orderCount} orders`);

    return {
      daysSynced: 1,
      totalRevenue: revenueData.totalRevenue,
      totalTax: revenueData.taxCollected,
      orderCount: revenueData.orderCount,
    };
  }
}

module.exports = new SquareTaxReconciliation();
