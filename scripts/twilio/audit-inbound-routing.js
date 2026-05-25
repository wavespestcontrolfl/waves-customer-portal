#!/usr/bin/env node
/**
 * Audit Waves inbound call routing across Twilio and the portal DB.
 *
 * Recommended prod run:
 *   railway run -s Postgres -- bash -lc 'DATABASE_URL=$DATABASE_PUBLIC_URL NODE_ENV=production node scripts/twilio/audit-inbound-routing.js --days=30'
 *
 * This prints masked phone numbers only. It intentionally avoids echoing env
 * vars or connection strings.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const twilio = require('twilio');
const TWILIO_NUMBERS = require('../../server/config/twilio-numbers');

const FLOW_SID = process.env.TWILIO_INBOUND_FLOW_SID || 'FW5fdc2e44700c6e786ed27de94e0cbace';
const APP_VOICE_URL =
  process.env.TWILIO_EXPECTED_APP_VOICE_URL ||
  'https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const DAYS = Math.max(1, parseInt(argValue('days', '30'), 10) || 30);
const MODE = argValue('mode', 'studio'); // studio | app
const EXPECTED_DRIFT = Math.max(0, parseInt(argValue('expected-drift', '0'), 10) || 0);

function maskPhone(value) {
  const phone = String(value || '');
  return phone.replace(/\+1(\d{3})(\d{3})(\d{4})/g, '+1$1***$3');
}

function maskSid(sid) {
  const value = String(sid || '');
  if (value.length <= 8) return value || null;
  return `${value.slice(0, 2)}...${value.slice(-6)}`;
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function expectedVoiceUrl() {
  if (MODE === 'app') return APP_VOICE_URL;
  return `/Flows/${FLOW_SID}`;
}

function voiceUrlMatches(url) {
  if (MODE === 'app') return String(url || '') === APP_VOICE_URL;
  return String(url || '').includes(`/Flows/${FLOW_SID}`);
}

async function auditTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');

  const client = twilio(sid, token);
  const expectedNumbers = new Set(TWILIO_NUMBERS.allNumbers.map((n) => n.number));
  const incomingNumbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const matchedNumbers = incomingNumbers
    .filter((item) => expectedNumbers.has(item.phoneNumber))
    .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));

  const numberDrift = matchedNumbers
    .filter((item) => !voiceUrlMatches(item.voiceUrl))
    .map((item) => ({
      number: maskPhone(item.phoneNumber),
      voiceUrl: item.voiceUrl,
    }));

  const unmatchedExpected = [...expectedNumbers]
    .filter((number) => !incomingNumbers.some((item) => item.phoneNumber === number))
    .map(maskPhone);

  const flow = await client.studio.v2.flows(FLOW_SID).fetch();
  const forwardState = (flow.definition.states || []).find((state) => state.name === 'forward_call')
    || (flow.definition.states || []).find((state) => state.type === 'connect-call-to');
  const voicemailState = (flow.definition.states || []).find((state) => state.type === 'record-voicemail');
  const forwardTargets = String(forwardState?.properties?.to || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const calls = await client.calls.list({ startTimeAfter: since, limit: 1000 });
  const inbound = calls.filter((item) => (
    expectedNumbers.has(item.to) &&
    item.direction === 'inbound' &&
    !item.parentCallSid
  ));
  const inboundSids = new Set(inbound.map((item) => item.sid));
  const childLegs = calls.filter((item) => item.parentCallSid && inboundSids.has(item.parentCallSid));
  const staffForwardLegs = childLegs.filter((item) => forwardTargets.includes(item.to));
  const completedStaffLegs = staffForwardLegs.filter((item) => item.status === 'completed');
  const completedDuration = completedStaffLegs.reduce((sum, item) => sum + Number(item.duration || 0), 0);

  return {
    mode: MODE,
    expectedVoiceUrl: expectedVoiceUrl(),
    numbers: {
      expected: expectedNumbers.size,
      matchedInTwilio: matchedNumbers.length,
      unmatchedExpected,
      driftCount: numberDrift.length,
      drift: numberDrift,
    },
    flow: {
      friendlyName: flow.friendlyName,
      sid: maskSid(flow.sid),
      revision: flow.revision,
      status: flow.status,
      dateUpdated: flow.dateUpdated,
      hasForwardCall: !!forwardState,
      forwardTargets: forwardTargets.map(maskPhone),
      voicemail: voicemailState ? {
        state: voicemailState.name,
        recordingStatusCallback: voicemailState.properties?.recording_status_callback_url || null,
        transcriptionCallback: voicemailState.properties?.transcription_callback_url || null,
      } : null,
    },
    twilioCalls: {
      days: DAYS,
      inboundTotal: inbound.length,
      inboundByStatus: countBy(inbound, (item) => item.status),
      childLegsTotal: childLegs.length,
      staffForwardLegs: staffForwardLegs.length,
      staffByStatus: countBy(staffForwardLegs, (item) => item.status),
      staffByTo: countBy(staffForwardLegs, (item) => maskPhone(item.to)),
      completedStaffLegs: completedStaffLegs.length,
      avgCompletedStaffDurationSeconds: completedStaffLegs.length
        ? Math.round(completedDuration / completedStaffLegs.length)
        : 0,
    },
  };
}

async function auditDb() {
  if (!process.env.DATABASE_URL) {
    return { skipped: true, reason: 'DATABASE_URL not set' };
  }

  const db = require('../../server/models/db');
  try {
    const sinceSql = db.raw(`now() - interval '${DAYS} days'`);
    const totals = await db('call_log')
      .where('created_at', '>', sinceSql)
      .where('direction', 'inbound')
      .select(
        db.raw('count(*) as total'),
        db.raw("count(*) filter (where answered_by = 'human') as human"),
        db.raw("count(*) filter (where answered_by = 'voicemail' or call_outcome = 'voicemail') as voicemail"),
        db.raw("count(*) filter (where answered_by = 'missed') as missed"),
        db.raw('count(*) filter (where recording_url is not null) as with_recording'),
        db.raw("count(*) filter (where transcription is not null and btrim(transcription) <> '') as with_transcription")
      )
      .first();

    const byNumberRows = await db('call_log')
      .where('created_at', '>', sinceSql)
      .where('direction', 'inbound')
      .select('to_phone')
      .count('* as total')
      .count({ human: db.raw("case when answered_by = 'human' then 1 end") })
      .count({ voicemail: db.raw("case when answered_by = 'voicemail' or call_outcome = 'voicemail' then 1 end") })
      .count({ missed: db.raw("case when answered_by = 'missed' then 1 end") })
      .groupBy('to_phone')
      .orderBy('total', 'desc');

    const byNumber = byNumberRows.map((row) => ({
      toPhone: maskPhone(row.to_phone || 'unknown'),
      total: Number(row.total || 0),
      human: Number(row.human || 0),
      voicemail: Number(row.voicemail || 0),
      missed: Number(row.missed || 0),
    }));

    return {
      skipped: false,
      days: DAYS,
      totals: Object.fromEntries(
        Object.entries(totals || {}).map(([key, value]) => [key, Number(value || 0)])
      ),
      byNumber,
    };
  } finally {
    await db.destroy();
  }
}

function evaluate(report) {
  const failures = [];
  const warnings = [];

  if (report.twilio.numbers.unmatchedExpected.length) {
    failures.push(`${report.twilio.numbers.unmatchedExpected.length} configured Waves number(s) are missing from Twilio.`);
  }
  if (report.twilio.numbers.driftCount !== EXPECTED_DRIFT) {
    failures.push(
      `${report.twilio.numbers.driftCount} Waves number(s) do not point at the expected ${MODE} voice URL; expected ${EXPECTED_DRIFT}.`
    );
  } else if (EXPECTED_DRIFT > 0) {
    warnings.push(`${EXPECTED_DRIFT} voice URL drift(s) allowed for intentional canary state.`);
  }
  if (MODE === 'studio' && !report.twilio.flow.hasForwardCall) {
    failures.push('Studio mode expected a forward_call/connect-call-to state, but none was found.');
  }
  if (!report.db.skipped && report.db.totals.total !== report.twilio.twilioCalls.inboundTotal) {
    warnings.push(
      `Portal call_log inbound total (${report.db.totals.total}) differs from Twilio inbound total (${report.twilio.twilioCalls.inboundTotal}) for ${DAYS}d.`
    );
  }
  if (report.db.skipped) {
    warnings.push(`DB audit skipped: ${report.db.reason}`);
  }

  return { failures, warnings };
}

async function main() {
  const twilioReport = await auditTwilio();
  const dbReport = await auditDb();
  const report = {
    auditedAt: new Date().toISOString(),
    twilio: twilioReport,
    db: dbReport,
  };
  const evaluation = evaluate(report);

  console.log(JSON.stringify({ ...report, evaluation }, null, 2));

  if (evaluation.failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`audit-inbound-routing failed: ${err.message}`);
  process.exit(1);
});
