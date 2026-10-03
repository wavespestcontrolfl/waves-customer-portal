/**
 * Correction loop for calls (Part B wave 1, scope 2026-10-02; owner ruling
 * Q5: the general ai_incidents / ai_fix_proposals tables).
 *
 * The nightly self-audit (call-self-audit.js) re-reads sampled calls with a
 * DEEP model and stores each field where it disagrees with production in
 * call_audit_findings. One model disagreeing is a lead, not a mistake, so
 * each finding is adjudicated here under the same two-model rule as texts:
 *
 *   confirmed_mistake — a second model on a DIFFERENT provider from the one
 *     that actually answered the audit (its served model is stored on the
 *     finding; the fastStructured leg on the other provider), reading
 *     the same transcript blind with the auditor's own prompt, reaches the
 *     auditor's answer for that field, AND both readers' supporting excerpts
 *     are words the transcript really contains.
 *   lead — anything else (the second reader sides with production, an
 *     excerpt is not in the transcript, the auditor gave no boolean for the
 *     field, its provider is unknown, or the call is longer than the
 *     readers are shown).
 *
 * A second reader that cannot be reached stores nothing (retried next run).
 * The typed-decision answers (TypeSafe Jev, Cloudflare Clef) for the same
 * call and field are stored as signals only: they are unvalidated (M0).
 *
 * Staff tags on the call tab are the other source (recordStaffTagCorrections):
 * a person's tag that contradicts production's value for an audited field is
 * a confirmed mistake in the same cells, with no model involved.
 *
 * Gate GATE_CALL_INCIDENTS (dark; read live via callIncidentsLive(), needs
 * GATE_CALL_SELF_AUDIT). CALL_INCIDENT_BATCH=0 stops the nightly job.
 * Shadow data only: nothing reads ai_incidents at runtime and nothing
 * reaches a customer.
 */

const db = require('../models/db');
const logger = require('./logger');

const AREA = 'calls';
const SURFACE = 'call_extraction';
const EVIDENCE_TYPE = 'call_audit_finding';
const SCHEMA_VERSION = 'ai-incidents.v1';
// The decision fields the self-audit compares (call-self-audit.js productionAnswers).
const FIELDS = Object.freeze(['is_lead', 'is_spam', 'is_voicemail', 'appointment_agreed', 'quote_promised']);
// The closed failure-mode list for calls: each field, wrongly true or wrongly false.
const FAILURE_MODES = Object.freeze(FIELDS.flatMap((f) => [`${f}_false_positive`, `${f}_missed`]));
const MIN_EXCERPT_CHARS = 12;
const LOOKBACK_DAYS = 14;
// finding id + 12 hex of md5(everything the finding says): both values, the
// excerpt and the whole detail (the auditor's full verdict and its model).
// Any change to any of it is new evidence.
const EVIDENCE_KEY_SQL = "(f.id)::text || ':' || left(md5(coalesce(f.old_value, '') || '|' || coalesce(f.new_value, '') || '|' || coalesce(f.transcript_excerpt, '') || '|' || coalesce((f.detail::jsonb)::text, '')), 12)";

const envNum = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

// Production said `prodValue` for `field`: the mistake is a false positive
// when production said true, a miss when it said false.
function failureModeFor(field, prodValue) {
  return `${field}_${prodValue ? 'false_positive' : 'missed'}`;
}

const norm = (t) => String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/^(agent|caller)\s*:\s*/gm, '').replace(/\s+/g, ' ').trim();

/** Are these the transcript's own words (long enough to mean something)? */
function excerptInTranscript(excerpt, transcript) {
  const e = norm(excerpt).replace(/^["'.\s]+|["'.\s]+$/g, '');
  if (e.length < MIN_EXCERPT_CHARS) return false;
  return norm(transcript).includes(e);
}

/**
 * The provider behind a served model id, from the model catalog (an exact
 * id, else the catalog id it extends, e.g. a dated snapshot). Unknown → null.
 */
function providerForModel(model) {
  if (!model) return null;
  const { MODEL_CATALOG } = require('../config/models');
  const id = String(model);
  if (MODEL_CATALOG[id]) return MODEL_CATALOG[id].provider || null;
  const base = Object.keys(MODEL_CATALOG).filter((k) => id.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return base ? MODEL_CATALOG[base].provider || null : null;
}

/**
 * The two-model rule for one finding. `auditorValue` is the auditor's answer
 * for `field` (the finding's new_value); `second` is the second reader's
 * parsed JSON (null = answered but unusable). The second reader is asked for
 * words that support its answer FOR THIS FIELD (`field_excerpt`): that quote,
 * verified in the transcript, is the evidence. The auditor's single excerpt
 * backs whatever it judged most important, not necessarily this field, so it
 * is recorded as a signal and never decides.
 */
function decideCallFinding({ field, auditorValue, auditorExcerpt, second, transcript }) {
  const auditorExcerptVerified = excerptInTranscript(auditorExcerpt, transcript);
  const secondValue = second && typeof second[field] === 'boolean' ? second[field] : null;
  const secondExcerptVerified = Boolean(second) && excerptInTranscript(second.field_excerpt, transcript);
  const verdict = { auditorExcerptVerified, secondValue, secondExcerptVerified };
  if (secondValue === null) return { disposition: 'lead', rule: 'second_unusable', ...verdict };
  if (secondValue !== auditorValue) return { disposition: 'lead', rule: 'second_sides_with_production', ...verdict };
  if (!secondExcerptVerified) return { disposition: 'lead', rule: 'excerpt_unverified', ...verdict };
  return { disposition: 'confirmed_mistake', rule: 'two_models', ...verdict };
}

function parseReaderJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ask the second reader: the fastStructured leg on the OTHER provider from
 * the auditor's, alone (no fallback — a fallback could land on the
 * auditor's own provider). Returns { ok, answer, provider, model } or
 * { ok: false }.
 */
async function askSecondReader(call, auditorProvider) {
  // `call` is the candidate row: transcript, direction and the disputed field.
  const { dispatchWithFallback } = require('./llm/call');
  const MODELS = require('../config/models');
  const { AUDIT_PROMPT, auditUserContent } = require('./call-self-audit');
  const policy = MODELS.TEXT_POLICIES.fastStructured;
  const leg = [policy.primary, policy.fallback].find((l) => l && l.provider !== auditorProvider);
  if (!leg) return { ok: false, reason: 'no_other_provider_leg' };
  const routed = await dispatchWithFallback(
    { name: policy.name, primary: leg },
    {
      laneId: 'call_incidents',
      // The auditor's own contract, plus one ask: the words behind THIS field.
      system: `${AUDIT_PROMPT}\nAlso include "field_excerpt": the exact words from the transcript (at most 25) that support your answer for "${call.field}".`,
      // The very text the auditor read (leadWithoutReading checked its hash).
      text: auditUserContent(call),
      jsonMode: true,
      maxTokens: 400,
    },
    { validate: (result) => (parseReaderJson(result.text) ? null : 'unparseable') }
  );
  if (!routed.ok) return { ok: false, reason: routed.reason || 'dispatch_failed' };
  return { ok: true, answer: parseReaderJson(routed.text), provider: routed.provider || leg.provider, model: routed.model || leg.model };
}

async function typedSignals(dbi, callId, field) {
  try {
    const rows = await dbi('decision_reviews')
      .where({ subject_type: 'call_log', question_id: field })
      .whereRaw('subject_id::text = ?', [String(callId)])
      .select('provider', 'jev_answer', 'package_id');
    return rows.map((r) => ({ provider: r.provider || 'typesafe', package: r.package_id, answer: r.jev_answer }));
  } catch (err) {
    logger.warn(`[call-incidents] typed signals unreadable for ${String(callId).slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Findings that stay leads with no second reading (no call made):
 *   auditor_value_missing — the auditor never answered this field as a
 *     boolean (the self-audit stores Boolean(verdict[field]), so a missing
 *     answer reads as "false");
 *   audit_input_changed — the exact input the auditor read (prompt,
 *     direction instruction, transcript) can no longer be rendered from the
 *     call: the prompt changed, the call was re-transcribed or its recording
 *     replaced, or the finding predates the stored hash. A second reading
 *     would be of different evidence;
 *   auditor_provider_unknown — a second reader could share its provider;
 *   transcript_truncated — the call is longer than both readers are shown,
 *     so the disagreement may sit in the part neither read.
 */
function leadWithoutReading({ row, detail, auditorProvider, auditorValue }) {
  const { auditInputHash, AUDIT_TRANSCRIPT_CHARS } = require('./call-self-audit');
  if (detail?.verdict?.[row.field] !== auditorValue) return 'auditor_value_missing';
  if (detail?.audit_input_hash !== auditInputHash(row)) return 'audit_input_changed';
  if (!auditorProvider) return 'auditor_provider_unknown';
  if (String(row.transcription || '').length > AUDIT_TRANSCRIPT_CHARS) return 'transcript_truncated';
  return null;
}

const isUniqueViolation = (err) => err && err.code === '23505';
const safeJson = (t) => {
  try { return JSON.parse(t) || {}; } catch { return {}; }
};

/**
 * Insert one incident row. The evidence key makes it idempotent (a row that
 * already exists is left alone: returns null). One confirmed row per (call,
 * cell): further confirmed evidence about the same call and cell is kept as
 * a `duplicate`, never counted twice. Returns the disposition stored.
 */
async function insertIncident(dbi, base, disposition, adjudication) {
  try {
    const inserted = await dbi('ai_incidents')
      .insert({ ...base, disposition, adjudication: adjudication() })
      .onConflict(['area', 'evidence_type', 'evidence_id'])
      .ignore()
      .returning('id');
    return inserted.length ? disposition : null;
  } catch (err) {
    if (!(isUniqueViolation(err) && disposition === 'confirmed_mistake')) throw err;
    const inserted = await dbi('ai_incidents')
      .insert({ ...base, disposition: 'duplicate', adjudication: adjudication({ duplicate_of_confirmed: true }) })
      .onConflict(['area', 'evidence_type', 'evidence_id'])
      .ignore()
      .returning('id');
    return inserted.length ? 'duplicate' : null;
  }
}

/**
 * One finding → one ai_incidents row. Returns the stored disposition, or
 * null when nothing was stored (no disagreement, or the second reader could
 * not be reached: retried next run).
 */
async function adjudicateOne({ dbi, row, reader }) {
  const prodValue = row.old_value === 'true';
  const auditorValue = row.new_value === 'true';
  // A row whose two values agree is not a disagreement (defensive).
  if (prodValue === auditorValue) return null;
  const detail = typeof row.detail === 'string' ? safeJson(row.detail) : (row.detail || {});
  // Recorded at audit time; the catalog is only a fallback for older rows.
  const auditorProvider = detail.auditor_provider || providerForModel(detail.auditor_model);
  const skipRule = leadWithoutReading({ row, detail, auditorProvider, auditorValue });
  let reading = { ok: true, provider: null, model: null, answer: null };
  if (!skipRule) {
    reading = await reader(row, auditorProvider);
    if (!reading.ok) {
      logger.warn(`[call-incidents] second reader unavailable for finding ${String(row.finding_id).slice(0, 8)} (${reading.reason}); retried next run`);
      return null;
    }
  }
  const decision = skipRule
    ? { disposition: 'lead', rule: skipRule, auditorExcerptVerified: excerptInTranscript(row.transcript_excerpt, row.transcription), secondValue: null, secondExcerptVerified: false }
    : decideCallFinding({
      field: row.field, auditorValue, auditorExcerpt: row.transcript_excerpt, second: reading.answer, transcript: row.transcription,
    });
  // Belt: the two readers must be on different providers to confirm.
  if (decision.disposition === 'confirmed_mistake' && reading.provider === auditorProvider) {
    decision.disposition = 'lead';
    decision.rule = 'same_provider';
  }
  const signals = await typedSignals(dbi, row.call_id, row.field);
  const base = {
    area: AREA,
    evidence_type: EVIDENCE_TYPE,
    evidence_id: String(row.evidence_key),
    incident_key: String(row.call_id),
    surface: SURFACE,
    failure_mode: failureModeFor(row.field, prodValue),
    intent: null,
    // Unversioned: the audited answers come from ai_extraction, which can be
    // V1, V2-adopted or a mix per field, and nothing records which extractor
    // produced each one. ai_extraction_prompt_version is the V2 shadow's
    // provenance only, so it would mislabel V1 answers.
    prompt_version: null,
    produced_at: row.call_at || null,
    summary: `${row.field}: production said ${prodValue}, the auditor said ${auditorValue}${row.category === 'spam_false_positive' ? ' (spam false positive)' : ''}.`,
    model: reading.model || null,
    schema_version: SCHEMA_VERSION,
  };
  const adjudication = (extra = {}) => JSON.stringify({
    rule: decision.rule,
    field: row.field,
    production: prodValue,
    auditor: { value: auditorValue, model: detail.auditor_model || null, provider: auditorProvider, excerpt_verified: decision.auditorExcerptVerified },
    second: { provider: reading.provider, model: reading.model, value: decision.secondValue, excerpt_verified: decision.secondExcerptVerified },
    typed_signals: signals,
    ...extra,
  });
  const disposition = await insertIncident(dbi, base, decision.disposition, adjudication);
  return disposition;
}

/**
 * Nightly: every self-audit finding from the last LOOKBACK_DAYS not yet
 * adjudicated becomes ONE ai_incidents row (idempotent: anti-join + the
 * evidence key). Attribution is by when the CALL happened; unversioned.
 */
async function adjudicateCallFindings({ dbi = db, now = new Date(), batchLimit = envNum('CALL_INCIDENT_BATCH', 20), reader = askSecondReader } = {}) {
  const { callIncidentsLive } = require('../config/feature-gates');
  if (!callIncidentsLive()) return { skipped: 'gate_off' };
  if (!(batchLimit > 0)) return { skipped: 'batch_zero' };
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  // The self-audit updates a finding in place when it re-audits a call, so
  // the evidence key is the finding id plus a fingerprint of what it says:
  // a changed finding is new evidence (adjudicated again, and the one
  // confirmed row per call and cell still holds), an unchanged one is done.
  const evidenceKey = dbi.raw(EVIDENCE_KEY_SQL);
  const rows = await dbi({ f: 'call_audit_findings' })
    .join({ c: 'call_log' }, 'c.id', 'f.call_log_id')
    .leftJoin({ i: 'ai_incidents' }, function done() {
      this.on('i.evidence_id', evidenceKey).andOnVal('i.evidence_type', EVIDENCE_TYPE).andOnVal('i.area', AREA);
    })
    .whereNull('i.id')
    .where('f.audit_source', 'self_audit')
    .whereIn('f.category', ['field_drift', 'spam_false_positive'])
    .whereIn('f.field', FIELDS)
    .where('f.created_at', '>=', since)
    // Newest first: a finding whose second reading keeps failing stores
    // nothing and is retried, so oldest-first would let a few such rows hold
    // the batch against every newer one. At ~3 findings a day against a batch
    // of 20, the older retries still run every night after the new ones.
    .orderBy('f.created_at', 'desc')
    .limit(batchLimit)
    .select(
      'f.id as finding_id', 'f.field', 'f.old_value', 'f.new_value', 'f.transcript_excerpt', 'f.category', 'f.detail',
      dbi.raw(`${EVIDENCE_KEY_SQL} as evidence_key`),
      'c.id as call_id', 'c.direction', 'c.transcription', 'c.created_at as call_at'
    );

  const byDisposition = {};
  let adjudicated = 0;
  for (const row of rows) {
    try {
      const disposition = await adjudicateOne({ dbi, row, reader });
      if (!disposition) continue;
      adjudicated += 1;
      byDisposition[disposition] = (byDisposition[disposition] || 0) + 1;
    } catch (err) {
      logger.error(`[call-incidents] adjudication failed for finding ${String(row.finding_id).slice(0, 8)}: ${err.message}`);
    }
  }
  const summary = { adjudicated, byDisposition, candidates: rows.length };
  logger.info(`[call-incidents] adjudicate run complete: ${JSON.stringify(summary)}`);
  return summary;
}

// What a staff tag on the call tab says about the audited fields. A tag is a
// person's reading of the call, so where production's extraction said the
// opposite, that field is a confirmed mistake (owner ruling Q10, 2026-10-02:
// call-tab edits count as corrections of the extraction via field diff).
// Only facts the tag states outright: nothing here about voicemail or quotes.
const STAFF_TAG_FACTS = Object.freeze({
  new_lead_booked: Object.freeze({ is_lead: true, is_spam: false, appointment_agreed: true }),
  new_lead_no_booking: Object.freeze({ is_lead: true, is_spam: false, appointment_agreed: false }),
  existing_service_q: Object.freeze({ is_lead: false, is_spam: false }),
  existing_complaint: Object.freeze({ is_lead: false, is_spam: false }),
  spam: Object.freeze({ is_spam: true }),
});
const STAFF_TAG_EVIDENCE = 'call_tab_tag';

/**
 * What production's extraction EXPLICITLY recorded for the fields a tag can
 * speak to. A field is present only when the pipeline really answered it: a
 * finished call (processed / voicemail / spam) whose extraction carries that
 * boolean, or a spam status. An unprocessed call, a failed extraction or a
 * missing field is absent — never read as "false" (the self-audit's
 * productionAnswers coerces, which is right for its sampled, processed calls
 * and wrong here).
 */
function explicitProduction(call) {
  const status = String(call?.processing_status || '');
  if (!['processed', 'voicemail', 'spam'].includes(status)) return {};
  let ex = call.ai_extraction;
  if (typeof ex === 'string') ex = safeJson(ex);
  if (!ex || typeof ex !== 'object') ex = {};
  const out = {};
  if (typeof ex.is_lead === 'boolean') out.is_lead = ex.is_lead;
  if (status === 'spam') out.is_spam = true;
  else if (typeof ex.is_spam === 'boolean') out.is_spam = ex.is_spam;
  if (typeof ex.appointment_confirmed === 'boolean') out.appointment_agreed = ex.appointment_confirmed;
  return out;
}

/** The fields where a staff tag contradicts production: [{ field, production, staff }]. */
function staffTagCorrections(tag, production) {
  const facts = STAFF_TAG_FACTS[tag];
  if (!facts) return [];
  return Object.entries(facts)
    .filter(([field, staff]) => typeof production[field] === 'boolean' && production[field] !== staff)
    .map(([field, staff]) => ({ field, production: production[field], staff }));
}

/**
 * A staff tag on the call tab → one confirmed ai_incidents row per field the
 * tag contradicts (rule `staff_tag`; the same cells the self-audit uses, so a
 * call the two-model rule already confirmed in that cell is stored as a
 * duplicate, never counted twice). `call` is the call_log row as it stood
 * BEFORE the tag was applied. Best-effort by contract: this runs inside a
 * staff action, so it never throws and never blocks it; the gate off, or any
 * failure, records nothing. Only the FIRST staff tag on a call is compared
 * (a re-tag is a person correcting a person), and only against fields the
 * extraction explicitly answered.
 */
async function recordStaffTagCorrections({ dbi = db, call, tag, by = null, now = new Date() } = {}) {
  try {
    const { callIncidentsLive } = require('../config/feature-gates');
    if (!callIncidentsLive() || !call?.id) return { recorded: 0, skipped: 'gate_off' };
    // A call that already carries a staff tag is being RE-tagged: a person
    // correcting a person. Only staff write these values (the pipeline's own
    // dispositions use another vocabulary), so the first tag — whether or not
    // it contradicted the extraction — is the only one compared.
    if (Object.prototype.hasOwnProperty.call(STAFF_TAG_FACTS, String(call.disposition || ''))) return { recorded: 0, skipped: 'retag' };
    const corrections = staffTagCorrections(tag, explicitProduction(call));
    let recorded = 0;
    for (const c of corrections) {
      const base = {
        area: AREA,
        evidence_type: STAFF_TAG_EVIDENCE,
        evidence_id: `${call.id}:${c.field}`,
        incident_key: String(call.id),
        surface: SURFACE,
        failure_mode: failureModeFor(c.field, c.production),
        intent: null,
        prompt_version: null, // unversioned, as for audited findings (see adjudicateOne)
        produced_at: call.created_at || null,
        summary: `${c.field}: production said ${c.production}, staff tagged the call "${tag}".`,
        model: null,
        schema_version: SCHEMA_VERSION,
        adjudicated_at: now,
      };
      const adjudication = (extra = {}) => JSON.stringify({ rule: 'staff_tag', field: c.field, production: c.production, staff: { value: c.staff, tag, by }, ...extra });
      const stored = await insertIncident(dbi, base, 'confirmed_mistake', adjudication);
      if (stored) recorded += 1;
    }
    return { recorded };
  } catch (err) {
    logger.warn(`[call-incidents] staff tag capture failed for call ${String(call?.id).slice(0, 8)}: ${err.message}`);
    return { recorded: 0, error: true };
  }
}

/**
 * Sunday: fix proposals for calls. Call incidents are unversioned (see
 * adjudicateOne), so the count is the unversioned cohort, made fresh by the
 * proposal watermark: incidents adjudicated since the cell's last proposal.
 */
async function proposeCallFixes({ dbi = db, now = new Date() } = {}) {
  const { callIncidentsLive } = require('../config/feature-gates');
  if (!callIncidentsLive()) return { skipped: 'gate_off' };
  const { proposeFromIncidents } = require('./ai-incidents/fix-proposals');
  return proposeFromIncidents({
    dbi,
    area: AREA,
    promptVersion: null,
    minEvidence: envNum('CALL_FIX_PROPOSAL_MIN', 5),
    maxCells: envNum('CALL_FIX_PROPOSAL_MAX_CELLS', 3),
    now,
  });
}

module.exports = {
  AREA,
  providerForModel,
  leadWithoutReading,
  FIELDS,
  FAILURE_MODES,
  failureModeFor,
  excerptInTranscript,
  decideCallFinding,
  STAFF_TAG_FACTS,
  staffTagCorrections,
  explicitProduction,
  recordStaffTagCorrections,
  parseReaderJson,
  askSecondReader,
  adjudicateCallFindings,
  proposeCallFixes,
};
