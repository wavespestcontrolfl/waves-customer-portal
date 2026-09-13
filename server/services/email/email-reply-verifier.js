const { exemplarLooksClean } = require('../sms-shadow-drafter');
const { containsReportAccessCode } = require('../service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');
const { etParts, addETDays } = require('../../utils/datetime-et');

const PLACEHOLDER_RE = /\[([a-z][a-z0-9_ -]{0,30})\]|\{\{?([a-z][a-z0-9_ -]{0,30})\}?\}/gi;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/gi;
const MONEY_RE = /\$\s*\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s+(?:dollars?|bucks?)\b/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b|\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat)(?:day)?\b|\b(?:today|tomorrow)\b/gi;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi;
const TIME_RANGE_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:[-–—]|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
const BOILERPLATE_RE = /\bthank you for (?:reaching out|contacting us)\b|\bhope this (?:email )?finds you well\b|\bplease (?:do not|don't) hesitate to (?:reach out|contact us)\b|\blet us know if you have any (?:other |further )?questions\b/i;
const SUCCESS_STATUS_RE = /^(?:paid|succeeded|successful|completed|processed|received)$/i;

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function presentFacts(context) {
  return Array.isArray(context?.facts) ? context.facts.filter((fact) => fact?.status === 'present') : [];
}

function cents(value) {
  const number = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function amountsForFact(fact) {
  const byKey = {
    outstanding_balance: [fact.value],
    open_invoice: [fact.value?.amountDue],
    recent_payment: [fact.value?.amount],
    billing_lane: [fact.value?.monthlyDues?.base, fact.value?.monthlyDues?.surcharge, fact.value?.monthlyDues?.total],
  };
  const values = [];
  for (const value of byKey[fact.key] || []) {
    if ((typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(String(value).trim()))
      && Number.isFinite(Number(value))) values.push(Math.round(Number(value) * 100));
  }
  return values;
}

function billingAmountField(raw, sentence) {
  const index = sentence.toLowerCase().indexOf(raw.toLowerCase());
  if (index < 0) return 'total';
  const left = sentence.slice(Math.max(0, index - 28), index).replace(/^.*\$/s, '');
  const right = sentence.slice(index + raw.length, index + raw.length + 28).replace(/\$.*$/s, '');
  const nearby = `${left} ${right}`;
  if (/\b(?:surcharge|card fee)\b/i.test(nearby)) return 'surcharge';
  if (/\b(?:total|monthly charge)\b/i.test(nearby)) return 'total';
  return 'base';
}

function amountsForClaim(fact, raw, sentence) {
  if (fact.key !== 'billing_lane') return amountsForFact(fact);
  const field = billingAmountField(raw, sentence);
  return amountsForFact({ key: fact.key, value: { monthlyDues: { [field]: fact.value?.monthlyDues?.[field] } } });
}

function semanticFactKeys(sentence) {
  const text = sentence.toLowerCase();
  if (/\b(?:balance|outstanding|account current)\b/.test(text)) return ['outstanding_balance'];
  if (/\b(?:payment|paid|went through|received)\b/.test(text)) return ['recent_payment'];
  if (/\b(?:invoice|amount due)\b/.test(text)) return ['open_invoice'];
  if (/\b(?:monthly|dues|surcharge|card fee)\b/.test(text)) return ['billing_lane'];
  return [];
}

function amountSupported(raw, sentence, facts) {
  const amount = cents(raw);
  const keys = semanticFactKeys(sentence);
  if (amount == null || !keys.length) return false;
  return facts.some((fact) => keys.includes(fact.key) && amountsForClaim(fact, raw, sentence).includes(amount));
}

function calendarDay(value) {
  const raw = String(value || '');
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
  if (!day) return null;
  if (raw.length === 10) return day;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = etParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dateAliases(day, assembledAt) {
  const [year, month, date] = day.split('-').map(Number);
  const instant = new Date(Date.UTC(year, month - 1, date, 12));
  const monthLong = instant.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  const monthShort = instant.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toLowerCase();
  const weekday = instant.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
  const aliases = new Set([
    day, `${month}/${date}`, `${month}/${date}/${year}`, `${month}/${date}/${String(year).slice(-2)}`,
    `${monthLong} ${date}`, `${monthLong} ${date}, ${year}`, `${monthShort} ${date}`, weekday, weekday.slice(0, 3),
  ]);
  const assembled = assembledAt ? new Date(assembledAt) : null;
  if (assembled && Number.isFinite(assembled.getTime())) {
    const parts = etParts(assembled);
    const today = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const tomorrowParts = etParts(addETDays(assembled, 1));
    const tomorrow = `${tomorrowParts.year}-${String(tomorrowParts.month).padStart(2, '0')}-${String(tomorrowParts.day).padStart(2, '0')}`;
    if (day === today) aliases.add('today');
    if (day === tomorrow) aliases.add('tomorrow');
  }
  return aliases;
}

function dateFacts(context) {
  const result = [];
  for (const fact of presentFacts(context)) {
    const aliases = new Set();
    const ranges = [];
    const values = {
      open_invoice: [fact.value?.dueDate],
      recent_payment: [fact.value?.paymentDate],
      upcoming_visit: [fact.value?.date, fact.value?.window],
      last_completed_visit: [fact.value?.date],
      pending_estimate: [fact.value?.sentAt],
    }[fact.key] || [];
    for (const value of values) {
      const day = calendarDay(value);
      if (day) dateAliases(day, context?.metadata?.assembledAt).forEach((alias) => aliases.add(alias));
      temporalClaims(value).forEach((claim) => aliases.add(normalizeTemporal(claim)));
      ranges.push(...timeRanges(value));
    }
    if (aliases.size) result.push({ key: fact.key, aliases, ranges, fact });
  }
  return result;
}

function normalizeTemporal(value) {
  const normalized = String(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(normalized);
  if (!clock) return normalized;
  return `${Number(clock[1])}${Number(clock[2]) ? `:${clock[2]}` : ''} ${clock[3]}`;
}

function temporalClaims(value) {
  const raw = String(value || '');
  const claims = [...(raw.match(DATE_RE) || []), ...(raw.match(TIME_RE) || [])];
  for (const range of timeRanges(raw)) {
    claims.push(...range.map((clock) => clock.replace(/\b(am|pm)\b/g, (meridiem) => meridiem.toUpperCase())));
  }
  return [...new Map(claims.map((claim) => [normalizeTemporal(claim), claim])).values()];
}

function timeRanges(value) {
  const ranges = [];
  for (const match of String(value || '').matchAll(TIME_RANGE_RE)) {
    const firstMeridiem = match[3] || match[6];
    ranges.push([
      normalizeTemporal(`${match[1]}${match[2] ? `:${match[2]}` : ''} ${firstMeridiem}`),
      normalizeTemporal(`${match[4]}${match[5] ? `:${match[5]}` : ''} ${match[6]}`),
    ]);
  }
  return ranges;
}

function dateSemanticKeys(sentence) {
  if (/\b(?:payment|paid)\b/i.test(sentence)) return ['recent_payment'];
  if (/\b(?:invoice|due)\b/i.test(sentence)) return ['open_invoice'];
  if (/\bestimate\b/i.test(sentence)) return ['pending_estimate'];
  if (/\b(?:last|previous|completed|was serviced|came out)\b/i.test(sentence)) return ['last_completed_visit'];
  if (/\b(?:visit|service|appointment|scheduled|coming|arriv)\w*\b/i.test(sentence)) return ['upcoming_visit'];
  return [];
}

function dateSupported(raw, sentence, available) {
  const normalized = normalizeTemporal(raw);
  const keys = dateSemanticKeys(sentence);
  return keys.length > 0 && available.some((entry) => keys.includes(entry.key)
    && [...entry.aliases].some((alias) => normalizeTemporal(alias) === normalized));
}

function factByKey(context, key) {
  return (context?.facts || []).find((fact) => fact?.key === key) || null;
}

function factsMatchingClaims(sentence, key, context) {
  let candidates = presentFacts(context).filter((fact) => fact.key === key);
  const amounts = sentence.match(MONEY_RE) || [];
  if (amounts.length) {
    candidates = candidates.filter((fact) => amounts.every((amount) => amountsForClaim(fact, amount, sentence).includes(cents(amount))));
  }
  const dates = temporalClaims(sentence);
  if (dates.length) {
    const entries = dateFacts(context).filter((entry) => entry.key === key && candidates.includes(entry.fact));
    candidates = candidates.filter((fact) => dates.every((raw) => {
      const normalized = normalizeTemporal(raw);
      return entries.some((entry) => entry.fact === fact && [...entry.aliases]
        .some((alias) => normalizeTemporal(alias) === normalized));
    }));
    const ranges = timeRanges(sentence);
    candidates = candidates.filter((fact) => ranges.every((range) => entries.some((entry) => entry.fact === fact
      && entry.ranges.some((sourceRange) => sourceRange[0] === range[0] && sourceRange[1] === range[1]))));
  }
  return candidates;
}

function hasSameFactBinding(sentence, context) {
  const amounts = sentence.match(MONEY_RE) || [];
  const dates = temporalClaims(sentence);
  if (amounts.length + dates.length < 2 && !timeRanges(sentence).length) return true;
  const amountKeys = amounts.length ? semanticFactKeys(sentence) : null;
  const dateKeys = dates.length ? dateSemanticKeys(sentence) : null;
  const keys = (amountKeys || dateKeys || []).filter((key) => !amountKeys || !dateKeys || dateKeys.includes(key));
  return keys.some((key) => factsMatchingClaims(sentence, key, context).length > 0);
}

function statusSupported(sentence, key, context, predicate) {
  const candidates = factsMatchingClaims(sentence, key, context);
  return candidates.length > 0 && candidates.every(predicate);
}

function statusViolations(text, context) {
  const violations = [];
  for (const sentence of sentences(text)) {
    if (/\b(?:not|never|no longer|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|didn['’]t|cannot|can['’]t)\b/i.test(sentence)
      && /\b(?:payment|paid|visit|service|appointment|estimate)\b/i.test(sentence)) violations.push('negated_status_unsupported');
    if (/\b(?:payment|paid)\b/i.test(sentence)
      && /\b(?:received|processed|successful|succeeded|paid|went through)\b/i.test(sentence)
      && !statusSupported(sentence, 'recent_payment', context,
        (fact) => SUCCESS_STATUS_RE.test(String(fact.value?.status || '')))) violations.push('payment_status_unsupported');

    if (/\b(?:visit|service|appointment)\b[^.!?]{0,60}\b(?:confirmed|booked|all set)\b|\b(?:confirmed|booked)\b[^.!?]{0,60}\b(?:visit|service|appointment)\b/i.test(sentence)
      && !statusSupported(sentence, 'upcoming_visit', context,
        (fact) => String(fact.value?.status).toLowerCase() === 'confirmed')) violations.push('visit_status_unsupported');

    if (/\bestimate\b[^.!?]{0,40}\b(?:sent|emailed)\b|\b(?:sent|emailed)\b[^.!?]{0,40}\bestimate\b/i.test(sentence)
      && !statusSupported(sentence, 'pending_estimate', context,
        (fact) => /^(?:sent|viewed)$/i.test(String(fact.value?.status || '')) && fact.value?.sentAt)) violations.push('estimate_status_unsupported');
  }

  const balance = factByKey(context, 'outstanding_balance');
  if (/\b(?:paid in full|no (?:outstanding )?balance|balance is (?:zero|current)|account is current)\b/i.test(text)
    && !(balance?.status === 'present' && Number(balance.value) === 0)) violations.push('balance_status_unsupported');
  return violations;
}

function placeholderViolations(text, context) {
  const mappings = {
    date: ['upcoming_visits'], day: ['upcoming_visits'], time: ['upcoming_visits'], window: ['upcoming_visits'],
    visit: ['upcoming_visits'], appointment: ['upcoming_visits'], tech: ['upcoming_visits'], technician: ['upcoming_visits'],
    estimate: ['pending_estimate'], invoice: ['open_invoice'], payment: ['recent_payments'],
    balance: ['outstanding_balance'], amount: ['outstanding_balance'], name: ['customer'], phone: [], email: [], address: [], redacted: [],
  };
  const violations = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const token = String(match[1] || match[2]).trim().toLowerCase().replace(/\s+/g, '_');
    const keys = mappings[token];
    if (!keys?.length || !keys.some((key) => factByKey(context, key)?.status === 'absent')) violations.push(`placeholder_unsupported:${token}`);
  }
  return violations;
}

function allowedLinks(context) {
  // The v1 assembler exposes no authoritative customer-facing URL fact.
  void context;
  return new Set();
}

function exemplarLeak(text, exemplars, context) {
  const facts = presentFacts(context);
  const dates = dateFacts(context);
  const factLike = /\$\s*\d[\d,.]*|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b|\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat)(?:day)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\[[a-z_]+\]/gi;
  return (exemplars || []).some((example) => (String(example?.reply_text || '').match(factLike) || [])
    .some((value) => {
      if (!text.toLowerCase().includes(value.toLowerCase())) return false;
      if (value.trim().startsWith('$') && facts.some((fact) => amountsForFact(fact).includes(cents(value)))) return false;
      const normalized = normalizeTemporal(value);
      return !dates.some((entry) => [...entry.aliases]
        .some((alias) => normalizeTemporal(alias) === normalized));
    }));
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  return /^(?:best|best regards|kind regards|regards|sincerely|thanks|thank you)[,.]?(?:\n.+)?$/i.test(tail)
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail);
}

function sentences(text) {
  return String(text).replace(/\b([ap])\.m\.(?=\s+(?:to\b|[-–—]))/gi, '$1m')
    .split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
}

function structuralViolations(draft, context, wordBudget) {
  const violations = [];
  if (!draft) violations.push('empty_reply');
  if (!Number.isInteger(wordBudget) || wordBudget < 1 || wordCount(draft) > wordBudget) violations.push('word_budget_exceeded');
  if (/<\/?[a-z][^>]*>/i.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:[-*•]|\d+[.)])\s+/m.test(draft)) violations.push('bullets_not_allowed');
  if (BOILERPLATE_RE.test(draft)) violations.push('boilerplate_not_allowed');
  if (!exemplarLooksClean('', draft)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (containsReportAccessCode(draft)) violations.push('access_code');
  if (findBannedCustomerCopy(draft).length || reentrySafetyClaimFinding(draft)) violations.push('customer_copy_compliance');

  const firstName = String(context?.customer?.firstName || '').trim();
  if (firstName && !new RegExp(`^(?:hi|hello|hey)\\s+${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(draft)) violations.push('greeting_mismatch');
  return violations;
}

function groundingViolations(draft, context, exemplars) {
  const violations = [];
  const facts = presentFacts(context);
  const availableDates = dateFacts(context);
  for (const sentence of sentences(draft)) {
    const amounts = sentence.match(MONEY_RE) || [];
    if (amounts.length > 1) violations.push('multiple_amounts_unsupported');
    for (const amount of amounts) {
      if (!amountSupported(amount, sentence, facts)) violations.push(`amount_unsupported:${amount}`);
    }
    for (const date of temporalClaims(sentence)) {
      if (!dateSupported(date, sentence, availableDates)) violations.push(`date_unsupported:${date}`);
    }
    if (!hasSameFactBinding(sentence, context)) violations.push('fact_binding_unsupported');
  }
  violations.push(...statusViolations(draft, context), ...placeholderViolations(draft, context));
  const links = allowedLinks(context);
  if ((draft.match(LINK_RE) || []).some((link) => !links.has(link))) violations.push('link_unsupported');
  if (exemplarLeak(draft, exemplars, context)) violations.push('few_shot_leak');
  return violations;
}

function verifyEmailReply({ text, context, exemplars = [], wordBudget } = {}) {
  const draft = String(text || '').trim();
  const violations = [...new Set([
    ...structuralViolations(draft, context, wordBudget),
    ...groundingViolations(draft, context, exemplars),
  ])];
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReply, wordCount };
