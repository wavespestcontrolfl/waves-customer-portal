/**
 * Tax Advisor — Weekly AI analysis of business tax situation.
 *
 * Runs every Sunday at 7 AM. Analyzes:
 * - Revenue & expense data from the portal
 * - Current tax collected vs liability
 * - Equipment depreciation status
 * - Upcoming filing deadlines
 * - New FL/federal tax regulations (via web search)
 * - Deduction gaps & savings opportunities
 * - Procurement spend & resale certificate usage
 *
 * Uses Claude with web_search tool to find current regulations.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { etDateString } = require('../utils/datetime-et');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

let TwilioService;
try { TwilioService = require('./twilio'); } catch { TwilioService = null; }

class TaxAdvisor {

  async generateWeeklyReport() {
    logger.info('[TaxAdvisor] Running weekly tax analysis...');

    const snapshot = await this.gatherFinancialSnapshot();
    const deadlines = await this.getUpcomingDeadlines();
    const equipment = await this.getEquipmentSummary();
    const expenses = await this.getExpenseSummary();
    const taxRates = await this.getCurrentTaxRates();
    const exemptions = await this.getExemptionStatus();
    const procurement = await this.getProcurementSummary();

    const analysisData = {
      snapshot,
      deadlines,
      equipment,
      expenses,
      taxRates,
      exemptions,
      procurement,
      reportDate: etDateString(),
    };

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      const fallback = this.generateFallbackReport(analysisData);
      await this.storeReport(fallback, analysisData);
      return fallback;
    }

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 6000,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
        system: `You are a tax advisor specializing in small service businesses (pest control, lawn care) operating as LLCs in Florida. You provide weekly analysis for Waves Pest Control, LLC.

BUSINESS CONTEXT:
- Entity: Waves Pest Control, LLC — single-member LLC, taxed as sole proprietorship (Schedule C)
- Owner-operator in Southwest Florida (Manatee, Sarasota, Charlotte counties)
- Services: pest control, termite, rodent exclusion, mosquito programs (WaveGuard), lawn care, tree & shrub
- All services are taxable under FL §212.05(1)(i)1 except standalone inspections
- FL combined sales tax rate: 7% across all service counties (6% state + 1% county surtax)
- Files monthly FL DR-15 sales tax returns
- Files quarterly 1040-ES federal estimated tax payments
- Equipment: Ford Transit van, spray systems, dethatcher, topdresser, injection equipment
- Primary supplier: SiteOne Landscape Supply (Branch #238 Lakewood Ranch)
- Has a Florida Annual Resale Certificate for product purchases used in taxable services
- Employees: owner + technician (Adam Benetti)
- Software stack: Stripe (payments/invoicing), Twilio (SMS), Railway (hosting), various SaaS

YOUR WEEKLY TASKS:
1. SEARCH for new FL DOR bulletins, tax rate changes, federal tax law changes affecting small businesses, and IRS updates for self-employed/Schedule C filers
2. Review the financial data provided and identify savings opportunities
3. Check for deduction gaps — expenses they might be missing or under-tracking
4. Flag upcoming deadlines and compliance risks
5. Calculate estimated quarterly tax liability based on current revenue trajectory
6. Identify equipment purchases that should use Section 179 vs MACRS
7. Review procurement spending for resale certificate optimization
8. Suggest timing strategies (defer income, accelerate deductions near year-end, etc.)

IMPORTANT SEARCHES TO MAKE:
- "Florida DOR tax bulletin ${new Date().getFullYear()}" — for new FL tax regulations
- "IRS small business tax changes ${new Date().getFullYear()}" — federal changes
- "Section 179 deduction limit ${new Date().getFullYear()}" — current limits
- "Florida sales tax pest control lawn care" — any changes to service taxability
- "self-employment tax rate ${new Date().getFullYear()}" — current SE tax rate
- "QBI deduction pest control" — Section 199A qualified business income deduction

RULES:
- Be specific with dollar amounts. Don't say "you could save money" — say "switching to actual vehicle expense tracking could save ~$2,400/year based on your current mileage"
- Always cite the specific regulation, statute, or IRS publication
- Prioritize by dollar impact
- Flag anything that's time-sensitive (deadlines, elections, safe harbor thresholds)
- If you find a regulation change, explain exactly how it affects this business

Return valid JSON only (no markdown fences):
{
  "report_date": "YYYY-MM-DD",
  "period": "Week of Month DD, YYYY",
  "grade": "A/B/C/D/F",
  "executive_summary": "2-3 sentence overview of tax health",
  "financial_snapshot": {
    "estimated_ytd_revenue": 0,
    "estimated_ytd_expenses": 0,
    "estimated_ytd_net_income": 0,
    "ytd_tax_collected": 0,
    "estimated_annual_tax_liability": 0,
    "quarterly_payment_recommendation": 0,
    "effective_tax_rate_estimate": "XX%"
  },
  "regulation_changes": [
    {"source": "FL DOR / IRS", "change": "description", "effective_date": "date", "impact": "how it affects this business", "action_required": "what to do", "url": "source URL"}
  ],
  "savings_opportunities": [
    {"title": "short description", "estimated_annual_savings": 0, "category": "deduction/credit/timing/structure", "action": "specific steps", "priority": "high/medium/low", "deadline": "if time-sensitive"}
  ],
  "deduction_gaps": [
    {"deduction": "what's being missed", "estimated_value": 0, "irs_reference": "publication/form", "how_to_claim": "steps"}
  ],
  "compliance_alerts": [
    {"alert": "description", "severity": "high/medium/low", "deadline": "date if applicable", "action": "what to do"}
  ],
  "equipment_recommendations": [
    {"item": "equipment name", "recommendation": "Section 179 vs MACRS vs bonus", "reason": "why", "tax_benefit": 0}
  ],
  "procurement_insights": [
    {"insight": "description", "action": "what to do", "savings": 0}
  ],
  "action_items": [
    {"priority": "high/medium/low", "action": "specific task", "deadline": "date", "estimated_impact": 0, "category": "savings/compliance/deduction/planning"}
  ]
}`,
        messages: [
          {
            role: 'user',
            content: `Here is the current financial data for Waves Pest Control, LLC. Please analyze it, search for current tax regulations and changes, and provide your weekly tax advisory report.

FINANCIAL DATA:
${JSON.stringify(analysisData, null, 2)}

Please search for current FL and federal tax changes, then provide your analysis as JSON.`,
          },
        ],
      });

      // Process response — handle tool use (web search may produce multiple content blocks)
      let rawText = '';
      if (response.content) {
        // May have multiple rounds if web search is used
        rawText = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
      }

      // Parse JSON from response
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```/g, '').trim();
      let report;
      try {
        report = JSON.parse(cleaned);
      } catch (parseErr) {
        logger.error(`[TaxAdvisor] Failed to parse AI response: ${parseErr.message}`);
        report = this.generateFallbackReport(analysisData);
        report.raw_ai_response = rawText;
      }

      await this.storeReport(report, analysisData, rawText);

      // Send SMS summary if critical alerts
      const criticalAlerts = (report.compliance_alerts || []).filter(a => a.severity === 'high');
      const highSavings = (report.savings_opportunities || []).filter(s => s.priority === 'high');
      if (criticalAlerts.length > 0 || highSavings.length > 0) {
        await this.sendSMSSummary(report);
      }

      return report;

    } catch (err) {
      logger.error(`[TaxAdvisor] AI analysis failed: ${err.message}`);
      const fallback = this.generateFallbackReport(analysisData);
      await this.storeReport(fallback, analysisData);
      return fallback;
    }
  }

  // ── Data Gathering Methods ─────────────────────────────────

  async gatherFinancialSnapshot() {
    try {
      const year = new Date().getFullYear();
      const startOfYear = `${year}-01-01`;

      // Revenue from revenue tables or estimates
      const revenue = await db('revenue_daily')
        .where('date', '>=', startOfYear)
        .select(
          db.raw('SUM(total_revenue) as ytd_revenue'),
          db.raw('SUM(tax_collected) as ytd_tax_collected'),
          db.raw('COUNT(DISTINCT date) as days_tracked'),
        ).first().catch(() => null);

      // Expenses
      const expenseTotal = await db('expenses')
        .where('tax_year', String(year))
        .select(
          db.raw('SUM(amount) as total'),
          db.raw('SUM(tax_deductible_amount) as deductible'),
          db.raw('COUNT(*) as count'),
        ).first().catch(() => null);

      return {
        ytdRevenue: parseFloat(revenue?.ytd_revenue || 0),
        ytdTaxCollected: parseFloat(revenue?.ytd_tax_collected || 0),
        daysTracked: parseInt(revenue?.days_tracked || 0),
        ytdExpenses: parseFloat(expenseTotal?.total || 0),
        ytdDeductibleExpenses: parseFloat(expenseTotal?.deductible || 0),
        expenseCount: parseInt(expenseTotal?.count || 0),
      };
    } catch (err) {
      logger.warn(`[TaxAdvisor] Financial snapshot error: ${err.message}`);
      return { ytdRevenue: 0, ytdTaxCollected: 0, ytdExpenses: 0 };
    }
  }

  async getUpcomingDeadlines() {
    try {
      const upcoming = await db('tax_filing_calendar')
        .where('due_date', '>=', db.fn.now())
        .where('status', '!=', 'filed')
        .orderBy('due_date')
        .limit(10);

      return upcoming.map(f => ({
        type: f.filing_type,
        title: f.title,
        period: f.period_label,
        dueDate: f.due_date,
        status: f.status,
        amountDue: f.amount_due ? parseFloat(f.amount_due) : null,
      }));
    } catch { return []; }
  }

  async getEquipmentSummary() {
    try {
      const equip = await db('equipment_register').where('active', true);
      return {
        totalAssets: equip.length,
        totalCost: equip.reduce((s, e) => s + parseFloat(e.purchase_cost || 0), 0),
        totalBookValue: equip.reduce((s, e) => s + parseFloat(e.current_book_value || 0), 0),
        totalDepreciation: equip.reduce((s, e) => s + parseFloat(e.accumulated_depreciation || 0), 0),
        section179Total: equip.filter(e => e.section_179_elected).reduce((s, e) => s + parseFloat(e.section_179_amount || 0), 0),
        items: equip.map(e => ({
          name: e.name, category: e.asset_category,
          cost: parseFloat(e.purchase_cost), bookValue: parseFloat(e.current_book_value || 0),
          method: e.depreciation_method, irsClass: e.irs_class,
        })),
      };
    } catch { return { totalAssets: 0, items: [] }; }
  }

  async getExpenseSummary() {
    try {
      const year = String(new Date().getFullYear());
      const byCategory = await db('expenses')
        .where('tax_year', year)
        .join('expense_categories', 'expenses.category_id', 'expense_categories.id')
        .select('expense_categories.name as category', 'expense_categories.irs_line')
        .sum('expenses.amount as total')
        .sum('expenses.tax_deductible_amount as deductible')
        .count('* as count')
        .groupBy('expense_categories.name', 'expense_categories.irs_line')
        .orderBy('total', 'desc');

      return byCategory.map(c => ({
        category: c.category, irsLine: c.irs_line,
        total: parseFloat(c.total || 0),
        deductible: parseFloat(c.deductible || 0),
        count: parseInt(c.count),
      }));
    } catch { return []; }
  }

  async getCurrentTaxRates() {
    try {
      return await db('tax_rates').where('active', true);
    } catch { return []; }
  }

  async getExemptionStatus() {
    try {
      const exemptions = await db('tax_exemptions').where('active', true);
      const expiringSoon = exemptions.filter(e =>
        e.expiry_date && new Date(e.expiry_date) < new Date(Date.now() + 90 * 86400000)
      );
      return { total: exemptions.length, expiringSoon: expiringSoon.length };
    } catch { return { total: 0, expiringSoon: 0 }; }
  }

  async getProcurementSummary() {
    try {
      const year = new Date().getFullYear();
      const productSpend = await db('vendor_pricing')
        .where('is_best_price', true)
        .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
        .select('vendors.name as vendor')
        .count('* as products')
        .sum('vendor_pricing.price as total')
        .groupBy('vendors.name')
        .orderBy('total', 'desc')
        .limit(10);

      return {
        topVendors: productSpend.map(v => ({
          vendor: v.vendor, products: parseInt(v.products),
          totalSpend: parseFloat(v.total || 0),
        })),
      };
    } catch { return { topVendors: [] }; }
  }

  // ── Report Storage ─────────────────────────────────────────

  async storeReport(report, analysisData, rawResponse) {
    try {
      const [saved] = await db('tax_advisor_reports').insert({
        report_date: report.report_date || etDateString(),
        period: report.period || `Week of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`,
        grade: report.grade || 'N/A',
        executive_summary: report.executive_summary || '',
        financial_snapshot: JSON.stringify(report.financial_snapshot || {}),
        regulation_changes: JSON.stringify(report.regulation_changes || []),
        savings_opportunities: JSON.stringify(report.savings_opportunities || []),
        deduction_gaps: JSON.stringify(report.deduction_gaps || []),
        compliance_alerts: JSON.stringify(report.compliance_alerts || []),
        action_items: JSON.stringify(report.action_items || []),
        raw_ai_response: rawResponse || JSON.stringify(report),
        model_used: MODELS.FLAGSHIP,
      }).returning('*');

      // Create alert records for action items
      const allAlerts = [
        ...(report.savings_opportunities || []).map(s => ({
          report_id: saved.id, alert_type: 'savings', priority: s.priority || 'medium',
          title: s.title, description: s.action,
          estimated_savings: s.estimated_annual_savings,
          action_by_date: s.deadline || null,
        })),
        ...(report.compliance_alerts || []).map(a => ({
          report_id: saved.id, alert_type: 'compliance', priority: a.severity || 'medium',
          title: a.alert, description: a.action,
          action_by_date: a.deadline || null,
        })),
        ...(report.deduction_gaps || []).map(d => ({
          report_id: saved.id, alert_type: 'deduction', priority: 'medium',
          title: d.deduction, description: d.how_to_claim,
          estimated_savings: d.estimated_value,
        })),
      ];

      if (allAlerts.length > 0) {
        await db('tax_advisor_alerts').insert(allAlerts);
      }

      logger.info(`[TaxAdvisor] Report stored with ${allAlerts.length} alerts`);
    } catch (err) {
      logger.error(`[TaxAdvisor] Failed to store report: ${err.message}`);
    }
  }

  // ── SMS Summary ────────────────────────────────────────────

  async sendSMSSummary(report) {
    if (!TwilioService || !process.env.ADMIN_PHONE) return;

    try {
      const savings = (report.savings_opportunities || [])
        .filter(s => s.priority === 'high')
        .map(s => `• ${s.title}: ~$${s.estimated_annual_savings}/yr`)
        .join('\n');

      const alerts = (report.compliance_alerts || [])
        .filter(a => a.severity === 'high')
        .map(a => `⚠️ ${a.alert}`)
        .join('\n');

      let msg = `📊 Waves Tax Advisor — ${report.period}\nGrade: ${report.grade}\n\n${report.executive_summary}\n`;
      if (savings) msg += `\n💰 Savings:\n${savings}\n`;
      if (alerts) msg += `\n${alerts}\n`;
      msg += `\nFull report in admin portal → Tax Center`;

      await TwilioService.sendSMS({
        to: process.env.ADMIN_PHONE,
        body: msg.substring(0, 1500),
      });

      await db('tax_advisor_reports')
        .where('report_date', report.report_date)
        .update({ sms_sent: true });

    } catch (err) {
      logger.error(`[TaxAdvisor] SMS failed: ${err.message}`);
    }
  }

  // ── Fallback (no AI) ──────────────────────────────────────

  generateFallbackReport(data) {
    const upcoming = (data.deadlines || []).filter(d => d.status === 'upcoming');
    return {
      report_date: etDateString(),
      period: `Week of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`,
      grade: 'N/A',
      executive_summary: `Data-only report (AI unavailable). ${upcoming.length} upcoming filing deadlines. Revenue: $${data.snapshot?.ytdRevenue?.toLocaleString() || '0'} YTD. Tax collected: $${data.snapshot?.ytdTaxCollected?.toLocaleString() || '0'}.`,
      financial_snapshot: data.snapshot || {},
      regulation_changes: [],
      savings_opportunities: [],
      deduction_gaps: [],
      compliance_alerts: upcoming.map(d => ({
        alert: `${d.title} due ${new Date(d.dueDate).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`,
        severity: new Date(d.dueDate) < new Date(Date.now() + 14 * 86400000) ? 'high' : 'medium',
        deadline: d.dueDate, action: `Prepare and file ${d.type}`,
      })),
      action_items: [],
    };
  }
}

module.exports = new TaxAdvisor();
