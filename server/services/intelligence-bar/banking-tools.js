/**
 * Intelligence Bar — Banking & Cash Flow Tools
 * server/services/intelligence-bar/banking-tools.js
 *
 * Tools for the Banking page. Stripe balance, payout history,
 * cash flow analysis, fee tracking, reconciliation, and exports.
 */

const db = require('../../models/db');
const logger = require('../logger');
const StripeBanking = require('../stripe-banking');
const { etDateString, etMonthStart, etMonthEnd, etQuarterStart, etYearStart, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const BANKING_TOOLS = [
  {
    name: 'get_stripe_balance',
    description: `Get current Stripe balance: available funds, pending funds, and next scheduled payout.
Use for: "what's our Stripe balance?", "how much is available?", "when's the next payout?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_payout_history',
    description: `Get Stripe payout history with status, amounts, fees, and arrival dates. Filter by days back, status, or limit.
Use for: "recent payouts", "show me last 10 payouts", "any failed payouts?", "payouts this month"`,
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'How many days back to look (default 30)' },
        status: { type: 'string', enum: ['paid', 'pending', 'in_transit', 'canceled', 'failed'], description: 'Filter by payout status' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'get_payout_details',
    description: `Get full details for a specific payout including all transactions (charges, refunds, fees). Find by payout ID or arrival date.
Use for: "show me the payout from April 10", "break down payout po_xxx", "what charges were in the last payout?"`,
    input_schema: {
      type: 'object',
      properties: {
        payout_id: { type: 'string', description: 'Local UUID or Stripe payout ID (po_xxx)' },
        date: { type: 'string', description: 'Find payout by arrival date (YYYY-MM-DD) — used if payout_id not provided' },
      },
    },
  },
  {
    name: 'get_cash_flow',
    description: `Get cash flow analysis: revenue in, expenses out, Stripe fees, payouts, and net cash flow. Daily breakdown + period totals.
Use for: "cash flow this month", "show me MTD cash flow", "revenue vs expenses last month", "where's the money going?"`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['mtd', 'last_month', 'quarterly', 'ytd'], description: 'Reporting period (default mtd)' },
        start_date: { type: 'string', description: 'Custom start date YYYY-MM-DD (overrides period)' },
        end_date: { type: 'string', description: 'Custom end date YYYY-MM-DD (overrides period)' },
      },
    },
  },
  {
    name: 'get_fee_analysis',
    description: `Analyze Stripe processing fees: total fees, effective rate, fee breakdown by transaction type, average fee per charge.
Use for: "how much are we paying in Stripe fees?", "what's our effective processing rate?", "fee breakdown this month"`,
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'How many days back to analyze (default 30)' },
      },
    },
  },
  {
    name: 'request_instant_payout',
    description: `Request an instant payout from Stripe to the linked bank account. Instant payouts have a ~1% fee. THIS IS A WRITE OPERATION — confirm the amount with the operator before executing.
Use for: "instant payout", "send $500 to bank now", "emergency payout"`,
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount in dollars to pay out instantly' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'get_unreconciled_payouts',
    description: `Get payouts that haven't been reconciled against bank statements. Shows expected amounts, arrival dates, and reconciliation status.
Use for: "unreconciled payouts", "what needs reconciling?", "bank reconciliation status"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'export_payouts',
    description: `Export payout data as OFX (for Capital One / QuickBooks) or CSV. Returns download content.
Use for: "export payouts for QuickBooks", "download payout CSV", "OFX export for this month"`,
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['ofx', 'csv'], description: 'Export format (default csv)' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
      },
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeBankingTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_stripe_balance': return await getStripeBalance();
      case 'get_payout_history': return await getPayoutHistory(input);
      case 'get_payout_details': return await getPayoutDetailsHandler(input);
      case 'get_cash_flow': return await getCashFlowHandler(input);
      case 'get_fee_analysis': return await getFeeAnalysis(input);
      case 'request_instant_payout': return await requestInstantPayout(input);
      case 'get_unreconciled_payouts': return await getUnreconciledPayouts(input);
      case 'export_payouts': return await exportPayouts(input);
      default: return { error: `Unknown banking tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:banking] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getStripeBalance() {
  try {
    const balance = await StripeBanking.getBalance();
    return balance;
  } catch (err) {
    return { error: `Could not fetch Stripe balance: ${err.message}` };
  }
}


async function getPayoutHistory(input) {
  const { days_back = 30, status, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);
  const cutoff = new Date(Date.now() - days_back * 86400000).toISOString();

  try {
    let query = db('stripe_payouts')
      .where('created_at', '>=', cutoff)
      .orderBy('arrival_date', 'desc')
      .limit(limit);

    if (status) query = query.where('status', status);

    const payouts = await query;

    // Summary stats
    const totalAmount = payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const totalFees = payouts.reduce((s, p) => s + parseFloat(p.fee_total || 0), 0);

    return {
      payouts: payouts.map(p => ({
        id: p.id,
        stripe_payout_id: p.stripe_payout_id,
        amount: parseFloat(p.amount || 0),
        fee_total: parseFloat(p.fee_total || 0),
        net: parseFloat(p.amount || 0) - parseFloat(p.fee_total || 0),
        status: p.status,
        arrival_date: p.arrival_date,
        method: p.method,
        transaction_count: p.transaction_count || 0,
        bank_name: p.bank_name,
        bank_last_four: p.bank_last_four,
        reconciled: p.reconciled,
      })),
      total: payouts.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      total_fees: Math.round(totalFees * 100) / 100,
      total_net: Math.round((totalAmount - totalFees) * 100) / 100,
    };
  } catch (err) {
    return { error: `Could not fetch payout history: ${err.message}` };
  }
}


async function getPayoutDetailsHandler(input) {
  const { payout_id, date } = input;

  try {
    if (payout_id) {
      return await StripeBanking.getPayoutDetails(payout_id);
    }

    if (date) {
      // Find payout by arrival date
      const payout = await db('stripe_payouts')
        .whereRaw("DATE(arrival_date) = ?", [date])
        .orderBy('amount', 'desc')
        .first();

      if (!payout) return { error: `No payout found for date ${date}` };
      return await StripeBanking.getPayoutDetails(payout.id);
    }

    // Default: get the most recent payout
    const latest = await db('stripe_payouts')
      .orderBy('arrival_date', 'desc')
      .first();

    if (!latest) return { error: 'No payouts found. Run a sync first.' };
    return await StripeBanking.getPayoutDetails(latest.id);
  } catch (err) {
    return { error: `Could not fetch payout details: ${err.message}` };
  }
}


async function getCashFlowHandler(input) {
  const { period = 'mtd', start_date, end_date } = input;

  let startDate, endDate;
  const now = new Date();
  const today = etDateString(now);

  // Custom dates override period
  if (start_date && end_date) {
    startDate = start_date;
    endDate = end_date;
  } else {
    switch (period) {
      case 'mtd':
        startDate = etMonthStart(now); endDate = today; break;
      case 'last_month':
        startDate = etMonthStart(now, -1); endDate = etMonthEnd(now, -1); break;
      case 'quarterly':
        startDate = etQuarterStart(now); endDate = today; break;
      case 'ytd':
        startDate = etYearStart(now); endDate = today; break;
      default:
        startDate = etMonthStart(now); endDate = today;
    }
  }

  try {
    return await StripeBanking.getCashFlow(startDate, endDate);
  } catch (err) {
    return { error: `Cash flow analysis failed: ${err.message}` };
  }
}


async function getFeeAnalysis(input) {
  const { days_back = 30 } = input;
  const cutoff = new Date(Date.now() - days_back * 86400000).toISOString();

  try {
    // Get all transactions with fees in the period
    const txns = await db('stripe_payout_transactions')
      .where('created_at_stripe', '>=', cutoff)
      .select('type', 'amount', 'fee', 'net');

    if (txns.length === 0) {
      return { note: 'No transaction data found. You may need to sync payouts first.', total_fees: 0 };
    }

    const totalAmount = txns.reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
    const totalFees = txns.reduce((s, t) => s + parseFloat(t.fee || 0), 0);
    const totalNet = txns.reduce((s, t) => s + parseFloat(t.net || 0), 0);
    const chargesOnly = txns.filter(t => t.type === 'charge');
    const chargeAmount = chargesOnly.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const chargeFees = chargesOnly.reduce((s, t) => s + parseFloat(t.fee || 0), 0);

    // Fee breakdown by type
    const byType = {};
    txns.forEach(t => {
      const type = t.type || 'other';
      if (!byType[type]) byType[type] = { count: 0, amount: 0, fees: 0 };
      byType[type].count++;
      byType[type].amount += Math.abs(parseFloat(t.amount || 0));
      byType[type].fees += parseFloat(t.fee || 0);
    });

    const feeBreakdown = Object.entries(byType).map(([type, data]) => ({
      type,
      count: data.count,
      volume: Math.round(data.amount * 100) / 100,
      fees: Math.round(data.fees * 100) / 100,
      effective_rate: data.amount > 0 ? Math.round(data.fees / data.amount * 10000) / 100 : 0,
    })).sort((a, b) => b.fees - a.fees);

    return {
      period_days: days_back,
      total_volume: Math.round(totalAmount * 100) / 100,
      total_fees: Math.round(totalFees * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      effective_rate_pct: totalAmount > 0 ? Math.round(totalFees / totalAmount * 10000) / 100 : 0,
      charge_effective_rate_pct: chargeAmount > 0 ? Math.round(chargeFees / chargeAmount * 10000) / 100 : 0,
      avg_fee_per_charge: chargesOnly.length > 0 ? Math.round(chargeFees / chargesOnly.length * 100) / 100 : 0,
      transaction_count: txns.length,
      charge_count: chargesOnly.length,
      fee_breakdown: feeBreakdown,
    };
  } catch (err) {
    return { error: `Fee analysis failed: ${err.message}` };
  }
}


async function requestInstantPayout(input) {
  const { amount } = input;

  if (!amount || amount <= 0) {
    return { error: 'Amount must be a positive number.' };
  }

  // Calculate instant payout fee (~1%)
  const estimatedFee = Math.round(amount * 0.01 * 100) / 100;
  const netAmount = Math.round((amount - estimatedFee) * 100) / 100;

  try {
    const result = await StripeBanking.createInstantPayout(amount);
    return {
      ...result,
      estimated_fee: estimatedFee,
      net_after_fee: netAmount,
      note: `Instant payout of $${amount.toFixed(2)} requested. Estimated fee: $${estimatedFee.toFixed(2)} (~1%). Funds should arrive within minutes.`,
    };
  } catch (err) {
    return { error: `Instant payout failed: ${err.message}` };
  }
}


async function getUnreconciledPayouts(input) {
  const { limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);

  try {
    const payouts = await db('stripe_payouts')
      .where('reconciled', false)
      .where('status', 'paid')
      .orderBy('arrival_date', 'desc')
      .limit(limit);

    const totalUnreconciled = payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    // Count how many are reconciled for context
    const reconciledCount = await db('stripe_payouts')
      .where('reconciled', true)
      .count('* as count')
      .first()
      .catch(() => ({ count: 0 }));

    return {
      unreconciled: payouts.map(p => ({
        id: p.id,
        stripe_payout_id: p.stripe_payout_id,
        amount: parseFloat(p.amount || 0),
        arrival_date: p.arrival_date,
        method: p.method,
        transaction_count: p.transaction_count || 0,
        fee_total: parseFloat(p.fee_total || 0),
        bank_name: p.bank_name,
        days_since_arrival: p.arrival_date
          ? Math.floor(
              (parseETDateTime(etDateString() + 'T12:00') -
                parseETDateTime((p.arrival_date instanceof Date ? etDateString(p.arrival_date) : String(p.arrival_date).slice(0, 10)) + 'T12:00'))
              / 86400000,
            )
          : null,
      })),
      total: payouts.length,
      total_unreconciled_amount: Math.round(totalUnreconciled * 100) / 100,
      reconciled_count: parseInt(reconciledCount?.count || 0),
    };
  } catch (err) {
    return { error: `Could not fetch unreconciled payouts: ${err.message}` };
  }
}


async function exportPayouts(input) {
  const { format = 'csv', start_date, end_date } = input;

  const now = new Date();
  const endDate = end_date || etDateString(now);
  const startDate = start_date || etDateString(addETDays(now, -30));

  try {
    const result = await StripeBanking.generateExport(format, startDate, endDate);
    return {
      format: format,
      filename: result.filename,
      content_type: result.content_type,
      payout_count: result.payout_count,
      total_amount: result.total_amount,
      period: { start: startDate, end: endDate },
      content_preview: result.content.substring(0, 500),
      note: `Export generated: ${result.filename} (${result.payout_count} payouts, $${(result.total_amount || 0).toFixed(2)} total)`,
    };
  } catch (err) {
    return { error: `Export failed: ${err.message}` };
  }
}


module.exports = { BANKING_TOOLS, executeBankingTool };
