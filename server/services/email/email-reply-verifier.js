const { containsReportAccessCode } = require('../service-report/technician-report-copy');

const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/i;
const PHONE_URI_RE = /\b(?:tel|sms):(?:\/\/)?(?:\+?\d|\(\d)[\d()+.,;*#?=&%-]*/i;
const MARKDOWN_LINK_RE = /\[[^\]\n]+\]\(\s*(?:<[^>\n]*>|[^)\n]*)\s*\)|\[[^\]\n]+\]\[[^\]\n]*\]/i;
const MARKDOWN_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/im;
const BOILERPLATE_RE = /\bthank you for (?:reaching out|contacting us)\b|\bhope this (?:email )?finds you well\b|\bplease (?:do not|don't) hesitate to (?:reach out|contact us)\b|\blet us know if you have any (?:other |further )?questions\b/i;
// Outbound corrections can legitimately supersede preparation instructions.
// Screen prompt-control language rather than using the stricter exemplar gate.
const OUTPUT_INSTRUCTION_RE = /\b(?:system|developer)\s+(?:prompt|instructions?)\b|(?:^|\n)\s*(?:assistant|system|user)\s*:|\b(?:ignore|disregard|forget|override)\s+(?:(?:all|the|any)\s+)?(?:previous|prior|above|earlier)\s+instructions?\b|\b(?:ignore|disregard|forget|override)\b[^.!?]{0,80}\b(?:prompt|system|developer)\b|```/i;
function normalizeCopy(text) {
  return text.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[‘’]/g, "'");
}

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/[\s\u2012-\u2015]+/).filter(Boolean).length : 0;
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  const closing = /^(?:best|best regards|kind regards|warm regards|regards|sincerely|thanks|thank you|cheers|warmly|take care|best wishes)[,.!?]?$/i;
  const dashedName = /(?:^|\n)\s*[-–—]\s*\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,2}[,.]?\s*$/u;
  const signOffAndName = /^[\p{L}\p{M}'’ -]*\b(?:best|regards|thanks|appreciation|gratitude|faithfully|sincerely|cheers|warmly|care|wishes),\n\p{Lu}[\p{L}\p{M}'’.-]*(?: \p{Lu}[\p{L}\p{M}'’.-]*){0,3}$/u;
  return lines.slice(1).some((line) => closing.test(line))
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail)
    || dashedName.test(tail)
    || (lines.length > 2 && signOffAndName.test(tail));
}

function greetingMatches(draft, customer) {
  const firstName = normalizeCopy(String(customer?.firstName || '')).trim();
  if (!firstName) return true;
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/-/g, '[-\\u2010-\\u2015\\u2212]');
  // Preserve the draft's word-separating dashes at the name boundary. A
  // hyphen followed by letters continues a name (Casey-Ann), not a greeting.
  const greeting = draft.normalize('NFKC').replace(/[‘’]/g, "'");
  return new RegExp(`^(?:hi|hello|hey)\\s+${escapedName}(?=$|[\\s,!.:;\\u2012-\\u2015]|[-\\u2010\\u2011](?=\\s|$))`, 'i').test(greeting);
}

// Presentation checks only: success does not establish factual accuracy,
// customer-copy compliance, or authorization to create/send a draft.
function verifyEmailReplyStructure({ text, customer, wordBudget } = {}) {
  const draft = String(text || '').trim();
  const normalizedCopy = normalizeCopy(draft);
  // Fold compatibility characters without joining a mixed fraction's numerator
  // to its whole number (NFKC turns "10½" into "101⁄2").
  const accessCopy = [...draft].map((character) => {
    const folded = normalizeCopy(character);
    return folded.includes('⁄') ? character : folded;
  }).join('');
  const violations = [];

  if (!draft) violations.push('empty_reply');
  if (!Number.isInteger(wordBudget) || wordBudget < 1 || wordCount(draft) > wordBudget) violations.push('word_budget_exceeded');
  if (/<!--|<![^>]*>|<\/?[a-z][^>]*>/i.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:[-+*•]|\d+[.)])\s+/m.test(normalizedCopy)) violations.push('bullets_not_allowed');
  if (BOILERPLATE_RE.test(normalizedCopy.replace(/\s+/g, ' '))) violations.push('boilerplate_not_allowed');
  if (OUTPUT_INSTRUCTION_RE.test(normalizedCopy)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (LINK_RE.test(draft) || PHONE_URI_RE.test(draft) || MARKDOWN_LINK_RE.test(draft)
    || MARKDOWN_LINK_DEFINITION_RE.test(draft)) violations.push('link_unsupported');
  if (containsReportAccessCode(accessCopy)) violations.push('access_code');
  if (!greetingMatches(draft, customer)) violations.push('greeting_mismatch');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

module.exports = { verifyEmailReplyStructure, wordCount };
