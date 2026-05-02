/**
 * Customer Retention Agent — Tool Executor
 */

const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

async function executeRetentionTool(toolName, input) {
  switch (toolName) {

    // ── Health & Signals ────────────────────────────────────────

    case 'run_overall_scores': {
      const HealthScorer = require('./health-scorer');
      return HealthScorer.calculateAllHealthScores();
    }

    case 'detect_signals': {
      const SignalDetector = require('./signal-detector');
      return SignalDetector.detectAllSignals();
    }

    case 'get_at_risk_customers': {
      const levels = input.risk_levels || ['critical', 'at_risk', 'watch'];
      const limit = input.limit || 30;

      // Get the most recent health score for each customer
      const scores = await db('customer_health_scores as h')
        .innerJoin(
          db.raw(`(SELECT customer_id, MAX(scored_at) as max_date FROM customer_health_scores GROUP BY customer_id) as latest`),
          function () { this.on('h.customer_id', 'latest.customer_id').andOn('h.scored_at', 'latest.max_date'); }
        )
        .innerJoin('customers as c', 'h.customer_id', 'c.id')
        .whereIn('h.churn_risk', levels)
        .where('c.active', true)
        .select(
          'c.id', 'c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate',
          'c.phone', 'c.city', 'c.pipeline_stage',
          'h.overall_score', 'h.churn_risk', 'h.churn_probability',
          'h.churn_signals', 'h.next_best_action', 'h.engagement_trend',
          'h.lifetime_value_estimate', 'h.upsell_opportunities'
        )
        .orderByRaw("CASE WHEN h.churn_risk = 'critical' THEN 0 WHEN h.churn_risk = 'at_risk' THEN 1 ELSE 2 END")
        .orderBy('h.lifetime_value_estimate', 'desc')
        .limit(limit);

      return {
        total: scores.length,
        customers: scores.map(s => ({
          id: s.id,
          name: `${s.first_name} ${s.last_name}`,
          tier: s.waveguard_tier,
          monthlyRate: parseFloat(s.monthly_rate || 0),
          city: s.city,
          healthScore: s.overall_score,
          riskLevel: s.churn_risk,
          churnProbability: s.churn_probability,
          riskFactors: typeof s.churn_signals === 'string' ? JSON.parse(s.churn_signals) : (s.churn_signals || []),
          nextAction: s.next_best_action,
          trend: s.engagement_trend,
          ltv: parseFloat(s.lifetime_value_estimate || 0),
          upsells: typeof s.upsell_opportunities === 'string' ? JSON.parse(s.upsell_opportunities) : (s.upsell_opportunities || []),
        })),
        revenueAtRisk: scores.reduce((s, c) => s + parseFloat(c.monthly_rate || 0), 0),
      };
    }

    case 'get_customer_health_detail': {
      const customerId = input.customer_id;

      const [customer, health, signals, smsHistory, lastService, billing, activeSequences, recentOutreach, upsells] = await Promise.all([
        db('customers').where('id', customerId).first(),
        db('customer_health_scores').where('customer_id', customerId).orderBy('scored_at', 'desc').first(),
        db('customer_signals').where({ customer_id: customerId, resolved: false }).orderBy('detected_at', 'desc').limit(20),
        db('sms_log').where('customer_id', customerId).orderBy('created_at', 'desc').limit(10),
        db('service_records').where({ customer_id: customerId, status: 'completed' }).orderBy('service_date', 'desc').first(),
        db('payments').where('customer_id', customerId).orderBy('payment_date', 'desc').limit(5),
        db('save_sequences').where({ customer_id: customerId, status: 'active' }),
        db('retention_outreach').where('customer_id', customerId).orderBy('created_at', 'desc').limit(5),
        db('upsell_opportunities').where({ customer_id: customerId, status: 'identified' }),
      ]);

      if (!customer) return { error: 'Customer not found' };

      const overdue = billing.filter(p => ['failed', 'overdue'].includes(p.status));

      return {
        customer: {
          name: `${customer.first_name} ${customer.last_name}`,
          tier: customer.waveguard_tier,
          monthlyRate: parseFloat(customer.monthly_rate || 0),
          city: customer.city,
          memberSince: customer.customer_since || customer.member_since,
          pipelineStage: customer.pipeline_stage,
        },
        health: health ? {
          score: health.overall_score,
          riskLevel: health.churn_risk,
          churnProbability: health.churn_probability,
          riskFactors: typeof health.churn_signals === 'string' ? JSON.parse(health.churn_signals) : (health.churn_signals || []),
          trend: health.engagement_trend,
          ltv: parseFloat(health.lifetime_value_estimate || 0),
          nextAction: health.next_best_action,
        } : null,
        activeSignals: signals.map(s => ({
          type: s.signal_type, severity: s.severity, value: s.signal_value, detected: s.detected_at,
        })),
        recentSMS: smsHistory.map(m => ({
          direction: m.direction, body: (m.message_body || '').substring(0, 200), date: m.created_at,
        })),
        lastService: lastService ? {
          type: lastService.service_type, date: lastService.service_date,
          notes: (lastService.technician_notes || '').substring(0, 300),
        } : null,
        billing: {
          outstandingBalance: overdue.reduce((s, p) => s + parseFloat(p.amount || 0), 0),
          recentPayments: billing.slice(0, 3).map(p => ({ date: p.payment_date, amount: parseFloat(p.amount), status: p.status })),
        },
        activeSequences: activeSequences.map(s => ({
          type: s.sequence_type, step: s.current_step, startedAt: s.created_at,
        })),
        recentOutreach: recentOutreach.map(o => ({
          type: o.outreach_type, strategy: o.outreach_strategy, status: o.status,
          sentAt: o.sent_at, outcome: o.outcome, date: o.created_at,
        })),
        upsellOpportunities: upsells.map(u => ({
          service: u.recommended_service, reason: u.reason,
          confidence: u.confidence, monthlyValue: parseFloat(u.estimated_monthly_value || 0),
        })),
        hasRecentOutreach: recentOutreach.some(o =>
          o.created_at && (Date.now() - new Date(o.created_at).getTime()) < 14 * 86400000
        ),
        hasActiveSequence: activeSequences.length > 0,
      };
    }

    case 'get_retention_metrics': {
      const RetentionEngine = require('./retention-engine');
      return RetentionEngine.getMetrics(input.days || 30);
    }

    // ── Outreach & Intervention ─────────────────────────────────

    case 'generate_retention_outreach': {
      const RetentionEngine = require('./retention-engine');
      const result = await RetentionEngine.generateRetentionOutreach(input.customer_id);
      return result || { skipped: true, reason: 'Customer not eligible (healthy or recently contacted)' };
    }

    case 'send_retention_sms': {
      const customer = await db('customers').where('id', input.customer_id).first();
      if (!customer?.phone) return { error: 'No phone number' };

      const smsResult = await sendCustomerMessage({
        to: customer.phone,
        body: input.message,
        channel: 'sms',
        audience: 'customer',
        purpose: 'retention',
        customerId: customer.id,
        identityTrustLevel: 'phone_matches_customer',
        entryPoint: 'retention_agent_tool',
        consentBasis: {
          status: 'opted_in',
          source: 'customer_retention_preferences',
          capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
        },
        metadata: {
          original_message_type: 'retention_outreach',
          outreach_id: input.outreach_id,
        },
      });
      if (!smsResult.sent) {
        logger.warn(`[retention-agent] SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        return { sent: false, blocked: true, reason: smsResult.code || smsResult.reason };
      }

      // Update outreach record if provided
      if (input.outreach_id) {
        await db('retention_outreach').where('id', input.outreach_id).update({
          status: 'sent', sent_at: new Date(),
        });
      }

      logger.info(`[retention-agent] SMS sent to ${customer.first_name} ${customer.last_name}`);
      return { sent: true, to: customer.phone, name: `${customer.first_name} ${customer.last_name}` };
    }

    case 'queue_call_for_adam': {
      const customer = await db('customers').where('id', input.customer_id).first();

      // Save to retention_outreach
      await db('retention_outreach').insert({
        customer_id: input.customer_id,
        outreach_type: 'call',
        outreach_strategy: 'personal_call',
        message_content: input.talking_points,
        status: 'pending_approval',
      });

      // Alert Adam
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          const urgencyLabel = input.urgency === 'today' ? '📞 CALL TODAY' : '📞 Call this week';
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `${urgencyLabel}\n${customer?.first_name} ${customer?.last_name} (${customer?.waveguard_tier} $${customer?.monthly_rate}/mo)\n📞 ${customer?.phone}\n\n${(input.talking_points || '').substring(0, 200)}`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }

      logger.info(`[retention-agent] Call queued for Adam: ${customer?.first_name} ${customer?.last_name}`);
      return { queued: true, urgency: input.urgency || 'this_week' };
    }

    case 'enroll_save_sequence': {
      const SaveSequences = require('../save-sequences');

      // Check for active sequence
      const active = await db('save_sequences')
        .where({ customer_id: input.customer_id, status: 'active' })
        .first();

      if (active) {
        return { enrolled: false, reason: `Already in active ${active.sequence_type} sequence (step ${active.current_step})` };
      }

      const result = await SaveSequences.enrollCustomer(input.customer_id, input.sequence_type);
      logger.info(`[retention-agent] Enrolled ${input.customer_id} in ${input.sequence_type} sequence`);
      return { enrolled: true, sequenceType: input.sequence_type, ...result };
    }

    // ── Upsell ──────────────────────────────────────────────────

    case 'identify_upsells': {
      const HealthScorer = require('./health-scorer');
      const customer = await db('customers').where('id', input.customer_id).first();
      if (!customer) return { error: 'Customer not found' };
      const opps = await HealthScorer.identifyUpsells(customer);
      return { opportunities: opps };
    }

    case 'create_upsell_pitch': {
      // Update existing opportunity or create new
      const existing = await db('upsell_opportunities')
        .where({ customer_id: input.customer_id, recommended_service: input.service })
        .whereIn('status', ['identified', 'pitched'])
        .first();

      if (existing) {
        await db('upsell_opportunities').where('id', existing.id).update({
          status: 'pitched', pitch_message: input.pitch_message, pitched_at: new Date(),
        });
      } else {
        await db('upsell_opportunities').insert({
          customer_id: input.customer_id,
          recommended_service: input.service,
          reason: 'Identified by retention agent',
          status: 'pitched',
          pitch_message: input.pitch_message,
          pitched_at: new Date(),
        });
      }

      return { saved: true, service: input.service };
    }

    // ── Report ──────────────────────────────────────────────────

    case 'save_retention_report': {
      const [report] = await db('retention_agent_reports').insert({
        summary: input.summary,
        customers_analyzed: input.customers_analyzed || 0,
        critical_count: input.critical_count || 0,
        at_risk_count: input.at_risk_count || 0,
        calls_scheduled: input.calls_scheduled || 0,
        sms_sent: input.sms_sent || 0,
        sequences_enrolled: input.sequences_enrolled || 0,
        upsells_identified: input.upsells_identified || 0,
        revenue_at_risk: input.revenue_at_risk || 0,
        estimated_revenue_saved: input.estimated_revenue_saved || 0,
        upsell_pipeline_value: input.upsell_pipeline_value || 0,
        top_priorities: input.top_priorities,
        action_items: input.action_items,
        created_at: new Date(),
      }).returning('*');

      logger.info(`[retention-agent] Report saved: ${report.id}`);
      return { report_id: report.id, saved: true };
    }

    default:
      return { error: `Unknown retention tool: ${toolName}` };
  }
}

module.exports = { executeRetentionTool };
