/**
 * Text-thread lead reader (GATE_SMS_LEAD_EXTRACTION, default OFF; owner 2026-10-23).
 *
 * The call path turns a phone call into a lead (lead-from-extraction.js). A
 * person who TEXTS a Waves line instead got nothing: their name, address and
 * email sat in the thread until someone copied them by hand. A 180-day dry run
 * (2026-10-23) found 40 service requests from unknown numbers; 23 never got a
 * lead or customer record.
 *
 * Every 5 minutes (scheduler.js) this sweep reads the thread of each number that
 *  - texted a customer-facing Waves line in the last 24 hours,
 *  - has been quiet for QUIET_MINUTES (people send name, address and email as
 *    separate texts a minute apart),
 *  - has no customer record, and no lead other than one THIS reader made.
 * One model call reads the thread. A new service request for a service Waves
 * offers, at confidence >= MIN_CONFIDENCE, goes through createLeadFromExtraction
 * (channel 'sms') and raises one admin bell per lead. A later text from the
 * same number is a new thread state: it is read again and fills the same lead
 * (the writer fills empty fields only) and refreshes the same bell.
 *
 * Nothing is sent to the texter. Each read is one sms_lead_extractions row,
 * unique on (number, newest inbound text covered), so two instances cannot
 * read the same state twice; a failed read is retried up to MAX_ATTEMPTS.
 */

const db = require('../models/db');
const logger = require('./logger');

const QUIET_MINUTES = 5;
const LOOKBACK_HOURS = 24;
const THREAD_LOOKBACK_HOURS = 48;
const MAX_THREAD_MESSAGES = 30;
const MAX_TEXT_CHARS = 600;
const MIN_CONFIDENCE = 0.8;
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MINUTES = 10;
const DEFAULT_LIMIT = 10;

// Customer-facing inbound rows only: ordinary texts and tracking-number leads.
// Opt-out, help, reactions and consumed replies carry other types.
const INBOUND_TYPES = ['inbound', 'domain_lead', 'van_lead'];
// Lines nobody uses to ask for service (twilio-numbers.js `type`).
const SKIP_SOURCES = ['tech_line', 'internal_alert'];

const KINDS = ['new_service_request', 'existing_job', 'spam_or_solicitation', 'wrong_number', 'job_seeker', 'vendor', 'other'];
const NULLABLE_STRING = { type: ['string', 'null'] };
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'service_offered', 'first_name', 'last_name', 'email', 'address_line', 'city', 'zip',
    'requested_service', 'problem_summary', 'wants_quote', 'confidence'],
  properties: {
    kind: { type: 'string', enum: KINDS },
    service_offered: { type: 'boolean' },
    first_name: NULLABLE_STRING,
    last_name: NULLABLE_STRING,
    email: NULLABLE_STRING,
    address_line: NULLABLE_STRING,
    city: NULLABLE_STRING,
    zip: NULLABLE_STRING,
    requested_service: NULLABLE_STRING,
    problem_summary: NULLABLE_STRING,
    wants_quote: { type: 'boolean' },
    confidence: { type: 'number', description: 'Confidence that kind is right, from 0 to 1' },
  },
};

const PROMPT_HEAD = `You read an SMS thread between Waves (a pest control and lawn care company in Manatee and Sarasota counties, Florida) and a phone number that texted it. Decide whether the TEXTER is a NEW potential customer asking for service, a quote, pricing or an inspection, and extract only what the TEXTER wrote.

kind:
- new_service_request: a new person or property asking for service, a quote, pricing, an inspection or a visit (a property manager asking for service counts).
- existing_job: about a visit, estimate, bill or code already in progress.
- spam_or_solicitation: a business pitching something TO Waves (leads, marketing, software, insurance, staffing, websites).
- vendor: a contractor or company asking Waves for papers or offering a partnership.
- wrong_number, job_seeker, other.

service_offered: true only when the texter asks for general pest control, ants, roaches, spiders, bed bugs, fleas, wasps or bees, rodents, termites or WDO inspections, mosquitoes, lawn care, or tree and shrub care. False for power washing, snakes or other wildlife, trash cans, mold, roofing, or when no service is asked for.

Fields: names, email and address only when the texter typed them (or signed a text). Never guess, never copy Waves' own details. address_line = house number and street. Lowercase the email. requested_service = a few words. problem_summary = one sentence in plain English.`;

function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function maskPhone(phone) {
  const d = phoneLast10(phone);
  return d ? `***${d.slice(-4)}` : '[no phone]';
}

// Numbers with a qualifying inbound text in the window whose newest such text
// is older than the quiet window. Newest first, bounded.
async function findCandidates({ limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const quietBefore = new Date(now.getTime() - QUIET_MINUTES * 60_000);
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000);
  const { rows } = await db.raw(`
    WITH latest AS (
      SELECT DISTINCT ON (RIGHT(regexp_replace(from_phone, '[^0-9]', '', 'g'), 10))
             RIGHT(regexp_replace(from_phone, '[^0-9]', '', 'g'), 10) AS phone_last10,
             id AS sms_log_id, created_at, from_phone, to_phone, twilio_sid
        FROM sms_log
       WHERE direction = 'inbound'
         AND message_type = ANY(?::text[])
         AND created_at >= ?
         AND COALESCE(message_body, '') <> ''
         AND COALESCE(metadata->>'source', '') <> ALL(?::text[])
       ORDER BY RIGHT(regexp_replace(from_phone, '[^0-9]', '', 'g'), 10), created_at DESC
    )
    SELECT latest.* FROM latest
     WHERE latest.created_at <= ?
       AND LENGTH(latest.phone_last10) = 10
       AND NOT EXISTS (
         SELECT 1 FROM sms_lead_extractions x
          WHERE x.phone_last10 = latest.phone_last10
            AND x.through_sms_log_id = latest.sms_log_id
            AND NOT (
              (x.status = 'failed' AND x.attempts < ?)
              OR (x.status = 'running' AND x.updated_at < ?)
            )
       )
     ORDER BY latest.created_at DESC
     LIMIT ?`,
  [INBOUND_TYPES, since, SKIP_SOURCES, quietBefore, MAX_ATTEMPTS,
    new Date(now.getTime() - STALE_RUNNING_MINUTES * 60_000), limit]);
  return rows;
}

// Claim a thread state. Returns the row id, or null when another instance
// holds it (or it is finished). A failed or stale row is taken over in place.
async function claim(candidate) {
  const inserted = await db('sms_lead_extractions')
    .insert({
      phone_last10: candidate.phone_last10,
      through_sms_log_id: candidate.sms_log_id,
      through_at: candidate.created_at,
      status: 'running',
      attempts: 1,
    })
    .onConflict(['phone_last10', 'through_sms_log_id'])
    .ignore()
    .returning('id');
  if (inserted.length) return inserted[0].id || inserted[0];
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MINUTES * 60_000);
  const taken = await db('sms_lead_extractions')
    .where({ phone_last10: candidate.phone_last10, through_sms_log_id: candidate.sms_log_id })
    .where((q) => q.where((w) => w.where('status', 'failed').where('attempts', '<', MAX_ATTEMPTS))
      .orWhere((w) => w.where('status', 'running').where('updated_at', '<', staleBefore)))
    .update({ status: 'running', attempts: db.raw('attempts + 1'), error: null, updated_at: new Date() })
    .returning('id');
  return taken.length ? (taken[0].id || taken[0]) : null;
}

async function finish(id, fields) {
  await db('sms_lead_extractions').where({ id }).update({ ...fields, updated_at: new Date() });
}

const PHONE_SQL = "RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?";

// Who already owns this number. A lead made by an earlier read of this number
// is ours to fill; any other lead (a web form, a call, staff) is not.
async function knownState(phone10) {
  const customer = await db('customers').whereNull('deleted_at').whereRaw(PHONE_SQL, [phone10]).first('id');
  if (customer) return { status: 'known_customer' };
  const leads = await db('leads').whereNull('deleted_at').whereRaw(PHONE_SQL, [phone10]).select('id');
  if (!leads.length) return { status: null, ownLeadId: null };
  const ours = await db('sms_lead_extractions')
    .where({ phone_last10: phone10 })
    .whereIn('lead_id', leads.map((l) => l.id))
    .first('lead_id');
  if (leads.length === 1 && ours) return { status: null, ownLeadId: ours.lead_id };
  return { status: 'existing_lead' };
}

async function loadThread(phone10, throughAt) {
  const from = new Date(new Date(throughAt).getTime() - THREAD_LOOKBACK_HOURS * 3_600_000);
  const rows = await db('sms_log')
    .where((q) => q.whereRaw("RIGHT(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone10])
      .orWhereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone10]))
    .where('created_at', '>=', from)
    .where('created_at', '<=', throughAt)
    .whereRaw("COALESCE(message_body, '') <> ''")
    .orderBy('created_at', 'desc')
    .limit(MAX_THREAD_MESSAGES)
    .select('direction', 'message_body', 'created_at', 'metadata');
  return rows.reverse();
}

function spamScreened(rows) {
  return rows.some((r) => {
    if (r.direction !== 'inbound') return false;
    let meta = r.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    return meta?.spam_verdict?.enforced === true;
  });
}

function threadText(rows) {
  return rows.map((r) => {
    const who = r.direction === 'inbound' ? 'TEXTER' : 'WAVES';
    const at = new Date(r.created_at).toISOString().slice(0, 16);
    return `[${who} ${at}] ${String(r.message_body).slice(0, MAX_TEXT_CHARS)}`;
  }).join('\n');
}

async function readThread(text) {
  const MODELS = require('../config/models');
  const { dispatchWithFallback } = require('./llm/call');
  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.routineAnswer, {
    laneId: 'sms_lead_extraction',
    text: `${PROMPT_HEAD}\n\nThread:\n${text}`,
    jsonMode: true,
    jsonSchema: EXTRACTION_SCHEMA,
    maxTokens: 600,
    timeoutMs: 60_000,
  });
  if (!response?.ok || !response.json || typeof response.json !== 'object') return null;
  return response.json;
}

const clean = (v, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
const cleanEmail = (v) => {
  const s = clean(v, 150);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
};
const cleanZip = (v) => {
  const m = String(v || '').match(/\b(\d{5})\b/);
  return m ? m[1] : null;
};

function isLead(x) {
  return x?.kind === 'new_service_request' && x.service_offered === true && Number(x.confidence) >= MIN_CONFIDENCE;
}

function toExtracted(x) {
  return {
    first_name: clean(x.first_name, 50),
    last_name: clean(x.last_name, 50),
    email: cleanEmail(x.email),
    address_line1: clean(x.address_line, 200),
    city: clean(x.city, 50),
    zip: cleanZip(x.zip),
    requested_service: clean(x.requested_service, 120),
    call_summary: clean(x.problem_summary, 400),
    ...(x.wants_quote === true ? { quote_requested: true } : {}),
  };
}

// One bell per lead (docs/admin-notifications.md). A later read of the same
// number rewrites it in place with what the new texts added.
async function ringLeadBell(leadId, extracted) {
  const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
  const { fitAction, fullName, redactedWords } = require('./admin-alert-names');
  const lead = await db('leads').where({ id: leadId }).first('first_name', 'last_name', 'email', 'address', 'city', 'zip', 'service_interest');
  const name = fullName(lead);
  const service = redactedWords(lead?.service_interest || extracted.requested_service || 'service').replace(/[.!?]+/g, ',');
  const missing = [!name && 'name', !lead?.address && 'address', !lead?.email && 'email'].filter(Boolean);
  const tail = missing.length ? `; not given yet: ${missing.join(', ')}.` : '; name, address and email are on the lead.';
  await raiseAdminAlert('lead', {
    area: 'Leads',
    action: fitAction('Leads', name || 'a new texter', [
      (who) => `reply to ${who} about a texted request`,
      (who) => `reply to ${who}`,
    ]),
    why: `${cutAtWord(`Asked by text for ${service}`, 110 - tail.length)}${tail}`,
    severity: 'needs-you',
    link: `/admin/leads?lead=${leadId}`,
    subject: { type: 'lead', id: String(leadId) },
    doneWhen: 'lead_contacted',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: `sms-lead:${leadId}`,
    refreshOnDedupe: true,
    detail: [
      extracted.call_summary ? `What they asked: ${extracted.call_summary}` : null,
      [name, [lead?.address, lead?.city, lead?.zip].filter(Boolean).join(', '), lead?.email].filter(Boolean).join(' | ') || null,
      'Read from the text thread by the text lead reader. Nothing was sent to the texter.',
    ].filter(Boolean).join('\n'),
    metadata: { leadId, source: 'sms_lead_extraction' },
  });
}

async function processCandidate(candidate) {
  const id = await claim(candidate);
  if (!id) return { status: 'claimed_elsewhere' };
  try {
    const known = await knownState(candidate.phone_last10);
    if (known.status) {
      await finish(id, { status: known.status });
      return { status: known.status };
    }
    const rows = await loadThread(candidate.phone_last10, candidate.created_at);
    if (spamScreened(rows)) {
      await finish(id, { status: 'spam_screen' });
      return { status: 'spam_screen' };
    }
    const x = await readThread(threadText(rows));
    if (!x) {
      await finish(id, { status: 'failed', error: 'model_unavailable' });
      return { status: 'failed' };
    }
    const kind = KINDS.includes(x.kind) ? x.kind : 'other';
    const confidence = Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(1, Number(x.confidence))) : null;
    if (!isLead(x)) {
      await finish(id, { status: 'not_lead', kind, confidence, extracted: JSON.stringify({ service_offered: x.service_offered === true }) });
      return { status: 'not_lead', kind };
    }
    const extracted = toExtracted(x);
    const { createLeadFromExtraction } = require('./lead-from-extraction');
    const out = await createLeadFromExtraction(extracted, {
      phone: candidate.from_phone,
      toPhone: candidate.to_phone,
      channel: 'sms',
      messageSid: candidate.twilio_sid || null,
    });
    if (!out?.leadId) {
      await finish(id, { status: 'failed', kind, confidence, error: 'lead_write_returned_no_lead' });
      return { status: 'failed' };
    }
    const status = out.created ? 'lead_created' : 'lead_updated';
    await finish(id, { status, kind, confidence, lead_id: out.leadId, extracted: JSON.stringify(extracted) });
    await ringLeadBell(out.leadId, extracted)
      .catch((err) => logger.warn(`[sms-lead-extraction] bell failed for lead ${out.leadId}: ${err.message}`));
    logger.info(`[sms-lead-extraction] ${status} ${out.leadId} for ${maskPhone(candidate.from_phone)}`);
    return { status, leadId: out.leadId };
  } catch (err) {
    logger.error(`[sms-lead-extraction] read failed for ${maskPhone(candidate.from_phone)}: ${err.message}`);
    await finish(id, { status: 'failed', error: String(err.message || 'error').slice(0, 200) }).catch(() => {});
    return { status: 'failed' };
  }
}

async function sweepSmsLeadCandidates({ limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('smsLeadExtraction')) return { skipped: 'gate_off' };
  const candidates = await findCandidates({ limit, now });
  const counts = {};
  for (const c of candidates) {
    const r = await processCandidate(c);
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  if (candidates.length) logger.info(`[sms-lead-extraction] sweep: ${JSON.stringify(counts)}`);
  return { candidates: candidates.length, counts };
}

module.exports = {
  sweepSmsLeadCandidates,
  _test: { readThread, findCandidates, processCandidate, knownState, threadText, spamScreened, isLead, toExtracted, claim, EXTRACTION_SCHEMA, QUIET_MINUTES, MIN_CONFIDENCE },
};
