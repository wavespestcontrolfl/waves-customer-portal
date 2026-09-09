/**
 * Lead Response Agent — Tool Executor
 * Maps each tool call to existing lead/customer services.
 */

const db = require('../models/db');
const { randomUUID } = require('node:crypto');
const logger = require('./logger');
const { shortenOrPassthrough } = require('./short-url');
const { gatedSendAuthorityPredicateApplies, estimateDeliverableUnderGate } = require('./pricing-authority-gate');
const {
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
} = require('./estimate-automation-duplicates');

const { phoneMatchDigits } = require('../utils/phone');
const { lockCustomerComms } = require('../utils/customer-comms-lock');

// Authority comes from the server's assigned session, never model arguments.
async function resolveLeadSubject(input, context, conn = db, lock = false) {
  if (!context?.leadId || !context?.customerId) return { error: 'Missing assigned lead context', validationError: true };
  if ((input.lead_id && input.lead_id !== context.leadId) ||
      (input.customer_id && input.customer_id !== context.customerId)) {
    return { error: 'Tool target does not match assigned lead', validationError: true };
  }
  // Booking and estimate acceptance hold this advisory key before rows.
  // Join their fence before either row lock, including legacy lead-first writers.
  if (lock) await lockCustomerComms(conn, context.customerId);
  // Customer 360 locks the customer before its lead fanout. Use the same
  // order so database mutations remain live and bound to that customer.
  const customerQuery = conn('customers').where('id', context.customerId).whereNull('deleted_at');
  if (lock) customerQuery.forNoKeyUpdate();
  const customer = await customerQuery.first();
  if (!customer) return { error: 'Assigned customer is unavailable', validationError: true };
  const query = conn('leads').where({ id: context.leadId, customer_id: context.customerId }).whereNull('deleted_at');
  if (lock) query.forUpdate();
  const lead = await query.first();
  if (!lead) return { error: 'Assigned lead is unavailable', validationError: true };
  if (input.phone != null) {
    const variants = phoneMatchDigits(input.phone);
    const matches = [lead.phone, customer.phone].some(phone => phoneMatchDigits(phone).some(value => variants.includes(value)));
    if (!matches) return { error: 'Tool phone does not match assigned lead', validationError: true };
  }
  return { lead, customer };
}

async function withLockedLeadSubject(input, context, write) {
  return db.transaction(async trx => {
    const current = await resolveLeadSubject(input, context, trx, true);
    return current.error ? current : write(current, trx);
  });
}

async function executeLeadTool(toolName, input, context) {
  const subject = await resolveLeadSubject(input, context);
  if (subject.error) return subject;
  input = { ...input, lead_id: context.leadId, customer_id: context.customerId };
  switch (toolName) {

    // ── Lead data ───────────────────────────────────────────────

    case 'get_lead_details': {
      const { lead } = subject;

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
      return ContextAggregator.getContextForCustomer(subject.customer);
    }

    case 'check_existing_estimates': {
      const customerId = input.customer_id;

      // Only rows the customer can actually OPEN are listed (uncapped codex
      // P1 r33 on #3750): an expired, send-failed, never-published, or
      // linkage-invalidated row is refused by the public page, so its price,
      // bearer token, and URL never reach the agent — it would quote a dead
      // offer or send a dead link. Viewability is a predicate the query can't
      // express, so the candidates are PAGED until five viewable rows are in
      // hand or the candidates run out (a filter applied after a limit lets
      // newer hidden rows mask an older estimate the customer still holds —
      // the composer-customer-links.js pattern). Hidden rows are counted so
      // the agent can offer a fresh quote without quoting the old one.
      const { isEstimateCustomerViewable } = require('../routes/estimate-public');
      const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
      // The public data route's verdict is viewability AND the durable
      // call-side block (uncapped codex P1 r34): an engine draft whose call
      // is missing, reprocessing, quarantined, or repointed is refused by the
      // page even when the row itself looks open. Any failure to read that
      // verdict hides the row (fail closed).
      const customerCanOpen = async (row) => {
        if (!isEstimateCustomerViewable(row)) return false;
        try {
          const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
          return !(await callSideBlockForEstimateData(db, data));
        } catch (err) {
          logger.warn('[lead-tools] check_existing_estimates: call-side verdict unavailable, row hidden', { estimateId: row.id, error: err.message });
          return false;
        }
      };
      const LIMIT = 5;
      const PAGE = 15;
      const viewable = [];
      let hiddenCount = 0;
      for (let offset = 0; ; offset += PAGE) {
        const rows = await db('estimates').where({ customer_id: customerId })
          .orderBy('created_at', 'desc').offset(offset).limit(PAGE);
        for (const row of rows) {
          // Rows past the cap are neither evaluated nor counted (uncapped
          // codex P1 r36): the hidden count reports only rows the
          // customer cannot open, never valid estimates beyond the limit.
          if (viewable.length >= LIMIT) break;
          if (await customerCanOpen(row)) viewable.push(row);
          else hiddenCount += 1;
        }
        if (viewable.length >= LIMIT || rows.length < PAGE) break;
      }

      if (!viewable.length) {
        return { hasEstimates: false, estimates: [], ...(hiddenCount ? { unviewableEstimates: hiddenCount } : {}) };
      }

      // The agent may quote these URLs to the customer, so a link (and the
      // bearer token behind it) is handed out ONLY for a viewable row that
      // passes the group-aware pricing-authority verdict while the gate is on
      // (#3750, uncapped codex P0 r24) — the same rule every guarded send
      // funnel applies. Withheld rows still list, with the reason.
      return {
        hasEstimates: true,
        ...(hiddenCount ? { unviewableEstimates: hiddenCount } : {}),
        estimates: await Promise.all(viewable.map(async (e) => {
          const authorityOk = !gatedSendAuthorityPredicateApplies() || await estimateDeliverableUnderGate(db, e);
          const linkable = authorityOk && !!e.token;
          // A row the verdict refuses shows NO price either (uncapped codex P0
          // r25): the agent quotes what it is given, and an unverified
          // dollar figure must never reach a customer by any rail.
          return {
            id: e.id,
            status: e.status,
            ...(authorityOk ? { total: e.monthly_total || e.total_amount } : { totalWithheld: 'pricing-authority-not-server' }),
            serviceInterest: e.service_interest,
            sentAt: e.sent_at,
            viewedAt: e.viewed_at,
            token: linkable ? e.token : null,
            viewUrl: linkable
              ? await shortenOrPassthrough(
                  `https://portal.wavespestcontrol.com/estimate/${e.token}`,
                  { kind: 'estimate', entityType: 'estimates', entityId: e.id, customerId: e.customer_id || null }
                )
              : null,
            ...(linkable ? {} : { viewUrlWithheld: !e.token ? 'no-token' : 'pricing-authority-not-server' }),
          };
        })),
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
      // A lead an admin removed from the pipeline must never be contacted:
      // the agent's prompt can carry a lead id captured before the delete,
      // so re-check liveness at send time — refuse instead of texting.
      if (input.lead_id) {
        const liveLead = await db('leads').where('id', input.lead_id).whereNull('deleted_at').first('id');
        if (!liveLead) return { error: 'Lead was removed from the pipeline — do not contact' };
      }
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

      // No quiet-hours requeue: lead_response_auto_reply is a
      // customer-action entry point (owner ruling 2026-08-29) — the agent
      // is replying to the lead's own fresh estimate request, so the reply
      // sends immediately, at any hour, and QUIET_HOURS_HOLD cannot
      // surface here.

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

        // Pipeline + response-time only advance on real send — and only on
        // a still-live lead (a mid-flight delete must not be overwritten).
        if (result.sent) {
          const lead = await db('leads').where('id', input.lead_id).whereNull('deleted_at').first();
          if (lead?.first_contact_at) {
            const responseMinutes = Math.round((Date.now() - new Date(lead.first_contact_at).getTime()) / 60000);
            await db('leads').where('id', input.lead_id).whereNull('deleted_at').update({
              response_time_minutes: responseMinutes,
              status: 'contacted',
              updated_at: new Date(),
            });
            // Funnel-row mirror (monotonic in SQL — can never downgrade a row
            // that already advanced past 'contacted'; best-effort inside).
            const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');
            await bridgeLeadFunnelStage(input.lead_id, 'contacted');
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
      if (!context.sessionId || !context.toolUseId) return { error: 'Missing queue invocation identity', validationError: true };
      const queued = await db.transaction(async trx => {
        const current = await resolveLeadSubject(input, context, trx, true);
        if (current.error) return current;
        const existing = await trx('lead_activities')
          .where({ lead_id: context.leadId, activity_type: 'draft_queued' })
          .whereRaw("metadata->>'sessionId' = ? AND metadata->>'toolUseId' = ?", [context.sessionId, context.toolUseId])
          .first();
        const metadata = existing
          ? (typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : existing.metadata)
          : { draftResponse: input.draft_response, reason: input.reason, urgency: input.urgency,
            sessionId: context.sessionId, toolUseId: context.toolUseId };
        if (existing && ['notified', 'sent', 'suppressed'].includes(metadata.alertStatus)) {
          return { id: existing.id, replayed: true, alertStatus: metadata.alertStatus };
        }
        if (existing && new Date(metadata.alertLeaseUntil).getTime() > Date.now()) {
          return { id: existing.id, replayed: true, alertStatus: 'pending', nextAllowedAt: metadata.alertLeaseUntil };
        }
        const [activity] = existing ? [existing] : await trx('lead_activities').insert({
          lead_id: context.leadId,
          activity_type: 'draft_queued',
          description: `Queued for Adam: ${input.reason}`,
          performed_by: 'lead_agent',
          metadata: JSON.stringify(metadata),
        }).returning('id');
        // Extend this draft's replay state with a bounded alert claim. No
        // database connection stays pinned while the notification sends.
        const alertClaimToken = randomUUID();
        await trx('lead_activities').where({ id: activity.id }).update({ metadata: JSON.stringify({
          ...metadata, alertClaimToken, alertLeaseUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }) });
        return { id: activity.id, customer: current.customer, metadata, alertClaimToken, replayed: !!existing };
      });
      if (queued.error) return queued;
      if (!queued.alertClaimToken) return { queued: true, activityId: queued.id, replayed: true, alertStatus: queued.alertStatus,
        ...(queued.alertStatus === 'pending' ? { retryable: true, nextAllowedAt: queued.nextAllowedAt } : {}) };
      const customer = queued.customer;
      let alertStatus = 'not_configured';

      // SMS Adam with the lead details + suggested reply
      try {
        const TwilioService = require('./twilio');
        const slaLabel = { urgent: '15 min', normal: '1 hour', low: '4 hours' }[queued.metadata.urgency || 'normal'];
        const adamMsg = `📋 Lead needs your reply (${slaLabel} SLA):\n` +
          `${customer ? customer.first_name + ' ' + customer.last_name : 'Unknown'}\n` +
          `📞 ${customer?.phone || 'N/A'}\n` +
          `Reason: ${queued.metadata.reason}\n\n` +
          `Suggested reply:\n"${(queued.metadata.draftResponse || '').substring(0, 200)}"`;

        if (process.env.ADAM_PHONE) {
          const alert = await TwilioService.sendSMS(process.env.ADAM_PHONE, adamMsg, { messageType: 'internal_alert' });
          if (!alert?.success || alert.notificationUndelivered || alert.notificationError) alertStatus = 'failed';
          else if (alert.notificationRedirected || alert.pushRouted) alertStatus = 'notified';
          else if (alert.suppressed || alert.gateBlocked) alertStatus = 'suppressed';
          else alertStatus = alert.sid ? 'sent' : 'failed';
        }
      } catch { alertStatus = 'failed'; }

      await db('lead_activities').where({ id: queued.id })
        .whereRaw("metadata->>'alertClaimToken' = ?", [queued.alertClaimToken])
        .update({ metadata: db.raw("(COALESCE(metadata, '{}'::jsonb) - 'alertClaimToken' - 'alertLeaseUntil') || jsonb_build_object('alertStatus', ?::text)", [alertStatus]) });

      logger.info('[lead-agent] Draft queued', { leadId: context.leadId, activityId: queued.id, alertStatus });
      return { queued: true, activityId: queued.id, alertStatus, replayed: queued.replayed,
        reason: queued.metadata.reason, urgency: queued.metadata.urgency || 'normal',
        ...(['failed', 'not_configured'].includes(alertStatus) ? { failed: true, retryable: true, error: 'Draft saved; owner alert delivery failed' } : {}) };
    }

    // ── Pipeline & follow-up ────────────────────────────────────

    case 'update_lead_pipeline': {
      const PipelineManager = require('./pipeline-manager');

      // Map stage names to pipeline events
      const eventMap = {
        estimate_viewed: 'estimate_viewed',
        contacted: 'first_contact',
        estimate_sent: 'estimate_sent',
        follow_up: 'estimate_followup_sent',
        won: 'estimate_accepted',
        lost: 'estimate_declined',
      };

      const event = Object.hasOwn(eventMap, input.stage) ? eventMap[input.stage] : null;
      if (!event) return { error: 'Unsupported lead pipeline stage', validationError: true };
      return withLockedLeadSubject(input, context, async (_current, trx) => {
        await PipelineManager.onEvent(context.customerId, event, {}, { database: trx });

        if (input.note) {
          await trx('lead_activities').insert({
            lead_id: input.lead_id,
            activity_type: 'pipeline_update',
            description: input.note,
            performed_by: 'lead_agent',
          });
        }
        return { updated: true, stage: input.stage };
      });
    }

    case 'flag_for_estimate': {
      // Check if estimate already exists. Archived rows keep sent/viewed
      // status but are closed courtships — they must not block a new one.
      const existing = await db('estimates')
        .where({ customer_id: input.customer_id })
        .whereIn('status', ['draft', 'sent', 'viewed'])
        .whereNull('archived_at')
        .first();

      if (existing) {
        return { flagged: false, reason: 'Estimate already exists', estimateId: existing.id, status: existing.status };
      }

      const customer = await db('customers').where('id', input.customer_id).first();
      const crypto = require('crypto');

      const result = await db.transaction(database => withAutomatedEstimatePhoneLock(customer?.phone, async (trx) => {
        const current = await resolveLeadSubject(input, context, trx, true);
        if (current.error) return current;
        if (current.customer.phone !== customer?.phone) return { error: 'Assigned contact changed before estimate creation', validationError: true };
        const duplicateBlock = await blockIfAutomatedEstimateDuplicate(customer?.phone, { database: trx });
        if (duplicateBlock) {
          logger.info(`[lead-agent] Estimate flag blocked by duplicate estimate ${duplicateBlock.existingEstimateId} for customer ${input.customer_id}`);
          return {
            blocked: true,
            reason: duplicateBlock.reason,
            message: duplicateBlock.message,
            estimateId: duplicateBlock.existingEstimateId,
            status: duplicateBlock.existingStatus,
            source: duplicateBlock.existingSource,
          };
        }

        const [estimate] = await trx('estimates').insert({
          customer_id: input.customer_id,
          customer_name: `${current.customer.first_name} ${current.customer.last_name}`,
          customer_phone: current.customer.phone,
          customer_email: current.customer.email,
          address: input.address || current.customer.address_line1 || '',
          status: 'draft',
          source: 'lead_agent',
          service_interest: input.service_interest,
          notes: `${input.urgency ? `Urgency: ${input.urgency}. ` : ''}${input.notes || ''}`,
          token: crypto.randomBytes(16).toString('hex'),
        }).returning('*');

        return { estimate };
      }, { database }));

      if (result.error) return result;
      if (result.blocked) {
        return { flagged: false, ...result };
      }

      logger.info(`[lead-agent] Flagged for estimate: ${input.service_interest} for customer ${input.customer_id}`);
      return { flagged: true, estimateId: result.estimate.id };
    }

    case 'save_lead_response_report': {
      try {
        const result = await withLockedLeadSubject(input, context, async (_current, trx) => {
          await trx('lead_agent_responses').insert({
            lead_id: input.lead_id,
            customer_id: input.customer_id,
            action_taken: input.action_taken,
            response_message: input.response_message,
            response_time_seconds: input.response_time_seconds,
            triage_summary: input.triage_summary,
            follow_up_scheduled: input.follow_up_scheduled || false,
            created_at: new Date(),
          });
          return { saved: true };
        });
        return result.error ? { saved: false, ...result } : result;
      } catch {
        logger.warn('[lead-agent] Report save failed', { leadId: context.leadId });
        return { saved: false, error: 'Lead response report could not be saved' };
      }
    }

    default:
      return { error: `Unknown lead tool: ${toolName}` };
  }
}

// Delivery-time bookkeeping for a quiet-hours-deferred auto-reply, invoked
// by the deferred-replay registry after the scheduled executor's provider
// accept — the same lifecycle stamps the immediate sent path runs inline:
// activity log, contacted status + response-time metric, funnel bridge,
// pipeline first_contact. Guarded on a still-live lead throughout.
async function recordLeadAutoReplyDelivered({ leadId = null, customerId = null } = {}) {
  if (leadId) {
    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: 'sms_sent',
      description: 'Auto-response sent by lead agent (deferred replay)',
      performed_by: 'lead_agent',
      metadata: JSON.stringify({ deferred_replay: true }),
    }).catch(() => {});
    const lead = await db('leads').where('id', leadId).whereNull('deleted_at').first();
    if (lead?.first_contact_at) {
      // MONOTONIC: the replay lands hours after enqueue, and the lead may
      // have advanced overnight (estimated/booked/won via other channels) —
      // 'contacted' must only ever move a lead FORWARD from a pre-contact
      // state, never overwrite an advanced one. The funnel bridge is
      // already monotonic in SQL, so it runs regardless.
      const responseMinutes = Math.round((Date.now() - new Date(lead.first_contact_at).getTime()) / 60000);
      await db('leads')
        .where('id', leadId)
        .whereNull('deleted_at')
        // Pre-contact states ONLY — an existing 'contacted' stamp belongs
        // to whoever contacted first (their response_time must not be
        // overwritten by a replay landing seconds later).
        .where((q) => q.whereIn('status', ['new', 'pending', 'started']).orWhereNull('status'))
        .update({
          response_time_minutes: responseMinutes,
          status: 'contacted',
          updated_at: new Date(),
        });
      const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');
      await bridgeLeadFunnelStage(leadId, 'contacted');
    }
  }
  if (customerId) {
    const PipelineManager = require('./pipeline-manager');
    await PipelineManager.onEvent(customerId, 'first_contact');
  }
}

module.exports = { executeLeadTool, recordLeadAutoReplyDelivered };
