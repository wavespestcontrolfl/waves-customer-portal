const crypto = require('crypto');
const db = require('../../models/db');

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(phone).startsWith('+') ? String(phone) : null;
}

function phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone || ''), 'utf8').digest('hex');
}

function isSmsMobileLineType(lineType) {
  if (!lineType) return true;
  return /^(mobile|wireless)$/i.test(String(lineType).trim());
}

async function latestContactCheck(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  try {
    return await db('sms_contact_compliance_checks')
      .where({ phone_hash: phoneHash(normalized) })
      .orderBy('checked_at', 'desc')
      .first();
  } catch (err) {
    if (/does not exist|sms_contact_compliance_checks/i.test(err.message)) return null;
    throw err;
  }
}

async function checkContactCompliance(input, policy) {
  if (!input || input.channel !== 'sms') return { ok: true };
  if (policy?.requireConsent !== 'marketing') return { ok: true };

  const latest = await latestContactCheck(input.to);
  if (!latest) return { ok: true };
  if (latest.dnc_listed === true) {
    return {
      ok: false,
      code: 'DNC_SUPPRESSED',
      reason: 'Latest SMS contact compliance check marks this phone as DNC-listed.',
    };
  }
  if (latest.reassigned_risk === true) {
    return {
      ok: false,
      code: 'REASSIGNED_NUMBER_RISK',
      reason: 'Latest SMS contact compliance check marks this phone as reassigned-risk.',
    };
  }
  if (!isSmsMobileLineType(latest.line_type)) {
    return {
      ok: false,
      code: 'NON_MOBILE_SMS_RECIPIENT',
      reason: `Latest SMS contact compliance check returned line_type=${latest.line_type}.`,
    };
  }
  return { ok: true };
}

module.exports = {
  normalizePhone,
  phoneHash,
  isSmsMobileLineType,
  latestContactCheck,
  checkContactCompliance,
};
