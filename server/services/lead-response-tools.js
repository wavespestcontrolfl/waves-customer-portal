/**
 * Lead Response Agent — Tool Executor
 * Maps each tool call to existing lead/customer services.
 */

const db = require('../models/db');
const logger = require('./logger');
const { shortenOrPassthrough } = require('./short-url');

async function executeLeadTool(toolName, input) {
  switch (toolName) {

    // ── Lead data ───────────────────────────────────────────────

    case 'get_lead_details': {
      let lead;
      if (input.lead_id) {
        lead = await db('leads').where('id', input.lead_id).first();
      } else if (input.phone) {
        const clean = (input.phone || '').replace(/\D/g, '');
        if (!clean || clean.length < 10) return { found: false };
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
      const { aiTriageLead } = require('./lead-triage');
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
      const LeadScorer = require('./lead-scorer');
      const score = await LeadScorer.calculateScore(input.customer_id);
      return { customerId: input.customer_id, score };
    }

    // ── Customer context ────────────────────────────────────────

    case 'get_customer_context': {
      const ContextAggregator = require('./context-aggregator');
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
        estimates: await Promise.all(estimates.map(async e => ({
          id: e.id,
          status: e.status,
          total: e.monthly_total || e.total_amount,
          serviceInterest: e.service_interest,
          sentAt: e.sent_at,
          viewedAt: e.viewed_at,
          token: e.token,
          viewUrl: e.token
            ? await shortenOrPassthrough(
                `https://portal.wavespestcontrol.com/estimate/${e.token}`,
                { kind: 'estimate', entityType: 'estimates', entityId: e.id, customerId: e.customer_id || null }
              )
            : null,
        }))),
      };
    }

    // ── Availability & pest context ─────────────────────────────

    case 'check_next_availability': {
      const Availability = require('./availability');
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
        const WikiQA = require('./knowledge/wiki-qa');
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

      // Routed through the customer-message middleware so consent /
      // suppression / identity / voice / segment checks all apply, and
      // every attempt lands in messaging_audit_log. Behavior change to
      // be aware of: a lead whose notification_prefs.sms_enabled is
      // false (e.g. they previously sent STOP) WILL NOT receive the
      // auto-reply — the wrapper blocks the send and the agent's
      // tool-use loop sees the block. Pipeline updates + activity log
      // entries still record so the lead doesn't disappear; we just
      // don't auto-text someone who opted out.
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: customer.phone,
        body: input.message,
        channel: 'sms',
        audience: 'lead',
        purpose: 'conversational',
        customerId: customer.id,
        leadId: input.lead_id || null,
        entryPoint: 'lead_response_auto_reply',
        // Preserve the legacy messageType so the admin-sms-templates
        // kill-switch (lead_response → lead_auto_reply_biz toggle) still
        // applies when ops disables this template during an incident.
        metadata: { original_message_type: 'lead_response' },
      });

      // Activity log captures EVERY attempt (sent / blocked / failed) for
      // operator triage. But the lead-status / pipeline transition only
      // advances on an actual successful send — a wrapper-policy block
      // (opt-out) or provider failure should NOT mark the lead "contacted"
      // or fire the first_contact pipeline event, otherwise the response-
      // time SLA metric and the funnel both record a phantom contact.
      // Codex P1 follow-up to #538.
      if (input.lead_id) {
        // Distinguish wrapper-policy blocks from provider failures so
        // incident triage doesn't see "blocked by middleware" when
        // Twilio actually had a network error. activity_type:
        //   sms_sent     → provider accepted the send
        //   sms_blocked  → wrapper policy refused (opt-out, emoji, etc.)
        //   sms_failed   → provider failure (Twilio threw, gateway timeout)
        const activityType = result.sent
          ? 'sms_sent'
          : (result.blocked ? 'sms_blocked' : 'sms_failed');
        // Description is operator-facing — keep it stable code-only, no
        // result.reason (upstream provider error strings can include
        // recipient phone or message body). audit_log_id in metadata is
        // the cross-reference for full failure context.
        const activityDescription = result.sent
          ? 'Auto-response sent by lead agent'
          : (result.blocked
              ? `Auto-response blocked by middleware (${result.code || 'unknown'})`
              : `Auto-response provider failure (${result.code || 'unknown'})`);
        await db('lead_activities').insert({
          lead_id: input.lead_id,
          activity_type: activityType,
          description: activityDescription,
          performed_by: 'lead_agent',
          metadata: JSON.stringify({ audit_log_id: result.auditLogId }),
        }).catch(() => {});

        // Pipeline + response-time only advance on real send.
        if (result.sent) {
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
      }

      if (result.sent) {
        const PipelineManager = require('./pipeline-manager');
        await PipelineManager.onEvent(input.customer_id, 'first_contact');
      }

      if (result.sent) {
        // PII: ID-only logging per AGENTS.md. Customer name + phone live
        // in the customer record + audit log; the log line just needs an
        // ID for cross-reference.
        logger.info(`[lead-agent] Auto-sent response (customerId=${customer.id} leadId=${input.lead_id || 'n/a'} auditLogId=${result.auditLogId || 'n/a'})`);
        return {
          sent: true,
          to: customer.phone,
          name: customer.first_name,
          providerMessageId: result.providerMessageId,
          segmentCount: result.segmentCount,
          encoding: result.encoding,
        };
      }
      // PII: ID + code only; result.reason can include recipient phone
      // or body if upstream provider/guard error strings propagate.
      // Full context lives on messaging_audit_log keyed on auditLogId.
      logger.warn(`[lead-agent] Auto-response BLOCKED (customerId=${customer.id} leadId=${input.lead_id || 'n/a'} auditLogId=${result.auditLogId || 'n/a'} code=${result.code})`);
      // Two distinct unsent outcomes — must be signaled differently so the
      // lead-response-agent's circuit breaker doesn't treat consent/opt-out
      // blocks as system failures (5 in 60s would trip the breaker and
      // fast-fail every lead tool for 30s).
      //
      //   POLICY BLOCK (consent, suppression, emoji, price-leak, identity,
      //   segment cap):  expected outcome. Return { sent: false, blocked:
      //   true } WITHOUT `failed`/`error`. The agent's auto_sent telemetry
      //   gates on `result.sent === true` (paired change in
      //   lead-response-agent.js) so a non-sent block isn't tagged as
      //   auto_sent — but the breaker is NOT bumped.
      //
      //   PROVIDER FAILURE (Twilio/network error): real failure. Return
      //   `failed: true` + `error` so isToolFailure() catches it AND the
      //   breaker bumps.
      if (result.blocked) {
        return {
          sent: false,
          blocked: true,
          code: result.code,
          reason: result.reason,
          name: customer.first_name,
        };
      }
      return {
        sent: false,
        failed: true,
        error: result.reason || result.code || 'provider failure',
        blocked: false,
        code: result.code,
        reason: result.reason,
        name: customer.first_name,
      };
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
        const TwilioService = require('./twilio');
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
      const PipelineManager = require('./pipeline-manager');

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
