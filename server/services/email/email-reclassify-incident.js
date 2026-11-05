/**
 * Staff label picks on the email Reclassify button (GATE_EMAIL_RECLASSIFY_PICK,
 * owner 2026-11-04, email learning loop step 1).
 *
 * A pick that differs from the AI's label is a human-confirmed mistake: one
 * ai_incidents row (area 'email'), the same table the call and SMS correction
 * loops use (call-incidents.js). The row holds labels, a confidence and ids
 * only: no email text, no names. Shadow data: nothing reads it at runtime and
 * nothing reaches a customer.
 */

const crypto = require('crypto');
const logger = require('../logger');
const { EMAIL_CATEGORIES } = require('./email-classifier');

const AREA = 'email';
const SURFACE = 'email_classify';
const EVIDENCE_TYPE = 'staff_reclassify';
const SCHEMA_VERSION = 'ai-incidents.v1';

function parseExtracted(email) {
  const raw = email && email.extracted_data;
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The AI's verdict on this email right now: { label, confidence }, or
 * { label: null } when no AI label is stored (never classified, or the sync's
 * known-vendor stamp 'vendor', which is not in the classifier's list). After
 * an earlier staff pick the stored label is the staff's, so the AI's own
 * verdict is read from the ai_label the pick kept in extracted_data.
 */
function aiVerdictOf(email) {
  const extracted = parseExtracted(email);
  const staffOnRow = extracted.staff_label === true;
  const label = staffOnRow ? extracted.ai_label : email.classification;
  const confidence = staffOnRow ? extracted.ai_confidence : email.classification_confidence;
  return {
    label: EMAIL_CATEGORIES.includes(label) ? label : null,
    confidence: Number.isFinite(Number(confidence)) && confidence !== null ? Number(confidence) : null,
  };
}

/**
 * The classification a staff pick stores and hands to the auto-action: the
 * AI's extracted entities are kept (the lead handler reads them), the label is
 * the pick, confidence is 1 (a person decided), and the AI's verdict is kept
 * beside it so a later pick can still tell what the AI said.
 */
function staffClassification(email, pick, verdict) {
  const { staff_label: _s, ai_label: _l, ai_confidence: _c, ...kept } = parseExtracted(email);
  return {
    ...kept,
    category: pick,
    confidence: 1,
    staff_label: true,
    ai_label: verdict.label,
    ai_confidence: verdict.confidence,
  };
}

/**
 * Store the incident for one pick. Never throws: a failed insert is logged
 * and the reclassify carries on. Returns 'inserted', 'same_label', 'no_ai_label'
 * or 'failed'.
 */
async function recordStaffReclassify({ dbi, email, verdict, pick, staffUserId }) {
  if (!verdict.label) return 'no_ai_label';
  if (verdict.label === pick) return 'same_label';
  try {
    await dbi('ai_incidents').insert({
      area: AREA,
      evidence_type: EVIDENCE_TYPE,
      // One row per pick; the confirmed-per-cell unique index keeps one
      // incident from counting twice.
      evidence_id: crypto.randomUUID(),
      incident_key: `email:${email.id}:classification`,
      disposition: 'confirmed_mistake',
      surface: SURFACE,
      failure_mode: `${verdict.label}_should_be_${pick}`,
      intent: null,
      // The email prompt is unversioned; the row does not record the model.
      prompt_version: null,
      model: null,
      produced_at: email.received_at || null,
      summary: `email_classify: the AI said ${verdict.label}, staff picked ${pick}.`,
      adjudication: JSON.stringify({
        rule: 'staff_label',
        ai_label: verdict.label,
        staff_label: pick,
        ai_confidence: verdict.confidence,
        staff_user_id: staffUserId || null,
      }),
      schema_version: SCHEMA_VERSION,
      adjudicated_at: new Date(),
    });
    return 'inserted';
  } catch (err) {
    // 23505: this email already has this exact mistake on file.
    logger.warn(`[email-reclassify] incident not stored for email ${email.id}: ${err.message}`);
    return 'failed';
  }
}

module.exports = { AREA, SURFACE, EVIDENCE_TYPE, aiVerdictOf, staffClassification, recordStaffReclassify };
