const { exemplarLooksClean } = require('../sms-shadow-drafter');
const { containsReportAccessCode } = require('../service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');

const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/i;
const PHONE_URI_RE = /\b(?:tel|sms):(?:\/\/)?(?:\+?\d|\(\d)[\d()+.,;*#?=&%-]*/i;
const MARKDOWN_LINK_RE = /\[[^\]\n]+\]\(\s*(?:<[^>\n]*>|[^)\n]*)\s*\)|\[[^\]\n]+\]\[[^\]\n]*\]/i;
const MARKDOWN_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/im;
const BOILERPLATE_RE = /\bthank you for (?:reaching out|contacting us)\b|\bhope this (?:email )?finds you well\b|\bplease (?:do not|don't) hesitate to (?:reach out|contact us)\b|\blet us know if you have any (?:other |further )?questions\b/i;
// Allow modifiers such as "scheduled pest-control", but do not absorb an
// approved application unit into a later, unrelated mention of a visit.
const VISIT_SRC = '(?:(?!applications?\\b)[a-z]+(?:-[a-z]+)*\\s+){0,3}visit\\b';
const VISIT_UNIT_SRC = `(?:each|every|a)\\s+${VISIT_SRC}`;
const PRICE_UNIT_SRC = `(?:(?:for\\s+)?${VISIT_UNIT_SRC}|per[\\s-]+${VISIT_SRC}|/\\s*${VISIT_SRC})`;
const VISIT_PRICE_RE = new RegExp([
  '\\bper[\\s-]+visit\\b',
  `(?:\\$\\s*\\d[\\d,.]*|\\b\\d[\\d,.]*\\s+dollars?)\\s*${PRICE_UNIT_SRC}`,
  `\\b(?:price|amount|cost|charge|rate)\\s+${PRICE_UNIT_SRC}`,
  `\\b${VISIT_UNIT_SRC}\\s+(?:costs?|is|will\\s+(?:cost|be))\\s+\\$\\s*\\d`,
].join('|'), 'i');

function normalizeCopy(text) {
  return text.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[‘’]/g, "'");
}

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  const closing = /^(?:best|best regards|kind regards|warm regards|regards|sincerely|thanks|thank you|cheers|warmly)[,.]?$/i;
  const dashedName = /(?:^|\n)\s*[-–—]\s*\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,2}[,.]?\s*$/u;
  return lines.slice(1).some((line) => closing.test(line))
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail)
    || dashedName.test(tail);
}

function greetingMatches(draft, customer) {
  const firstName = normalizeCopy(String(customer?.firstName || '')).trim();
  if (!firstName) return true;
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:hi|hello|hey)\\s+${escapedName}(?=$|[\\s,!.:;-])`, 'i').test(normalizeCopy(draft));
}

function customerCopyViolation(draft, normalizedCopy) {
  return findBannedCustomerCopy(normalizedCopy).length > 0
    || VISIT_PRICE_RE.test(normalizedCopy)
    || /\bWaves\s+Lawn\s*(?:&|and)\s*Pest\b/i.test(normalizedCopy)
    || !!reentrySafetyClaimFinding(draft);
}

// This slice validates presentation and customer-copy rules only. Success does
// not establish that any amount, date, status, or other factual claim is true.
function verifyEmailReplyStructure({ text, customer, wordBudget } = {}) {
  const draft = String(text || '').trim();
  const normalizedCopy = normalizeCopy(draft);
  // Fold compatibility digits without joining a mixed fraction's numerator
  // to its whole number (NFKC turns "10½" into "101⁄2").
  const accessCopy = draft.replace(/\p{N}/gu, (number) => {
    const digits = number.normalize('NFKC');
    return /^\d+$/.test(digits) ? digits : number;
  });
  const violations = [];

  if (!draft) violations.push('empty_reply');
  if (!Number.isInteger(wordBudget) || wordBudget < 1 || wordCount(draft) > wordBudget) violations.push('word_budget_exceeded');
  if (/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>/i.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:[-+*•]|\d+[.)])\s+/m.test(normalizedCopy)) violations.push('bullets_not_allowed');
  if (BOILERPLATE_RE.test(normalizedCopy.replace(/\s+/g, ' '))) violations.push('boilerplate_not_allowed');
  if (!exemplarLooksClean('', draft)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (LINK_RE.test(draft) || PHONE_URI_RE.test(draft) || MARKDOWN_LINK_RE.test(draft)
    || MARKDOWN_LINK_DEFINITION_RE.test(draft)) violations.push('link_unsupported');
  if (containsReportAccessCode(accessCopy)) violations.push('access_code');
  if (customerCopyViolation(draft, normalizedCopy)) violations.push('customer_copy_compliance');
  if (!greetingMatches(draft, customer)) violations.push('greeting_mismatch');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

module.exports = { verifyEmailReplyStructure, wordCount };
