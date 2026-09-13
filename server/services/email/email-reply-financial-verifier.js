const { isInvoiceCollectibleStatus } = require('../invoice-helpers');

const MONEY_RE = /\$\s*\d(?:[\d,.]*\d)?|\b\d(?:[\d,.]*\d)?\s+(?:dollars?|bucks?)\b/gi;
const SIGNED_MONEY_RE = /(?:[+\-\u2212]\s*\$\s*|\$\s*[+\-\u2212]\s*)\d[\d,]*(?:\.\d{1,2})?|[+\-\u2212]\s*\d[\d,]*(?:\.\d{1,2})?\s+(?:dollars?|bucks?)\b/gi;
const MAGNITUDE_MONEY_RE = /(?:\$\s*\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:[kmbt]\b|thousand\b|million\b|billion\b|trillion\b)|\b\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:[kmbt]|thousand|million|billion|trillion)\s+(?:dollars?|bucks?)\b)/gi;
const WRITTEN_MONEY_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:dollars?|bucks?)\b/gi;
const PAYMENT_STATE_RE = /\b(?:failed|declined|pending|processing|refunded|reversed|cancelled|canceled|voided|overdue)\b/gi;
const INVOICE_STATE_RE = /\b(?:draft|sent|viewed|paid|prepaid|overdue|unpaid|processing|refunded|voided|void|cancelled|canceled)\b/gi;
const ESTIMATE_STATE_RE = /\b(?:draft|scheduled|sending|send failed|viewed|accepted|declined|expired)\b/gi;
const SUCCESS_STATUS_RE = /^(?:paid|succeeded|successful|completed|processed|received)$/i;
const NEGATION_RE = /\b(?:not|never|no longer|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|didn['’]t|doesn['’]t|don['’]t|cannot|can['’]t|no)\b/i;
const NO_BALANCE_RE = /\bno (?:outstanding )?balance\b/i;
const ZERO_BALANCE_RE = /\b(?:paid in full|no (?:outstanding )?balance|balance is (?:zero|current)|account is current)\b/i;
const POSITIVE_BALANCE_RE = /\b(?:you (?:still )?have (?:an? )?(?:outstanding )?balance|there (?:is|remains) (?:an? )?(?:outstanding )?balance(?: due)?(?: on your account)?|(?:an? )?(?:outstanding )?balance (?:is|remains) due)\b/i;
const COLLECTION_REQUEST_RE = /\b(?:please\s+(?:pay|settle)\s+(?:the|your)|you\s+(?:(?:need|needs|have|has)\s+to|must)\s+(?:pay|settle)\s+(?:the|your))\s+(?:\$\s*\d(?:[\d,.]*\d)?\s+)?invoices?\b/i;

function presentFacts(context) {
  return Array.isArray(context?.facts) ? context.facts.filter((fact) => fact?.status === 'present') : [];
}

function cents(value) {
  const amount = String(value).replace(/^\$\s*|\s+(?:dollars?|bucks?)$/gi, '').replace(/[,.]$/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) return null;
  const number = Number(amount.replace(/,/g, ''));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function storedCents(value) {
  if (typeof value !== 'number' && !/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function hasResolvedDuesQuote(dues) {
  const base = storedCents(dues?.base);
  const surcharge = storedCents(dues?.surcharge);
  if (!(base > 0) || storedCents(dues?.total) == null || surcharge == null) return false;
  if (dues?.basis === 'credit_card_surcharge') return dues.surcharged === true && surcharge > 0;
  return dues?.basis === 'no_surcharge' && dues.surcharged === false && surcharge === 0;
}

function amountsForFact(fact) {
  const dues = fact.value?.monthlyBilled === true ? fact.value?.monthlyDues : null;
  const duesBase = storedCents(dues?.base) > 0 ? dues?.base : null;
  const byKey = {
    outstanding_balance: [fact.value],
    open_invoice: [fact.value?.amountDue],
    recent_payment: [fact.value?.amount],
    billing_lane: [duesBase, ...(hasResolvedDuesQuote(dues) ? [dues?.surcharge, dues?.total] : [])],
  };
  return (byKey[fact.key] || []).map(storedCents).filter((amount) => amount != null);
}

function amountsForClaim(fact, sentence) {
  if (fact.key !== 'billing_lane') return amountsForFact(fact);
  const fields = [
    [/\b(?:surcharge|card fee)\b/i, 'surcharge'],
    [/\b(?:total|monthly charge)\b/i, 'total'],
    [/\bbase\b/i, 'base'],
  ].filter(([pattern]) => pattern.test(sentence)).map(([, field]) => field);
  if (fields.length > 1 || fact.value?.monthlyBilled !== true) return [];
  const field = fields[0] || 'base';
  const dues = fact.value?.monthlyDues;
  const amount = storedCents(dues?.[field]);
  if (!(storedCents(dues?.base) > 0) || amount == null || (field !== 'base' && !hasResolvedDuesQuote(dues))) return [];
  return [amount];
}

function factLanguage(sentence) {
  const invoiceNoun = /\binvoices?\b/i.test(sentence);
  const invoicePayment = /\binvoices?\s+payments?\b/i.test(sentence);
  const paymentDue = /\bpayments?\s+(?:(?:is|are|was|were|will be|has been|becomes?|remains?)\s+)?(?:now\s+)?due\b/i.test(sentence);
  const balanceSettlement = /\bpaid in full\b/i.test(sentence);
  return {
    invoice: paymentDue || (!invoicePayment && (invoiceNoun || /\bamount due\b/i.test(sentence))),
    payment: !paymentDue && !balanceSettlement && (/\bpayments?\b/i.test(sentence)
      || ((!invoiceNoun || invoicePayment) && /\b(?:paid|went through)\b/i.test(sentence))),
  };
}

function financialFactKeys(sentence) {
  const keys = [];
  const language = factLanguage(sentence);
  if (/\b(?:balance|outstanding|account current|paid in full|owe[sd]?|owing)\b/i.test(sentence)) keys.push('outstanding_balance');
  if (language.payment) keys.push('recent_payment');
  if (language.invoice) keys.push('open_invoice');
  if (/\b(?:dues|surcharge|card fee|monthly (?:charge|cost|price|rate))\b/i.test(sentence)) keys.push('billing_lane');
  if (/\bestimates?\b/i.test(sentence)) keys.push('pending_estimate');
  return [...new Set(keys)];
}

function semanticAmountKey(sentence) {
  const keys = financialFactKeys(sentence);
  return ['outstanding_balance', 'open_invoice', 'recent_payment', 'billing_lane'].find((key) => keys.includes(key))
    || (/\bmonthly\b/i.test(sentence) ? 'billing_lane' : null);
}

function amountSupported(raw, sentence, facts) {
  const amount = cents(raw);
  const key = semanticAmountKey(sentence);
  return amount != null && key != null
    && facts.some((fact) => fact.key === key && amountsForClaim(fact, sentence).includes(amount));
}

function sentences(text) {
  return String(text).replace(/\b([ap])\.m\./gi, '$1m')
    .split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
}

function financialFactsMatchingClaims(sentence, key, context) {
  const amounts = sentence.match(MONEY_RE) || [];
  return presentFacts(context).filter((fact) => fact.key === key
    && amounts.every((amount) => amountsForClaim(fact, sentence).includes(cents(amount))));
}

function statusSupported(sentence, key, context, predicate) {
  const candidates = financialFactsMatchingClaims(sentence, key, context);
  return candidates.length > 0 && candidates.every(predicate);
}

function normalizedStatus(value) {
  return String(value || '').toLowerCase().replace('cancelled', 'canceled')
    .replace('voided', 'void').replace(/\s+/g, '_');
}

function stateWordsSupported(sentence, key, context, pattern) {
  return (sentence.match(pattern) || []).every((claim) => statusSupported(sentence, key, context,
    (fact) => normalizedStatus(fact.value?.status) === normalizedStatus(claim)));
}

function negatedFinancialClaim(sentence) {
  const withoutAllowedNoBalance = sentence.replace(NO_BALANCE_RE, '');
  const monetaryLanguage = financialFactKeys(sentence).length > 0 || /\$|\b(?:dollars?|bucks?)\b/i.test(sentence);
  return monetaryLanguage && NEGATION_RE.test(withoutAllowedNoBalance);
}

function statusViolations(text, context) {
  const violations = [];
  for (const sentence of sentences(text)) {
    const language = factLanguage(sentence);
    if (negatedFinancialClaim(sentence)) violations.push('negated_status_unsupported');
    const rules = [
      [language.payment, 'recent_payment', PAYMENT_STATE_RE, 'payment_status_unsupported'],
      [language.invoice, 'open_invoice', INVOICE_STATE_RE, 'invoice_status_unsupported'],
      [/\bestimates?\b/i.test(sentence), 'pending_estimate', ESTIMATE_STATE_RE, 'estimate_status_unsupported'],
    ];
    for (const [matches, key, pattern, violation] of rules) {
      if (matches && !stateWordsSupported(sentence, key, context, pattern)) violations.push(violation);
    }
    if (language.payment && /\b(?:received|processed|successful|succeeded|completed|paid|went through)\b/i.test(sentence)
      && !statusSupported(sentence, 'recent_payment', context,
        (fact) => SUCCESS_STATUS_RE.test(String(fact.value?.status || '')))) violations.push('payment_status_unsupported');
    if (/\bestimates?\b/i.test(sentence)
      && /\bestimates?\b[\s\S]*\b(?:sent|emailed)\b|\b(?:sent|emailed)\b[\s\S]*\bestimates?\b/i.test(sentence)
      && !statusSupported(sentence, 'pending_estimate', context,
        (fact) => /^(?:sent|viewed)$/i.test(String(fact.value?.status || '')) && fact.value?.sentAt)) violations.push('estimate_status_unsupported');
  }
  return violations;
}

function balanceViolations(text, context) {
  const balance = (context?.facts || []).find((fact) => fact?.key === 'outstanding_balance');
  const amount = balance?.status === 'present' ? storedCents(balance.value) : null;
  if ((ZERO_BALANCE_RE.test(text) && amount !== 0) || (POSITIVE_BALANCE_RE.test(text) && !(amount > 0))) {
    return ['balance_status_unsupported'];
  }
  return [];
}

function collectionViolations(text, context) {
  if (!COLLECTION_REQUEST_RE.test(text)) return [];
  const facts = Array.isArray(context?.facts) ? context.facts : [];
  const invoices = facts.filter((fact) => fact?.key === 'open_invoice' && fact.status === 'present');
  const payerFlags = facts.filter((fact) => fact?.key === 'payer_billed_invoice');
  const invoice = invoices[0]?.value;
  const ownCollectible = invoices.length === 1 && invoice && storedCents(invoice.amountDue) > 0
    && String(invoice.status || '').trim() && isInvoiceCollectibleStatus(invoice.status);
  const payerClear = payerFlags.length === 1 && payerFlags[0].status === 'absent' && payerFlags[0].value === false;
  return ownCollectible && payerClear ? [] : ['collection_request_unsupported'];
}

function amountViolations(text, context) {
  const violations = [];
  const facts = presentFacts(context);
  for (const sentence of sentences(text)) {
    const amounts = sentence.match(MONEY_RE) || [];
    if (financialFactKeys(sentence).length > 1) violations.push('mixed_fact_categories_unsupported');
    if (amounts.length > 1) violations.push('multiple_amounts_unsupported');
    for (const amount of amounts) {
      if (!amountSupported(amount, sentence, facts)) violations.push(`amount_unsupported:${amount}`);
    }
    const malformed = [
      ...(sentence.match(SIGNED_MONEY_RE) || []),
      ...(sentence.match(MAGNITUDE_MONEY_RE) || []),
      ...(sentence.match(WRITTEN_MONEY_RE) || []),
    ];
    for (const amount of malformed) violations.push(`amount_unsupported:${amount}`);
  }
  return violations;
}

// Financial facts and statuses only. Dates, event binding, scheduling, reply
// structure, placeholders, and exemplar leakage are intentionally unchecked.
function verifyEmailReplyAmountsAndStatuses({ text, context } = {}) {
  const draft = String(text || '').trim();
  const violations = [...new Set([
    ...amountViolations(draft, context),
    ...statusViolations(draft, context),
    ...balanceViolations(draft, context),
    ...collectionViolations(draft, context),
  ])];
  return { ok: violations.length === 0, violations };
}

module.exports = { verifyEmailReplyAmountsAndStatuses, sentences, factLanguage, financialFactKeys };
