const { exemplarLooksClean } = require('../sms-shadow-drafter');
const { containsReportAccessCode } = require('../service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('../service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('../content/content-guardrails');
const { etParts, addETDays } = require('../../utils/datetime-et');

const PLACEHOLDER_RE = /\[([a-z][a-z0-9_ -]{0,30})\]|\{\{?([a-z][a-z0-9_ -]{0,30})\}?\}/gi;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/gi;
const MONEY_RE = /\$\s*\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s+(?:dollars?|bucks?)\b/gi;
const SIGNED_MONEY_RE = /(?:[+\-\u2212]\s*\$\s*|\$\s*[+\-\u2212]\s*)\d[\d,]*(?:\.\d{1,2})?/gi;
const WRITTEN_MONEY_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:dollars?|bucks?)\b/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?\b|\b(?:today|tomorrow)\b/gi;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi;
const TIME_RANGE_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:[-–—]|to|and)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
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

function storedCents(value) {
  if (typeof value !== 'number' && !/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function hasResolvedDuesQuote(dues) {
  const surcharge = storedCents(dues?.surcharge);
  if (storedCents(dues?.total) == null || surcharge == null) return false;
  if (dues?.basis === 'credit_card_surcharge') return dues.surcharged === true && surcharge > 0;
  return dues?.basis === 'no_surcharge' && dues.surcharged === false && surcharge === 0;
}

function amountsForFact(fact) {
  const dues = fact.value?.monthlyDues;
  const resolvedDuesQuote = hasResolvedDuesQuote(dues);
  const byKey = {
    outstanding_balance: [fact.value],
    open_invoice: [fact.value?.amountDue],
    recent_payment: [fact.value?.amount],
    billing_lane: [dues?.base, ...(resolvedDuesQuote ? [dues?.surcharge, dues?.total] : [])],
  };
  const values = [];
  for (const value of byKey[fact.key] || []) {
    const amount = storedCents(value);
    if (amount != null) values.push(amount);
  }
  return values;
}

function amountsForClaim(fact, sentence) {
  if (fact.key !== 'billing_lane') return amountsForFact(fact);
  const fields = [
    [/\b(?:surcharge|card fee)\b/i, 'surcharge'],
    [/\b(?:total|monthly charge)\b/i, 'total'],
    [/\bbase\b/i, 'base'],
  ].filter(([pattern]) => pattern.test(sentence)).map(([, field]) => field);
  // One amount must name one billing field; proximity cannot decide ambiguous prose.
  if (fields.length > 1) return [];
  const field = fields[0] || 'base';
  const dues = fact.value?.monthlyDues;
  const amount = storedCents(dues?.[field]);
  if (amount == null || (field !== 'base' && !hasResolvedDuesQuote(dues))) return [];
  return [amount];
}

function factLanguage(sentence) {
  const invoiceNoun = /\binvoices?\b/i.test(sentence);
  const invoicePayment = /\binvoices?\s+payments?\b/i.test(sentence);
  const paymentDue = /\bpayments?\s+(?:(?:is|are|was|were|will be|has been|becomes?|remains?)\s+)?(?:now\s+)?due\b/i.test(sentence);
  return {
    invoice: paymentDue || (!invoicePayment && (invoiceNoun || /\bamount due\b/i.test(sentence))),
    payment: !paymentDue && (!invoiceNoun || invoicePayment) && /\b(?:payments?|paid|went through)\b/i.test(sentence),
  };
}

function semanticFactKeys(sentence) {
  const text = sentence.toLowerCase();
  const language = factLanguage(sentence);
  if (/\b(?:balance|outstanding|account current)\b/.test(text)) return ['outstanding_balance'];
  if (language.invoice) return ['open_invoice'];
  if (language.payment) return ['recent_payment'];
  if (/\b(?:monthly|dues|surcharge|card fee)\b/.test(text)) return ['billing_lane'];
  return [];
}

function mentionedFactKeys(sentence) {
  const keys = [];
  const language = factLanguage(sentence);
  if (/\b(?:balance|outstanding|account current)\b/i.test(sentence)) keys.push('outstanding_balance');
  if (language.payment) keys.push('recent_payment');
  if (language.invoice) keys.push('open_invoice');
  if (/\b(?:dues|surcharge|card fee|monthly (?:charge|cost|price|rate))\b/i.test(sentence)) keys.push('billing_lane');
  if (/\bestimate\b/i.test(sentence)) keys.push('pending_estimate');
  if (/\b(?:visit|service|appointment)\w*\b/i.test(sentence)
    || (!/\bestimate\b/i.test(sentence) && /\b(?:scheduled|coming|arriv)\w*\b/i.test(sentence))) {
    keys.push(/\b(?:last|previous|completed|was serviced|came out)\b/i.test(sentence)
      ? 'last_completed_visit' : 'upcoming_visit');
  }
  return [...new Set(keys)];
}

function amountSupported(raw, sentence, facts) {
  const amount = cents(raw);
  const keys = semanticFactKeys(sentence);
  if (amount == null || !keys.length) return false;
  return facts.some((fact) => keys.includes(fact.key) && amountsForClaim(fact, sentence).includes(amount));
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
      const valueRanges = timeRanges(value);
      const rangeEndpoints = new Set(valueRanges.flat());
      temporalClaims(value).forEach((claim) => {
        const normalized = normalizeTemporal(claim);
        if (!rangeEndpoints.has(normalized)) aliases.add(normalized);
      });
      ranges.push(...valueRanges);
    }
    if (aliases.size || ranges.length) result.push({ key: fact.key, aliases, ranges, fact });
  }
  return result;
}

function normalizeTemporal(value) {
  const normalized = String(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(normalized);
  if (!clock) return normalized.replace(/,/g, '').replace(/^([a-z]{3})[a-z]*(?= \d)/, '$1')
    .replace(/(^|\/)0+(?=\d)/g, '$1');
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
  const language = factLanguage(sentence);
  if (language.invoice) return ['open_invoice'];
  if (language.payment) return ['recent_payment'];
  if (/\bestimate\b/i.test(sentence)) return ['pending_estimate'];
  if (/\b(?:last|previous|completed|was serviced|came out)\b/i.test(sentence)) return ['last_completed_visit'];
  if (/\b(?:visit|service|appointment|scheduled|coming|arriv)\w*\b/i.test(sentence)) return ['upcoming_visit'];
  return [];
}

function dateSupported(raw, sentence, available) {
  const keys = dateSemanticKeys(sentence);
  return keys.length > 0 && available.some((entry) => keys.includes(entry.key)
    && temporalSupportedByEntry(raw, sentence, entry));
}

function temporalSupportedByEntry(raw, sentence, entry) {
  const normalized = normalizeTemporal(raw);
  if ([...entry.aliases].some((alias) => normalizeTemporal(alias) === normalized)) return true;
  const standaloneClocks = String(sentence).replace(TIME_RANGE_RE, '').match(TIME_RE) || [];
  if (standaloneClocks.some((clock) => normalizeTemporal(clock) === normalized)) return false;
  return timeRanges(sentence).some((range) => range.includes(normalized)
    && entry.ranges.some((sourceRange) => sourceRange[0] === range[0] && sourceRange[1] === range[1]));
}

function factByKey(context, key) {
  return (context?.facts || []).find((fact) => fact?.key === key) || null;
}

function factsMatchingClaims(sentence, key, context) {
  let candidates = presentFacts(context).filter((fact) => fact.key === key);
  const amounts = sentence.match(MONEY_RE) || [];
  if (amounts.length) {
    candidates = candidates.filter((fact) => amounts.every((amount) => amountsForClaim(fact, sentence).includes(cents(amount))));
  }
  const dates = temporalClaims(sentence);
  if (dates.length) {
    const entries = dateFacts(context).filter((entry) => entry.key === key && candidates.includes(entry.fact));
    candidates = candidates.filter((fact) => dates.every((raw) => entries.some((entry) => entry.fact === fact
      && temporalSupportedByEntry(raw, sentence, entry))));
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

function stateWordsSupported(sentence, key, context, pattern) {
  const normalized = (value) => String(value || '').toLowerCase().replace('cancelled', 'canceled')
    .replace('voided', 'void').replace(/\s+/g, '_');
  return (sentence.match(pattern) || []).every((claim) => statusSupported(sentence, key, context,
    (fact) => normalized(fact.value?.status) === normalized(claim)));
}

function statusViolations(text, context) {
  const violations = [];
  for (const sentence of sentences(text)) {
    const language = factLanguage(sentence);
    if (/\b(?:not|never|no longer|isn['’]t|wasn['’]t|hasn['’]t|haven['’]t|didn['’]t|cannot|can['’]t)\b/i.test(sentence)
      && /\b(?:payment|paid|invoice|visit|service|appointment|estimate)\b/i.test(sentence)) violations.push('negated_status_unsupported');

    const stateRules = [
      { matches: language.payment, key: 'recent_payment', violation: 'payment_status_unsupported',
        pattern: /\b(?:failed|declined|pending|processing|refunded|reversed|cancelled|canceled|voided)\b/gi },
      { matches: language.invoice, key: 'open_invoice', violation: 'invoice_status_unsupported',
        pattern: /\b(?:draft|sent|viewed|paid|prepaid|overdue|unpaid|processing|refunded|voided|void|cancelled|canceled)\b/gi },
      { matches: /\bestimate\b/i.test(sentence), key: 'pending_estimate', violation: 'estimate_status_unsupported',
        pattern: /\b(?:draft|scheduled|sending|send failed|viewed|accepted|declined|expired)\b/gi },
      { matches: /\b(?:visit|service|appointment)\b/i.test(sentence), key: 'upcoming_visit', violation: 'visit_status_unsupported',
        pattern: /\b(?:pending|rescheduled|cancelled|canceled|skipped|en route|on site)\b/gi },
    ];
    for (const rule of stateRules) {
      if (rule.matches && !stateWordsSupported(sentence, rule.key, context, rule.pattern)) violations.push(rule.violation);
    }
    if (/\b(?:visit|service|appointment)\b/i.test(sentence) && /\bcompleted\b/i.test(sentence)
      && (/\b(?:next|upcoming)\b/i.test(sentence) || !statusSupported(sentence, 'last_completed_visit', context, () => true))) violations.push('visit_status_unsupported');

    const statusRules = [
      {
        matches: language.payment
          && /\b(?:received|processed|successful|succeeded|completed|paid|went through)\b/i.test(sentence),
        key: 'recent_payment', violation: 'payment_status_unsupported',
        supports: (fact) => SUCCESS_STATUS_RE.test(String(fact.value?.status || '')),
      },
      {
        matches: /\b(?:visit|service|appointment)\b[\s\S]*\b(?:confirmed|booked|all set)\b|\b(?:confirmed|booked)\b[\s\S]*\b(?:visit|service|appointment)\b/i.test(sentence),
        key: 'upcoming_visit', violation: 'visit_status_unsupported',
        supports: (fact) => String(fact.value?.status).toLowerCase() === 'confirmed',
      },
      {
        matches: /\bestimate\b[\s\S]*\b(?:sent|emailed)\b|\b(?:sent|emailed)\b[\s\S]*\bestimate\b/i.test(sentence),
        key: 'pending_estimate', violation: 'estimate_status_unsupported',
        supports: (fact) => /^(?:sent|viewed)$/i.test(String(fact.value?.status || '')) && fact.value?.sentAt,
      },
    ];
    for (const rule of statusRules) {
      if (rule.matches && !statusSupported(sentence, rule.key, context, rule.supports)) violations.push(rule.violation);
    }
  }

  const balance = factByKey(context, 'outstanding_balance');
  if (/\b(?:paid in full|no (?:outstanding )?balance|balance is (?:zero|current)|account is current)\b/i.test(text)
    && !(balance?.status === 'present' && Number(balance.value) === 0)) violations.push('balance_status_unsupported');
  return violations;
}

function placeholderViolations(text, context) {
  const mappings = {
    visit: ['upcoming_visits'], appointment: ['upcoming_visits'], tech: ['upcoming_visits'], technician: ['upcoming_visits'],
    estimate: ['pending_estimate'], invoice: ['open_invoice'], payment: ['recent_payments'],
    balance: ['outstanding_balance'], name: ['customer'], phone: [], email: [], address: [], redacted: [],
  };
  const absentFactKeys = {
    recent_payment: 'recent_payments', upcoming_visit: 'upcoming_visits', last_completed_visit: 'last_completed_visit',
    pending_estimate: 'pending_estimate', open_invoice: 'open_invoice', outstanding_balance: 'outstanding_balance',
    billing_lane: 'billing_lane',
  };
  const violations = [];
  for (const sentence of sentences(text)) {
    for (const match of sentence.matchAll(PLACEHOLDER_RE)) {
      const token = String(match[1] || match[2]).trim().toLowerCase().replace(/\s+/g, '_');
      let factKeys = null;
      if (['date', 'day', 'time', 'window'].includes(token)) factKeys = dateSemanticKeys(sentence);
      if (token === 'amount') factKeys = semanticFactKeys(sentence);
      const keys = factKeys ? factKeys.map((key) => absentFactKeys[key]).filter(Boolean) : mappings[token];
      if (!keys?.length || !keys.some((key) => factByKey(context, key)?.status === 'absent')) violations.push(`placeholder_unsupported:${token}`);
    }
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
  const factLike = /\$\s*\d[\d,.]*|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b|\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\[[a-z_]+\]/gi;
  return (exemplars || []).some((example) => (String(example?.reply_text || '').match(factLike) || [])
    .some((value) => {
      if (!text.toLowerCase().includes(value.toLowerCase())) return false;
      if (value.trim().startsWith('$') && facts.some((fact) => amountsForFact(fact).includes(cents(value)))) return false;
      const normalized = normalizeTemporal(value);
      return !dates.some((entry) => temporalSupportedByEntry(normalized, text, entry));
    }));
}

function forgedSignature(text) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-2).join('\n');
  return lines.slice(1).some((line) => /^(?:best|best regards|kind regards|regards|sincerely|thanks|thank you)[,.]?$/i.test(line))
    || /(?:^|\n)\s*(?:[-–—]\s*)?(?:adam|virginia|the waves pest control team|waves team)\s*$/i.test(tail);
}

function sentences(text) {
  // Treat dotted meridiems as indivisible; ambiguous prose stays together for review.
  return String(text).replace(/\b([ap])\.m\./gi, '$1m')
    .split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
}

function structuralViolations(draft, context, wordBudget) {
  const violations = [];
  const normalizedCopy = draft.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
  if (!draft) violations.push('empty_reply');
  if (!Number.isInteger(wordBudget) || wordBudget < 1 || wordCount(draft) > wordBudget) violations.push('word_budget_exceeded');
  if (/<\/?[a-z][^>]*>/i.test(draft)) violations.push('html_not_allowed');
  if (/^\s*(?:[-*•]|\d+[.)])\s+/m.test(draft)) violations.push('bullets_not_allowed');
  const withoutClockTimes = draft.replace(TIME_RANGE_RE, '').replace(TIME_RE, '');
  if (/\b\d{1,2}:\d{2}\b|\b(?:at|from|between)\s+\d{1,2}\b(?![\d:/])/i.test(withoutClockTimes)) violations.push('clock_format_unsupported');
  if (BOILERPLATE_RE.test(draft)) violations.push('boilerplate_not_allowed');
  if (!exemplarLooksClean('', draft)) violations.push('untrusted_instruction');
  if (forgedSignature(draft)) violations.push('signature_unsupported');
  if (containsReportAccessCode(draft)) violations.push('access_code');
  if (findBannedCustomerCopy(draft).length || /\bper[\s-]+visit\b|\bWaves\s+Lawn\s*(?:&|and)\s*Pest\b/i.test(normalizedCopy)
    || reentrySafetyClaimFinding(draft)) violations.push('customer_copy_compliance');

  const firstName = String(context?.customer?.firstName || '').normalize('NFC').trim();
  if (firstName && !new RegExp(`^(?:hi|hello|hey)\\s+${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,!.:;—–-])`, 'i').test(draft.normalize('NFC'))) violations.push('greeting_mismatch');
  return violations;
}

function groundingViolations(draft, context, exemplars) {
  const violations = [];
  const facts = presentFacts(context);
  const availableDates = dateFacts(context);
  for (const sentence of sentences(draft)) {
    if (mentionedFactKeys(sentence).length > 1) violations.push('mixed_fact_categories_unsupported');
    const amounts = sentence.match(MONEY_RE) || [];
    const signedAmounts = sentence.match(SIGNED_MONEY_RE) || [];
    const writtenAmounts = sentence.match(WRITTEN_MONEY_RE) || [];
    if (amounts.length > 1) violations.push('multiple_amounts_unsupported');
    for (const amount of amounts) {
      if (!amountSupported(amount, sentence, facts)) violations.push(`amount_unsupported:${amount}`);
    }
    for (const amount of signedAmounts) violations.push(`amount_unsupported:${amount}`);
    for (const amount of writtenAmounts) violations.push(`amount_unsupported:${amount}`);
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
