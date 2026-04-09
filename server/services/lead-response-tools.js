/**
 * Lead Response Agent — Tool Executor
 * Maps each tool call to existing lead/customer services.
 */

const db = require('../models/db');
const logger = require('./logger');

async function executeLeadTool(toolName, input) {
  switch (toolName) {

    // ── Lead data ───────────────────────────────────────────────

    case 'get_lead_details': {
      let lead;
      if (input.lead_id) {
        lead = await db('leads').where('id', input.lead_id).first();
      } else if (input.phone) {
        const clean = (input.phone || '').replace(/\D/g, '');
        lead = await db('leads').where(function () {
          this.where('phone', clean).orWhere('phone', `+1${clean}`).orWhere('phone', `+${clean}`);
        }).orderBy('first_contact_at', 'desc').first();
      }

      if (!lead) return { found: false };

      // Pull AI triage if available
      const triageActivity = await db('lead_activities')
        .where({ lead_id: lead.id, activity_type: 'ai_triage' })
        .orderBy('created_at', 'desc')
        .first();

      let triageData = null;
      if (triageActivity?.metadata) {
        triageData = typeof triageActivity.metadata === 'string'
          ? JSON.parse(triageActivity.metadata) : triageActivity.metadata;
      }

      return {
        found: true,
        id: lead.id,
        name: `${lead.first_name} ${lead.last_name}`,
        firstName: lead.first_name,
        phone: lead.phone,
        email: lead.email,
        address: lead.address,
        city: lead.city,
        serviceInterest: lead.service_interest,
        urgency: lead.urgency,
        leadType: lead.lead_type,
        status: lead.status,
        leadSource: lead.lead_source_detail || lead.lead_type,
        customerId: lead.customer_id,
        firstContactAt: lead.first_contact_at,
        responseTimeMin: lead.response_time_minutes,
        extractedData: lead.extracted_data ? (typeof lead.extracted_data === 'string' ? JSON.parse(lead.extracted_data) : lead.extracted_data) : null,
        triage: triageData,
        gclid: lead.gclid,
      };
    }

    case 'triage_lead': {
      const { aiTriageLead } = require('../lead-triage');
      const result = await aiTriageLead({
        name: input.name,
        phone: input.phone,
        message: input.message,
        address: input.address,
        pageUrl: input.page_url,
        formName: input.form_name,
      });

      return result || { error: 'Triage returned no results' };
    }

    case 'score_lead': {
      const LeadScorer = require('../lead-scorer');
      const score = await LeadScorer.calculateScore(input.customer_id);
      return { customerId: input.customer_id, score };
    }

    // ── Customer context ────────────────────────────────────────

    case 'get_customer_context': {
      const ContextAggregator = require('../context-aggregator');
      const phone = input.phone || null;
      const customerId = input.customer_id || null;

      if (phone) {
        const ctx = await ContextAggregator.getFullCustomerContext(phone);
        return ctx;
      }

      if (customerId) {
        const customer = await db('customers').where('id', customerId).first();
        if (customer?.phone) {
          return ContextAggregator.getFullCustomerContext(customer.phone);
        }
      }

      return { known: false };
    }

    case 'check_existing_estimates': {
      const customerId = input.customer_id;
      const phone = input.phone;

      let estimates;
      if (customerId) {
        estimates = await db('estimates')
          .where({ customer_id: customerId })
          .orderBy('created_at', 'desc')
          .limit(5);
      } else if (phone) {
        const clean = (phone || '').replace(/\D/g, '');
        estimates = await db('estimates')
          .where(function () {
            this.where('customer_phone', clean)
              .orWhere('customer_phone', `+1${clean}`)
              .orWhere('customer_phone', `+${clean}`);
          })
          .orderBy('created_at', 'desc')
          .limit(5);
      }

      if (!estimates?.length) return { hasEstimates: false, estimates: [] };

      return {
        hasEstimates: true,
        estimates: estimates.map(e => ({
          id: e.id,
          status: e.status,
          total: e.monthly_total || e.total_amount,
          serviceInterest: e.service_interest,
          sentAt: e.sent_at,
          viewedAt: e.viewed_at,
          token: e.token,
          viewUrl: e.token ? `https://portal.wavespestcontrol.com/estimate/${e.token}` : null,
        })),
      };
    }

    // ── Availability & pest context ─────────────────────────────

    case 'check_next_availability': {
      const Availability = require('../availability');
      const result = await Availability.getAvailableSlots(input.city);

      // Return just the first 3 days with slots
      const days = (result.days || []).slice(0, 3).map(d => ({
        date: d.date,
        dayOfWeek: d.dayOfWeek,
        firstSlot: d.slots?.[0]?.display || d.slots?.[0]?.start,
        slotCount: d.slots?.length || 0,
      }));

      return {
        city: input.city,
        nextAvailable: days[0] || null,
        options: days,
      };
    }

    case 'get_pest_context': {
      const month = new Date().getMonth() + 1;

      // Pest pressure
      const pressure = await db('seasonal_pest_index')
        .where({ month })
        .where(function () {
          const topic = (input.topic || '').toLowerCase();
          this.whereRaw('LOWER(pest_name) LIKE ?', [`%${topic}%`])
            .orWhereRaw('LOWER(service_line) LIKE ?', [`%${topic}%`]);
        })
        .limit(5);

      // Knowledge base
      let kbAnswer = null;
      try {
        const WikiQA = require('../knowledge/wiki-qa');
        const kb = await WikiQA.query(input.topic, { source: 'lead_agent' });
        kbAnswer = kb.answer;
      } catch { /* KB unavailable */ }

      return {
        pestPressure: pressure.map(p => ({
          pest: p.pest_name,
          level: p.pressure_level,
          description: p.description,
        })),
        knowledgeBase: kbAnswer ? kbAnswer.substring(0, 500) : null,
        month,
      };
    }

    // ── Response actions ────────────────────────────────────────

    case 'send_lead_response': {
      const customer = await db('customers').where('id', input.customer_id).first();
      if (!customer?.phone) return { error: 'Customer has no phone number' };

      const TwilioService = require('../twilio');
      await TwilioService.sendSMS(customer.phone, input.message, {
        customerId: customer.id,
        messageType: 'lead_response',
      });

      // Record response time
      if (input.lead_id) {
        const lead = await db('leads').where('id', input.lead_id).first();
        if (lead?.first_contact_at) {
          const responseMinutes = Math.round((Date.now() - new Date(lead.first_contact_at).getTime()) / 60000);
          await db('leads').where('id', input.lead_id).update({
            response_time_minutes: responseMinutes,
            status: 'contacted',
            updated_at: new Date(),
          });
        }
      }

      // Log activity
      if (input.lead_id) {
        await db('lead_activities').insert({
          lead_id: input.lead_id,
          activity_type: 'sms_sent',
          description: 'Auto-response sent by lead agent',
          performed_by: 'lead_agent',
          metadata: JSON.stringify({ message: input.message }),
        }).catch(() => {});
      }

      // Update pipeline
      const PipelineManager = require('../pipeline-manager');
      await PipelineManager.onEvent(input.customer_id, 'first_contact');

      logger.info(`[lead-agent] Auto-sent response to ${customer.first_name} ${customer.last_name}`);
      return { sent: true, to: customer.phone, name: customer.first_name };
    }

    case 'queue_for_adam': {
      const customer = await db('customers').where('id', input.customer_id).first();

      // Save draft
      if (input.lead_id) {
        await db('lead_activities').insert({
          lead_id: input.lead_id,
          activity_type: 'draft_queued',
          description: `Queued for Adam: ${input.reason}`,
          performed_by: 'lead_agent',
          metadata: JSON.stringify({
            draftResponse: input.draft_response,
            reason: input.reason,
            urgency: input.urgency,
          }),
        }).catch(() => {});
      }

      // SMS Adam with the lead details + suggested reply
      try {
        const TwilioService = require('../twilio');
        const slaLabel = { urgent: '15 min', normal: '1 hour', low: '4 hours' }[input.urgency || 'normal'];
        const adamMsg = `📋 Lead needs your reply (${slaLabel} SLA):\n` +
          `${customer ? customer.first_name + ' ' + customer.last_name : 'Unknown'}\n` +
          `📞 ${customer?.phone || 'N/A'}\n` +
          `Reason: ${input.reason}\n\n` +
          `Suggested reply:\n"${(input.draft_response || '').substring(0, 200)}"`;

        if (process.env.ADAM_PHONE) {
          await TwilioService.sendSMS(process.env.ADAM_PHONE, adamMsg, { messageType: 'internal_alert' });
        }
      } catch { /* best effort */ }

      logger.info(`[lead-agent] Queued for Adam: ${input.reason}`);
      return { queued: true, reason: input.reason, urgency: input.urgency || 'normal' };
    }

    // ── Pipeline & follow-up ────────────────────────────────────

    case 'update_lead_pipeline': {
      const PipelineManager = require('../pipeline-manager');

      // Map stage names to pipeline events
      const eventMap = {
        contacted: 'first_contact',
        estimate_sent: 'estimate_sent',
        follow_up: 'estimate_followup_sent',
        won: 'estimate_accepted',
        lost: 'estimate_declined',
      };

      const event = eventMap[input.stage] || input.stage;
      await PipelineManager.onEvent(input.customer_id, event);

      if (input.lead_id && input.note) {
        await db('lead_activities').insert({
          lead_id: input.lead_id,
          activity_type: 'pipeline_update',
          description: input.note,
          performed_by: 'lead_agent',
        }).catch(() => {});
      }

      return { updated: true, stage: input.stage };
    }

    case 'flag_for_estimate': {
      // Check if estimate already exists
      const existing = await db('estimates')
        .where({ customer_id: input.customer_id })
        .whereIn('status', ['draft', 'sent', 'viewed'])
        .first();

      if (existing) {
        return { flagged: false, reason: 'Estimate already exists', estimateId: existing.id, status: existing.status };
      }

      const customer = await db('customers').where('id', input.customer_id).first();
      const crypto = require('crypto');

      const [estimate] = await db('estimates').insert({
        customer_id: input.customer_id,
        customer_name: customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown',
        customer_phone: customer?.phone,
        customer_email: customer?.email,
        address: input.address || customer?.address_line1 || '',
        status: 'draft',
        source: 'lead_agent',
        service_interest: input.service_interest,
        notes: `${input.urgency ? `Urgency: ${input.urgency}. ` : ''}${input.notes || ''}`,
        token: crypto.randomBytes(16).toString('hex'),
      }).returning('*');

      logger.info(`[lead-agent] Flagged for estimate: ${input.service_interest} for ${customer?.first_name}`);
      return { flagged: true, estimateId: estimate.id };
    }

    case 'save_lead_response_report': {
      try {
        await db('lead_agent_responses').insert({
          lead_id: input.lead_id,
          customer_id: input.customer_id,
          action_taken: input.action_taken,
          response_message: input.response_message,
          response_time_seconds: input.response_time_seconds,
          triage_summary: input.triage_summary,
          follow_up_scheduled: input.follow_up_scheduled || false,
          created_at: new Date(),
        });
      } catch (err) {
        // Table may not exist
        logger.debug(`[lead-agent] Report save failed (table may not exist): ${err.message}`);
      }

      return { saved: true };
    }

    default:
      return { error: `Unknown lead tool: ${toolName}` };
  }
}

module.exports = { executeLeadTool };
