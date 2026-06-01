#!/usr/bin/env node
/**
 * Backfill legacy call route_decisions in shadow mode.
 *
 * This seeds the calibration dataset for calls processed before
 * server/services/call-route-decisions.js was wired into the processor.
 *
 * Usage:
 *   node server/scripts/backfill-call-route-decisions.js --dry-run
 *   node server/scripts/backfill-call-route-decisions.js --limit=500
 */

const db = require('../models/db');
const { writeLegacyShadowRouteDecision } = require('../services/call-route-decisions');
const CallRecordingProcessor = require('../services/call-recording-processor');

const { resolveSchedulableCallService } = CallRecordingProcessor._test;

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  })
);

const LIMIT = Math.max(1, Math.min(5000, Number.parseInt(ARGS.limit || '500', 10) || 500));
const DRY_RUN = !!ARGS['dry-run'];

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function hasSpecificTime(value) {
  return /\d{1,2}:\d{2}|\d{1,2}\s*(am|pm|a\.m|p\.m)|noon|midday/i.test(String(value || '').toLowerCase());
}

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

async function columnExists(table, column) {
  const info = await db(table).columnInfo().catch(() => ({}));
  return !!info[column];
}

async function findLegacyScheduledService(call) {
  if (!call?.twilio_call_sid || !(await tableExists('scheduled_services'))) return null;

  if (await columnExists('scheduled_services', 'source_call_log_id')) {
    const linked = await db('scheduled_services')
      .where({ source_call_log_id: call.id })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);
    if (linked) return linked;
  }

  return db('scheduled_services')
    .where('notes', 'like', `%Call SID: ${call.twilio_call_sid}%`)
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
}

async function findLeadId(call) {
  if (!call?.twilio_call_sid || !(await tableExists('leads'))) return null;
  const row = await db('leads')
    .where({ twilio_call_sid: call.twilio_call_sid })
    .orderBy('created_at', 'desc')
    .select('id')
    .first()
    .catch(() => null);
  return row?.id || null;
}

async function candidateCalls() {
  return db('call_log as cl')
    .whereNotNull('cl.twilio_call_sid')
    .whereIn('cl.processing_status', ['processed', 'spam', 'voicemail', 'customer_creation_failed'])
    .whereNotExists(function notAlreadyBackfilled() {
      this.select(db.raw('1'))
        .from('route_decisions as rd')
        .whereRaw('rd.call_log_id = cl.id')
        .where('rd.decision_version', 'legacy-call-v1')
        .where('rd.mode', 'shadow');
    })
    .orderBy('cl.created_at', 'desc')
    .limit(LIMIT)
    .select('cl.*');
}

(async function main() {
  try {
    if (!(await tableExists('route_decisions'))) {
      throw new Error('route_decisions table does not exist; run the call-triage migrations first');
    }

    const rows = await candidateCalls();
    let written = 0;
    let skippedNoExtraction = 0;
    let dryRunWouldWrite = 0;

    for (const call of rows) {
      const extracted = parseJson(call.ai_extraction, null);
      if (!extracted) {
        skippedNoExtraction += 1;
        continue;
      }

      const scheduled = await findLegacyScheduledService(call);
      const serviceResolution = resolveSchedulableCallService(extracted, {
        transcription: call.transcription || '',
      });
      const appointmentResult = scheduled
        ? {
            scheduledServiceId: scheduled.id,
            service: scheduled.service_type,
            dateTime: extracted.preferred_date_time || null,
            scheduledDate: scheduled.scheduled_date || null,
            windowStart: scheduled.window_start || null,
            smsSent: false,
            backfilled: true,
          }
        : null;

      const payload = {
        call,
        extracted,
        customerId: call.customer_id || null,
        leadId: await findLeadId(call),
        finalStatus: call.processing_status,
        appointmentResult,
        serviceResolution,
        hasSpecificTime: hasSpecificTime(extracted.preferred_date_time),
        createdCustomerFromCall: false,
      };

      if (DRY_RUN) {
        dryRunWouldWrite += 1;
        continue;
      }

      const result = await writeLegacyShadowRouteDecision(payload);
      if (result) written += 1;
    }

    console.log(JSON.stringify({
      ok: true,
      dryRun: DRY_RUN,
      checked: rows.length,
      written,
      dryRunWouldWrite,
      skippedNoExtraction,
      limit: LIMIT,
    }, null, 2));
    await db.destroy();
  } catch (err) {
    console.error(`Backfill failed: ${err.message}`);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
