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
const TRANSCRIPT_CHARS = 5000; // what the auditor was shown
const MIN_EXCERPT_CHARS = 12;
const LOOKBACK_DAYS = 14;
// finding id + 12 hex of md5(what the finding says): production's value, the
// auditor's value, the auditor's model and the snapshotted extraction version.
const EVIDENCE_KEY_SQL = "(f.id)::text || ':' || left(md5(coalesce(f.old_value, '') || '|' || coalesce(f.new_value, '') || '|' || coalesce((f.detail::jsonb) ->> 'auditor_model', '') || '|' || coalesce((f.detail::jsonb) ->> 'extraction_prompt_version', '')), 12)";

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
 * parsed JSON (null = answered but unusable).
 */
function decideCallFinding({ field, auditorValue, auditorExcerpt, second, transcript }) {
  const auditorExcerptVerified = excerptInTranscript(auditorExcerpt, transcript);
  const secondValue = second && typeof second[field] === 'boolean' ? second[field] : null;
  const secondExcerptVerified = Boolean(second) && excerptInTranscript(second.excerpt, transcript);
  const verdict = { auditorExcerptVerified, secondValue, secondExcerptVerified };
  if (secondValue === null) return { disposition: 'lead', rule: 'second_unusable', ...verdict };
  if (secondValue !== auditorValue) return { disposition: 'lead', rule: 'second_sides_with_production', ...verdict };
  if (!auditorExcerptVerified || !secondExcerptVerified) return { disposition: 'lead', rule: 'excerpt_unverified', ...verdict };
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
  const { dispatchWithFallback } = require('./llm/call');
  const MODELS = require('../config/models');
  const { AUDIT_PROMPT, callDirectionBlock } = require('./call-self-audit');
  const policy = MODELS.TEXT_POLICIES.fastStructured;
  const leg = [policy.primary, policy.fallback].find((l) => l && l.provider !== auditorProvider);
  if (!leg) return { ok: false, reason: 'no_other_provider_leg' };
  const routed = await dispatchWithFallback(
    { name: policy.name, primary: leg },
    {
      laneId: 'call_incidents',
      system: AUDIT_PROMPT,
      text: `${callDirectionBlock(call.direction)}\nTranscript:\n${String(call.transcription || '').slice(0, TRANSCRIPT_CHARS)}`,
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
 *   auditor_provider_unknown — a second reader could share its provider;
 *   transcript_truncated — the call is longer than both readers are shown,
 *     so the disagreement may sit in the part neither read.
 */
function leadWithoutReading({ row, detail, auditorProvider, auditorValue }) {
  if (detail?.verdict?.[row.field] !== auditorValue) return 'auditor_value_missing';
  if (!auditorProvider) return 'auditor_provider_unknown';
  if (String(row.transcription || '').length > TRANSCRIPT_CHARS) return 'transcript_truncated';
  return null;
}

const isUniqueViolation = (err) => err && err.code === '23505';
const safeJson = (t) => {
  try { return JSON.parse(t) || {}; } catch { return {}; }
};

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
  const auditorProvider = providerForModel(detail.auditor_model);
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
    // The version production's answers came from at audit time (missing on
    // findings written before the snapshot existed: unversioned).
    prompt_version: detail.extraction_prompt_version ? String(detail.extraction_prompt_version).slice(0, 40) : null,
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
  let disposition = decision.disposition;
  try {
    await dbi('ai_incidents').insert({ ...base, disposition, adjudication: adjudication() });
  } catch (err) {
    // One confirmed row per (call, cell): a second finding about the same
    // call and field is kept as a duplicate, never counted twice.
    if (!(isUniqueViolation(err) && disposition === 'confirmed_mistake')) throw err;
    disposition = 'duplicate';
    await dbi('ai_incidents')
      .insert({ ...base, disposition, adjudication: adjudication({ duplicate_of_confirmed: true }) })
      .onConflict(['area', 'evidence_type', 'evidence_id'])
      .ignore();
  }
  return disposition;
}

/**
 * Nightly: every self-audit finding from the last LOOKBACK_DAYS not yet
 * adjudicated becomes ONE ai_incidents row (idempotent: anti-join + the
 * evidence key). Attribution is by when the CALL happened and the extraction
 * prompt version it was processed under.
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
    .orderBy('f.created_at', 'asc')
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

/**
 * Sunday: fix proposals for calls, counted on the extraction prompt version
 * most recent calls were processed under (the live version).
 */
async function proposeCallFixes({ dbi = db, now = new Date() } = {}) {
  const { callIncidentsLive } = require('../config/feature-gates');
  if (!callIncidentsLive()) return { skipped: 'gate_off' };
  const latest = await dbi('call_log')
    .whereNotNull('ai_extraction_prompt_version')
    .where('created_at', '>=', new Date(now.getTime() - 7 * 86400 * 1000))
    .orderBy('created_at', 'desc')
    .first('ai_extraction_prompt_version');
  if (!latest) return { proposed: 0, skipped: 'no_recent_version' };
  const { proposeFromIncidents } = require('./ai-incidents/fix-proposals');
  return proposeFromIncidents({
    dbi,
    area: AREA,
    promptVersion: String(latest.ai_extraction_prompt_version).slice(0, 40),
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
  parseReaderJson,
  askSecondReader,
  adjudicateCallFindings,
  proposeCallFixes,
};
