const { containsReportAccessCode } = require('../service-report/technician-report-copy');
const { isIP } = require('node:net');
const psl = require('psl');

const EXPLICIT_LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/i;
const BARE_HOST_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;
const PHONE_URI_RE = /\b(?:tel|sms):(?:\/\/)?(?:\+?\d|\(\d)[\d()+.,;*#?=&%-]*/i;
const MARKDOWN_LINK_RE = /\[[^\]\n]+\]\(\s*(?:<[^>\n]*>|[^)\n]*)\s*\)|\[[^\]\n]+\]\[[^\]\n]*\]/i;
const MARKDOWN_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/im;
const BOILERPLATE_RE = /\bthank you for (?:reaching out|contacting us)\b|\bhope this (?:email )?finds you well\b|\bplease (?:do not|don't) hesitate to (?:reach out|contact us)\b|\blet us know if you have any (?:other |further )?questions\b/i;
// Outbound corrections can legitimately supersede preparation instructions.
// Screen prompt-control language rather than using the stricter exemplar gate.
const OUTPUT_INSTRUCTION_RE = /\b(?:system|developer)\s+(?:prompt|instructions?)\b|(?:^|\n)\s*(?:assistant|system|user)\s*:|\b(?:ignore|disregard|forget|override)\s+(?:(?:all|the|any)\s+)?(?:previous|prior|above|earlier)\s+instructions?\b|\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|these|those)\s+)?instructions?\b|\b(?:do\s+not|don't|never)\s+follow\s+(?:(?:all|any|the|these|those)\s+)?(?:(?:previous|prior|above|earlier)\s+)?instructions?\b|\b(?:ignore|disregard|forget|override)\b[^.!?]{0,80}\b(?:prompt|system|developer)\b|```/i;
// A payment or postal error identifier is not a property-access credential.
// Remove only the explicitly labeled code/value span; the shared detector
// still sees an actual gate or lockbox code elsewhere in the reply.
const NON_ACCESS_CODE_RE = /\b(?:payment|billing|invoice|transaction|postal|zip|service|error)\s+(?:error\s+)?code\b\s*(?:(?:is|was|reads?)\s+|[:=]\s*|\s+)(?=[a-z0-9]*\d)[a-z0-9]{2,12}\b|\b(?=[a-z0-9]*\d)[a-z0-9]{2,12}\b\s+(?:is|was)\s+(?:the\s+)?(?:payment|billing|invoice|transaction|postal|zip|service|error)\s+(?:error\s+)?code\b/gi;
const ACCESS_CONTEXT_RE = /\b(?:gate|door|garage|keypad|lock\s?box|entry|alarm|access|(?:enter(?:ing)?|open(?:ing)?|unlock(?:ing)?)\s+(?:the\s+|your\s+)?(?:property|premises|home|house|building))\b/i;
function normalizeCopy(text) {
  return text.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[‘’]/g, "'");
}

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/[\s\u2012-\u2015]+/).filter((word) => word && !/^[-\u2010-\u2015\u2212]+$/.test(word)).length : 0;
}

function containsUnsupportedLink(text) {
  return EXPLICIT_LINK_RE.test(text)
    || [...text.matchAll(BARE_HOST_RE)].some((match) => {
      const host = match[0].toLowerCase();
      if (isIP(host) === 4 && /^(?::\d{1,5})?\//.test(text.slice(match.index + match[0].length))) return true;
      if (!psl.isValid(host)) return false;
      // .zip is both a public suffix and an archive extension. Exempt only
      // a simple filename explicitly presented as an attachment or file.
      if (/^[a-z0-9-]+\.zip$/.test(host)
        && !/^[\/:?#]/.test(text.slice(match.index + match[0].length))
        && /\b(?:attach(?:ed)?\s+(?:the\s+)?|(?:attachment|file(?:name)?)(?:\s+(?:is|was|named))?\s+)$/i.test(text.slice(0, match.index))) return false;
      return true;
    });
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  const closing = /^(?:best|best regards|kind regards|warm regards|regards|sincerely|thanks|thank you|cheers|warmly|take care|best wishes)[,.!?]?$/i;
  const dashedName = /(?:^|\n)\s*[-–—]\s*\p{L}[\p{L}\p{M}'’.-]*(?:\s+\p{L}[\p{L}\p{M}'’.-]*){0,2}[,.]?\s*$/u;
  const [signOffLine, nameLine] = tail.split('\n');
  const namedSignOff = /^(?:all (?:the|my) best|with (?:sincere )?(?:appreciation|gratitude)|yours (?:faithfully|sincerely)|kindest regards|many thanks|warmest wishes|best wishes|take care)[,.!?]?$/i.test(signOffLine)
    && /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,3}$/u.test(nameLine || '');
  const closingAndName = closing.test(lines.at(-2) || '')
    && (/^\p{Lu}[\p{L}\p{M}'’.-]*(?: \p{Lu}[\p{L}\p{M}'’.-]*){0,3}$/u.test(lines.at(-1) || '')
      || /^\p{L}[\p{L}\p{M}'’-]*(?: \p{L}[\p{L}\p{M}'’-]*){0,3}$/u.test(lines.at(-1) || ''));
  const inlineTerminalSignOff = /(?:^|[.!?]\s+|[,;]\s+|\n)(?:best|best regards|kind regards|warm regards|regards|sincerely|thanks|cheers|warmly),\s+(?!\b(?:i|we|you|they|he|she|it|this|that)\b)(\p{L}[\p{L}\p{M}'’-]{1,31}(?:\s+\p{L}[\p{L}\p{M}'’-]{1,31}){0,2})[,.]?\s*$/iu.exec(text);
  return (lines.length > 1 && (closing.test(lines.at(-1)) || closingAndName))
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail)
    || dashedName.test(tail)
    || (lines.length > 2 && namedSignOff)
    || Boolean(inlineTerminalSignOff);
}

function greetingMatches(draft, customer) {
  const firstName = normalizeCopy(String(customer?.firstName || '')).trim();
  if (!firstName) return true;
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/-/g, '[-\\u2010-\\u2015\\u2212]');
  // Preserve the draft's word-separating dashes at the name boundary. A
  // hyphen followed by letters continues a name (Casey-Ann), not a greeting.
  const greeting = draft.normalize('NFKC').replace(/[‘’]/g, "'");
  return new RegExp(`^(?:hi|hello|hey)\\s+${escapedName}(?=$|\\r?\\n|[,!.:;\\u2012-\\u2015]|\\s+[-\\u2010-\\u2015]\\s+|[-\\u2010\\u2011](?=\\s|$))`, 'i').test(greeting);
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
  if (/<!--|<![^>]*>|<\/?[a-z][^>]*>|<\/?[a-z][^>\n]*$/im.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:(?:[-+*]|\d+[.)])\s+|•)/m.test(normalizedCopy)) violations.push('bullets_not_allowed');
  if (BOILERPLATE_RE.test(normalizedCopy.replace(/\s+/g, ' '))) violations.push('boilerplate_not_allowed');
  if (OUTPUT_INSTRUCTION_RE.test(normalizedCopy)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (containsUnsupportedLink(draft) || PHONE_URI_RE.test(draft) || MARKDOWN_LINK_RE.test(draft)
    || MARKDOWN_LINK_DEFINITION_RE.test(draft)) violations.push('link_unsupported');
  const screenedAccessCopy = accessCopy.replace(NON_ACCESS_CODE_RE, (match, offset) => {
    const sentenceBefore = accessCopy.slice(0, offset).split(/[.!?\n]/).at(-1);
    const sentenceAfter = accessCopy.slice(offset + match.length).split(/[.!?\n]/)[0];
    // Account/portal/system access is not entry to the property. Retain any
    // separate physical-access noun in the same sentence before exempting.
    const physicalContext = `${sentenceBefore} ${sentenceAfter}`
      .replace(/\b(?:account|portal|system)\s+access\b/gi, '');
    return ACCESS_CONTEXT_RE.test(physicalContext) ? match : ' ';
  });
  if (containsReportAccessCode(screenedAccessCopy)) violations.push('access_code');
  if (!greetingMatches(draft, customer)) violations.push('greeting_mismatch');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

module.exports = { verifyEmailReplyStructure, wordCount };
