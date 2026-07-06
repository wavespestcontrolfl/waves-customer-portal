const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

let TwilioService;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

class RetentionEngine {

  async generateRetentionOutreach(customerId) {
    const health = await db('customer_health_scores')
      .where('customer_id', customerId)
      .orderBy('scored_at', 'desc')
      .first();

    // Accept the at-risk band of both scoring engines' vocabularies:
    // customer-intelligence health-scorer writes at_risk/critical, the v3
    // scorer (customer-health.js) writes high/critical onto the same row.
    if (!health || !['at_risk', 'critical', 'high'].includes(health.churn_risk)) return null;

    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return null;

    // Don't bombard — check for recent outreach
    const recent = await db('retention_outreach')
      .where('customer_id', customerId)
      .where('created_at', '>', new Date(Date.now() - 14 * 86400000))
      .first();
    if (recent) return null;

    const riskFactors = typeof health.churn_signals === 'string' ? JSON.parse(health.churn_signals) : (health.churn_signals || []);

    // Get context
    let lastServiceNote = '';
    try {
      const lastSvc = await db('service_records')
        .where('customer_id', customerId)
        .where('status', 'completed')
        .orderBy('service_date', 'desc')
        .first();
      if (lastSvc) lastServiceNote = `Last service: ${lastSvc.service_type} on ${new Date(lastSvc.service_date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })} — "${(lastSvc.tech_notes || '').substring(0, 200)}"`;
    } catch { /* */ }

    let recentSMS = '';
    try {
      const msgs = await db('sms_log')
        .where('customer_id', customerId)
        .orderBy('created_at', 'desc')
        .limit(5)
        .select('direction', 'message_body');
      recentSMS = msgs.map(m => `[${m.direction}] ${(m.message_body || '').substring(0, 150)}`).join('\n');
    } catch { /* */ }

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      // The health_* SMS templates were retired 2026-07-06; without the AI
      // drafter there is no outreach copy to propose, so skip drafting.
      return null;
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 500,
      system: `You generate personalized retention outreach for Waves Pest Control customers showing churn risk. Write as Adam — direct, empathetic, specific. Reference their actual situation. NEVER be generic or corporate.

Strategies:
- Payment issues → offer to update card, payment plan
- Complaints → acknowledge, offer immediate resolution
- No engagement → "checking in", not pushy
- Competitor mentioned → highlight Waves' included perks (callbacks, reports, compliance)
- Price sensitive → remind of tier savings, offer plan review
- Service gap → gentle re-engagement, seasonal relevance

For critical: always recommend personal call from Adam.

Return JSON: { "outreach_type": "sms/call", "strategy": "strategy_name", "message": "exact text", "urgency": "today/this_week" }`,
      messages: [{
        role: 'user',
        content: `Generate retention outreach:

Customer: ${customer.first_name} ${customer.last_name}
Tier: ${customer.waveguard_tier} ($${customer.monthly_rate}/mo)
Health: ${health.overall_score}/100 (${health.churn_risk})
Churn probability: ${Math.round(health.churn_probability * 100)}%

Risk factors:
${riskFactors.map(f => `- ${f.signal}: ${f.value}`).join('\n')}

${lastServiceNote}

Recent SMS:
${recentSMS || 'None'}`
      }]
    });

    let outreach;
    try {
      outreach = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      // Unparseable draft — skip rather than fall back to the retired
      // health_* template copy (removed 2026-07-06).
      return null;
    }

    const [saved] = await db('retention_outreach').insert({
      customer_id: customerId,
      outreach_type: outreach.outreach_type || 'sms',
      outreach_strategy: outreach.strategy,
      message_content: outreach.message,
      status: 'pending_approval',
    }).returning('*');

    // Alert Adam for critical customers
    if (health.churn_risk === 'critical' && TwilioService && process.env.ADAM_PHONE) {
      try {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `🚨 CHURN ALERT: ${customer.first_name} ${customer.last_name} (${customer.waveguard_tier} $${customer.monthly_rate}/mo)\nHealth: ${health.overall_score}/100\nRisk: ${riskFactors[0]?.value || 'Multiple signals'}\nAction: ${outreach.outreach_type.toUpperCase()} — "${(outreach.message || '').substring(0, 100)}..."`,
          { messageType: 'internal_alert' }
        );
      } catch (err) {
        logger.error(`Churn alert SMS failed: ${err.message}`);
      }
    }

    return saved;
  }

  /**
   * Get retention metrics for the dashboard.
   */
  async getMetrics(days = 30) {
    const since = new Date(Date.now() - days * 86400000);

    const outreach = await db('retention_outreach').where('created_at', '>', since);
    const sent = outreach.filter(o => ['sent', 'completed', 'customer_responded', 'save_successful', 'save_failed'].includes(o.status));
    const saved = outreach.filter(o => o.outcome === 'retained' || o.status === 'save_successful');
    const lost = outreach.filter(o => o.outcome === 'cancelled' || o.status === 'save_failed');
    const revenueSaved = saved.reduce((s, o) => s + parseFloat(o.revenue_saved || 0), 0);

    const upsells = await db('upsell_opportunities').where('created_at', '>', since);
    const pitched = upsells.filter(u => ['pitched', 'accepted', 'declined'].includes(u.status));
    const accepted = upsells.filter(u => u.status === 'accepted');
    const upsellRevenue = accepted.reduce((s, u) => s + parseFloat(u.estimated_monthly_value || 0), 0);

    return {
      outreachSent: sent.length,
      customersSaved: saved.length,
      saveRate: sent.length > 0 ? Math.round(saved.length / sent.length * 100) : 0,
      revenueSaved: Math.round(revenueSaved * 100) / 100,
      revenueSavedAnnual: Math.round(revenueSaved * 12 * 100) / 100,
      customersLost: lost.length,
      upsellsPitched: pitched.length,
      upsellsAccepted: accepted.length,
      upsellRevenue: Math.round(upsellRevenue * 100) / 100,
      period: `${days}d`,
    };
  }
}

module.exports = new RetentionEngine();
