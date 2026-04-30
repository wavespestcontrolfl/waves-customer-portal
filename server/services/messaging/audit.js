/**
 * messaging_audit_log writer.
 *
 * Every send attempt — sent or blocked — is recorded here. Bodies are
 * NEVER stored in full; only:
 *   - sha256(body) for forensic comparison
 *   - first 240 chars as a preview (matches existing sms_log retention)
 * Recipient phone is not stored in plaintext either:
 *   - sha256(E.164 phone)
 *   - last 4 digits as a debugging hint
 *
 * The audit insert is best-effort — a failure here MUST NOT block the
 * actual send. We log a warning and continue.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function last4(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-4);
}

function preview(body, n = 240) {
  if (!body) return null;
  const s = String(body);
  return s.length <= n ? s : s.slice(0, n);
}

/**
 * Persist a send attempt to messaging_audit_log.
 *
 * @returns {Promise<{ id: string | null }>}
 */
async function persistAudit(record) {
  const { input, segmentMeta, validatorsPassed, validatorsFailed, blockedBy, identityTrust, providerOutcome } = record;

  const row = {
    to_hash: sha256(input.to),
    to_last4: last4(input.to),

    customer_id: input.customerId || null,
    lead_id: input.leadId || null,
    invoice_id: input.invoiceId || null,
    estimate_id: input.estimateId || null,
    appointment_id: input.appointmentId || null,

    audience: input.audience,
    purpose: input.purpose,
    channel: input.channel,
    entry_point: input.entryPoint || null,
    identity_trust_level: identityTrust || input.identityTrustLevel || null,

    body_hash: sha256(input.body),
    body_preview: preview(input.body),
    segment_count: segmentMeta ? segmentMeta.segmentCount : null,
    encoding: segmentMeta ? segmentMeta.encoding : null,

    consent_status: input.consentBasis ? input.consentBasis.status : null,
    consent_source: input.consentBasis ? input.consentBasis.source : null,
    consent_campaign: input.consentBasis ? input.consentBasis.campaign : null,

    validators_passed: validatorsPassed || [],
    validators_failed: validatorsFailed || [],
    blocked_code: blockedBy ? blockedBy.code : null,
    blocked_reason: blockedBy ? blockedBy.reason : null,

    provider: providerOutcome ? providerOutcome.provider : null,
    provider_message_id: providerOutcome ? providerOutcome.providerMessageId : null,
    sent_at: providerOutcome && providerOutcome.sentAt ? new Date(providerOutcome.sentAt) : null,
    provider_error: providerOutcome ? providerOutcome.error : null,

    metadata: input.metadata || null,
  };

  try {
    const [result] = await db('messaging_audit_log').insert(row).returning('id');
    return { id: result && result.id ? result.id : result || null };
  } catch (err) {
    if (err && /relation .* does not exist|messaging_audit_log/i.test(err.message)) {
      // Migration not yet applied. The wrapper proceeds without an audit row.
      return { id: null };
    }
    logger.warn(`[messaging:audit] persist failed: ${err.message}`);
    return { id: null };
  }
}

module.exports = {
  persistAudit,
  // Exposed for tests
  _internals: { sha256, last4, preview },
};
