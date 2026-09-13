const { exemplarLooksClean } = require('../sms-shadow-drafter');
const { containsReportAccessCode } = require('../service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');

const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/i;
const PHONE_URI_RE = /\b(?:tel|sms):(?:\/\/)?(?:\+?\d|\(\d)[\d()+.,;*#?=&%-]*/i;
const BOILERPLATE_RE = /\bthank you for (?:reaching out|contacting us)\b|\bhope this (?:email )?finds you well\b|\bplease (?:do not|don't) hesitate to (?:reach out|contact us)\b|\blet us know if you have any (?:other |further )?questions\b/i;

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  return lines.slice(1).some((line) => /^(?:best|best regards|kind regards|regards|sincerely|thanks|thank you)[,.]?$/i.test(line))
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail);
}

function greetingMatches(draft, customer) {
  const firstName = String(customer?.firstName || '').normalize('NFC').trim();
  if (!firstName) return true;
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:hi|hello|hey)\\s+${escapedName}(?=$|[\\s,!.:;—–-])`, 'i').test(draft.normalize('NFC'));
}

function customerCopyViolation(draft, normalizedCopy) {
  return findBannedCustomerCopy(draft).length > 0
    || /\bper[\s-]+visit\b|\bWaves\s+Lawn\s*(?:&|and)\s*Pest\b/i.test(normalizedCopy)
    || !!reentrySafetyClaimFinding(draft);
}

// This slice validates presentation and customer-copy rules only. Success does
// not establish that any amount, date, status, or other factual claim is true.
function verifyEmailReplyStructure({ text, customer, wordBudget } = {}) {
  const draft = String(text || '').trim();
  const normalizedCopy = draft.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
  const violations = [];

  if (!draft) violations.push('empty_reply');
  if (!Number.isInteger(wordBudget) || wordBudget < 1 || wordCount(draft) > wordBudget) violations.push('word_budget_exceeded');
  if (/<\/?[a-z][^>]*>/i.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:[-*•]|\d+[.)])\s+/m.test(normalizedCopy)) violations.push('bullets_not_allowed');
  if (BOILERPLATE_RE.test(draft)) violations.push('boilerplate_not_allowed');
  if (!exemplarLooksClean('', draft)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (LINK_RE.test(draft) || PHONE_URI_RE.test(draft)) violations.push('link_unsupported');
  if (containsReportAccessCode(draft)) violations.push('access_code');
  if (customerCopyViolation(draft, normalizedCopy)) violations.push('customer_copy_compliance');
  if (!greetingMatches(draft, customer)) violations.push('greeting_mismatch');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

module.exports = { verifyEmailReplyStructure, wordCount };
