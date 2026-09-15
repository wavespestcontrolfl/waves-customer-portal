/**
 * Pure card-value extraction for voice-relay evaluation.
 *
 * The caller owns any event/request state. This module only normalizes one
 * utterance, marks numeric spans with an explicit non-card explanation, and
 * returns the card values that remain.
 */

const NUMBER_WORDS_EN = Object.freeze({
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
});
const TEEN_WORDS_EN = Object.freeze({ ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' });
const TENS_WORDS_EN = Object.freeze({ twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' });
const NUMBER_WORD_EN_STRICT = [...Object.keys(NUMBER_WORDS_EN).filter((word) => word !== 'oh'), ...Object.keys(TEEN_WORDS_EN), ...Object.keys(TENS_WORDS_EN), 'hundred', 'thousand'].join('|');
const NUMBER_RUN_EN_STRICT = `(?:(?:${NUMBER_WORD_EN_STRICT})\\b(?:\\s+and\\s+|[\\s-]+)?){1,6}`;
const DIGITS = '\\d[\\d,]*(?:\\.\\d+)?';
const PRICE_NUMBER = `(?:(?<![\\d.,/-])(?:0|[1-9][\\d,]*)(?:\\.\\d+)?(?![\\d/-])|\\b${NUMBER_RUN_EN_STRICT})`;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const SENTENCE_SPLIT_RE = /[.!?;]+(?=\s|$)/;
const BILLING_AMOUNT_NOUN = 'balance|total|owe[sd]?|owing|amount (?:due|owed)|price[sd]?|cost[s]?|charge[sd]?|rate|fee|saldo|monto|debe|precio|cuesta|cobra|tarifa';

function spokenDigitsEn(text) {
  const token = `(?:(?:double|triple)[\\s-]+)?(?:${Object.keys(NUMBER_WORDS_EN).join('|')}|${Object.keys(TEEN_WORDS_EN).join('|')}|(?:${Object.keys(TENS_WORDS_EN).join('|')})(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?)`;
  const re = new RegExp(`\\b${token}(?:[\\s,.-]+${token})*\\b`, 'gi');
  return String(text || '').replace(re, (run) => {
    let out = '';
    let repeat = 1;
    let tens = null;
    for (const word of run.toLowerCase().split(/[\s,.-]+/).filter(Boolean)) {
      if (word === 'double' || word === 'triple') { repeat = word === 'double' ? 2 : 3; continue; }
      if (word in TENS_WORDS_EN) { if (tens) out += `${tens}0`; tens = TENS_WORDS_EN[word]; continue; }
      let digits = NUMBER_WORDS_EN[word] || TEEN_WORDS_EN[word];
      if (!digits) continue;
      if (tens) { if (word in NUMBER_WORDS_EN && digits !== '0') digits = tens + digits; else out += `${tens}0`; tens = null; }
      out += digits.repeat(repeat);
      repeat = 1;
    }
    return tens ? `${out}${tens}0` : out;
  });
}

const stripAccents = (word) => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const CARDINALS_ES = Object.freeze({
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900, mil: 1000,
});
const CARDINAL_TOKEN_ES = '(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti(?:uno|[uú]n|una|d[oó]s|tr[eé]s|cuatro|cinco|s[eé]is|siete|ocho|nueve)|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien(?:to)?|doscient[oa]s|trescient[oa]s|cuatrocient[oa]s|quinient[oa]s|seiscient[oa]s|setecient[oa]s|ochocient[oa]s|novecient[oa]s|mil)';
const CARDINAL_RUN_ES_RE = new RegExp(`\\b(?:(?:doble|triple)[\\s-]+)?${CARDINAL_TOKEN_ES}(?:(?:[\\s,.-]+|\\s+y\\s+)(?:(?:doble|triple)[\\s-]+)?${CARDINAL_TOKEN_ES})*\\b`, 'gi');
const COMPOUND_ARTICLE_ES_RES = Object.freeze([
  [new RegExp(`\\b(${CARDINAL_TOKEN_ES}\\s+(?:y\\s+)?)(?:un|una)\\b`, 'gi'), '$1uno'],
  [new RegExp(`\\b(?:un|una)(\\s+${CARDINAL_TOKEN_ES})\\b`, 'gi'), 'uno$1'],
]);
const SPANISH_CONTEXT_RE = /\b(?:el|la|los|las|su|sus|mi|mis|tu|tus|es|son|tarjeta|c[oó]digo|seguridad|vence|vencimiento|caduca|fecha|n[uú]mero|d[ií]gitos?)\b/i;

function spanishGroup(words, start) {
  const word = words[start];
  const value = CARDINALS_ES[word];
  if (value < 10 && words[start + 1] === 'mil') {
    let total = value * 1000;
    let next = start + 2;
    if (next < words.length && words[next] !== 'doble' && words[next] !== 'triple') {
      const tail = spanishGroup(words, next);
      total += tail.value;
      next = tail.next;
    }
    return { value: total, next };
  }
  if (value === 1000) {
    let total = value;
    let next = start + 1;
    if (next < words.length && words[next] !== 'doble' && words[next] !== 'triple') {
      const tail = spanishGroup(words, next);
      total += tail.value;
      next = tail.next;
    }
    return { value: total, next };
  }
  if (value >= 100) {
    const tail = words[start + 1] && CARDINALS_ES[words[start + 1]];
    if (tail !== undefined && tail < 100) {
      const parsed = spanishGroup(words, start + 1);
      return { value: value + parsed.value, next: parsed.next };
    }
    return { value, next: start + 1 };
  }
  if (value >= 30 && value % 10 === 0 && words[start + 1] === 'y') {
    const unit = CARDINALS_ES[words[start + 2]];
    if (unit > 0 && unit < 10) return { value: value + unit, next: start + 3 };
  }
  return { value, next: start + 1 };
}

function spokenDigitsEs(text, allowAmbiguous = false) {
  const expanded = COMPOUND_ARTICLE_ES_RES.reduce((value, [re, replacement]) => value.replace(re, replacement), String(text || ''));
  return expanded.replace(CARDINAL_RUN_ES_RE, (run) => {
    if (/^once$/i.test(run) && !allowAmbiguous && !SPANISH_CONTEXT_RE.test(text)) return run;
    const words = run.toLowerCase().split(/[\s,.-]+/).map(stripAccents);
    let repeat = 1;
    let out = '';
    for (let index = 0; index < words.length;) {
      const word = words[index];
      if (word === 'doble' || word === 'triple') { repeat = word === 'doble' ? 2 : 3; index += 1; continue; }
      if (word === 'y') { index += 1; continue; }
      const group = spanishGroup(words, index);
      out += String(group.value).repeat(repeat);
      repeat = 1;
      index = group.next;
    }
    return out;
  });
}

const CARD_BRAND = '(?:visa|master ?card|amex|american express|discover)';
const CARD_PAYMENT_LABEL = `(?:card|tarjeta(?:\\s+de\\s+(?:cr[eé]dito|d[eé]bito|prepago))?|payment method|saved payment(?: method)?|(?:(?:your|the|my|this|that|our|su|la|mi|esta|esa|tu)\\s+|^\\s*)(?:${CARD_BRAND}|debit|credit|prepaid))`;
const CARD_FIELD_LABEL = `(?:(?:card|${CARD_BRAND}|(?:credit|debit|prepaid)(?:\\s+card)?|payment method)(?:[\\x27\\u2019]s)?\\s+(?:(?:first|last)\\s+\\w+\\s+)?(?:number|digits?)|pan|cvv|cvc|security code|(?:(?:three|four|3|4)[\\s-]+digit\\s+)?code\\s+(?:on|from)\\s+(?:the\\s+)?(?:back|front)\\s+of\\s+(?:(?:your|the|my|this|that)\\s+)?card)`;
const CARD_CUE = '(?:card|number|digits?|pan|cvv|cvc|security code|expir(?:y|ation|es|ed)|i heard|read(?:ing)? (?:that |it )?back|you (?:said|gave|read)|tarjeta|n[uú]mero de (?:la|su)?\\s*tarjeta|c[oó]digo de seguridad|vencimiento|fecha de vencimiento)';
const CARD_DIGIT_LABEL = '(?:begins?|starts?|ends?|ending|starting|beginning) (?:with|in)|(?:first|last|next|middle) (?:digit|number|one) (?:is|was)';
const CARD_COUNT_MODIFIERS = '(?:(?:pending|failed|successful|declined|completed|remaining|active|saved)\\s+)*';
const CARD_COUNT_NOUN = '(?:applications?|treatments?|services?|visits?|appointments?|accounts?|payments?|transactions?|attempts?|options?|cards?|rooms?|bedrooms?|bathrooms?|properties|homes?|lawns?|yards?|dogs?|cats?|pets?|animals?|children|kids?|bab(?:y|ies)|adults?|people|men|women|mice|geese|feet|fish|sheep)';
const CARD_SCALAR_UNIT = "(?:seconds?|minutes?|mins?|moments?|hours?|hrs?|days?|weeks?|months?|years?|dollars?|cents?|percent|%|am|pm|a\\.m\\.|p\\.m\\.|o'clock|digits?|numbers?|more|times|of them|characters|(?:(?:[uú]ltimos?|primeros?)\\s+)?(?:d[ií]gitos?|n[uú]meros?))";
const CARD_MEASUREMENT_UNIT = '(?:sq(?:uare)?\\.?\\s*(?:ft|feet|foot)|acres?)';
const CARD_COMMA_VALUE_BOUNDARY_RE = new RegExp(
  `(?:(?<!\\d),|,(?!\\d{3}(?:\\D|$)))\\s*(?=(?:${DIGITS}|${NUMBER_RUN_EN_STRICT}|${CARDINAL_TOKEN_ES})\\s+(?:(?:${CARD_COUNT_MODIFIERS}${CARD_COUNT_NOUN}|${CARD_MEASUREMENT_UNIT}|${CARD_SCALAR_UNIT})(?!\\w)|`
    + `(?:is|was)\\s+(?:the\\s+)?(?:first|last|next|middle)\\s+(?:digit|number|one)\\s+(?:of|on)\\s+(?:(?:your|the|my|this|that)\\s+)?(?:card|pan|cvv|cvc|security code)\\b))`,
  'gi',
);

function normalizedCardText(text, allowAmbiguous = false) {
  const bounded = String(text || '').replace(CARD_COMMA_VALUE_BOUNDARY_RE, '; ');
  return spokenDigitsEs(spokenDigitsEn(bounded), allowAmbiguous);
}

// Include the country code in the explanatory span; leaving its leading 1
// behind makes a harmless +1 US phone number look like a card fragment.
const CARD_PHONE_VALUE = '(?:(?:\\+?1[\\s.-]?)?(?:(?:\\(\\d{3}\\)|\\d{3})[\\s.-]\\d{3}[\\s.-]\\d{4}|\\d{10})\\b)';
const CARD_MENU_OPTION_RE = /\b(?:option|choice|key)\s+(?:number\s+)?\d+\b|\bpress\s+\d+\b/gi;
const CARD_MONTH_DATE_VALUE = `(?:${MONTHS})\\s+(?:(?:19|20)\\d{2}|\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?)`;
const CARD_NUMERIC_DATE_VALUE = '(?:0?[1-9]|1[0-2])\\s*[/.-]\\s*(?:0?[1-9]|[12]\\d|3[01])\\s*[/.-]\\s*(?:19|20)\\d{2}';
const CARD_EXPLAINED_DATE_VALUE = `(?:${CARD_MONTH_DATE_VALUE}|(?:0?[1-9]|1[0-2])\\s*[/.-]\\s*(?:(?:0?[1-9]|[12]\\d|3[01])\\s*[/.-]\\s*)?(?:\\d{2}|(?:19|20)\\d{2})|(?:19|20)\\d{2})`;
const CARD_CALENDAR_VALUE_RES = Object.freeze([new RegExp(`\\b${CARD_MONTH_DATE_VALUE}\\b`, 'gi'), new RegExp(`\\b${CARD_NUMERIC_DATE_VALUE}\\b`, 'g')]);
const CARD_MONTH_NUMBER = Object.freeze(Object.fromEntries(MONTHS.split('|').map((month, index) => [month, String((index % 12) + 1).padStart(2, '0')])));
const CARD_NAMED_EXPIRATION_VALUE_RE = new RegExp(`^(${MONTHS})\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\s+))?((?:19|20)\\d{2}|\\d{2})$`, 'i');
const CARD_NUMERIC_EXPIRATION_VALUE_RE = /^(\d{1,2})\s*[/.-]\s*(?:(\d{1,2})\s*[/.-]\s*)?((?:19|20)\d{2}|\d{2})$/;
const BILLING_MONTH_DAY = '(?:0?[1-9]|1[0-2])\\s*[/.-]\\s*(?:0?[1-9]|[12]\\d|3[01])';

const CARD_NON_FRAGMENT_RES = Object.freeze([
  new RegExp(`\\b(?:${BILLING_AMOUNT_NOUN})(?:\\s+(?:on|for)\\s+(?:(?:your|the|my|this|that)\\s+)?(?:card|account))?\\s+(?:(?:is|was|of|es)\\s+)?(?:${DIGITS}|${NUMBER_WORD_EN_STRICT})(?:[\\s-]+(?!(?:and\\s+)?(?:${DIGITS}|${NUMBER_WORD_EN_STRICT})\\s+(?:is|are|was|were)\\b)(?:and\\s+)?(?:${DIGITS}|${NUMBER_WORD_EN_STRICT})){0,6}\\b`, 'gi'),
  new RegExp(`\\b(?:${DIGITS}|${NUMBER_WORD_EN_STRICT})(?:[\\s-]+(?:and\\s+)?(?:${DIGITS}|${NUMBER_WORD_EN_STRICT})){0,6}\\s+(?:bucks|${CARD_SCALAR_UNIT}|${CARD_MEASUREMENT_UNIT}|${CARD_COUNT_MODIFIERS}${CARD_COUNT_NOUN})\\b`, 'gi'),
  new RegExp(`\\$\\s*${DIGITS}`, 'gi'),
  new RegExp(`\\b${PRICE_NUMBER}\\s*(?:per|an?|each|every|for each|for every)\\s+(?:applications?|treatments?|services?|visits?)\\b`, 'gi'),
  new RegExp(`\\b\\d[\\d,]*(?:\\.\\d+)?\\s*${CARD_MEASUREMENT_UNIT}\\b`, 'gi'),
  /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?))?(?![\da-z])/gi,
  new RegExp(`\\b\\d+(?:\\.\\d+)?\\s+${CARD_COUNT_MODIFIERS}(?:cards?|applications?|payments?|transactions?|attempts?|options?|visits?|services?|appointments?|accounts?)\\b`, 'gi'),
  new RegExp(`\\b\\d+(?:\\.\\d+)?\\s+(?!(?:card\\s+(?:number|digits?)|pan|cvv|cvc|security\\s+(?:code|digits?)|digits?|numbers?|codes?)\\b)${CARD_COUNT_NOUN}(?=\\s+(?:is|are|was|were)\\b|[.!?,;:]|$)`, 'gi'),
  /\b\d+(?:\.\d+)?[\s-]+(?:rooms?|bedrooms?)\b/gi,
  /\b(?:rooms?|bedrooms?)\s+(?:is|was|are|were)\s+\d+(?:\.\d+)?\b/gi,
  new RegExp(`\\b(?:have|has|had|need(?:s|ed)?|include[sd]?|cover(?:s|ed)?)\\s+\\d+(?:\\.\\d+)?\\s+${CARD_COUNT_NOUN}\\b`, 'gi'),
  new RegExp(`\\b(?:number|count)\\s+of\\s+${CARD_COUNT_NOUN}\\s+(?:is|was|are|were)\\s+\\d+(?:\\.\\d+)?\\b`, 'gi'),
  new RegExp(`\\b(?:your|the|our|my)\\s+(?!(?:card|${CARD_BRAND}|payment|credit|debit|prepaid|security|pan|cvv|cvc)\\b)[A-Za-z][\\w'-]*\\s+(?:number|code)\\s+(?:is|was)\\s+\\d+\\b`, 'gi'),
  new RegExp(`\\b\\d+(?:\\.\\d+)?[\\s-]*${CARD_SCALAR_UNIT}(?!\\w)`, 'gi'),
  /\b(?:invoice|estimate|order|ticket|account|reference|confirmation)\s+(?:number\s+|#\s*)?(?:is\s+)?[\w-]*\d[\w-]*/gi,
  new RegExp(`\\b(?:appointment|service|visit|calendar|date|year)(?:\\s+(?:date|year))?\\s+(?:(?:is|was|will be|falls?|fell|occur(?:s|red)?|happen(?:s|ed)?|scheduled|booked)\\s+)?(?:(?:on|in|for)\\s+)?${CARD_EXPLAINED_DATE_VALUE}\\b`, 'gi'),
  /\b(?:(?:issued|added|saved|updated)\s+(?:on|in)|on\s+file\s+since)\s+(?:19|20)\d{2}\b/gi,
  /\b(?:first|last)\s+\d+\s+(?:are|were)\b/gi,
  new RegExp(`\\b(?:due|charged|billed|processed|scheduled)\\s+(?:on|for)\\s+(?:the\\s+)?(?:${BILLING_MONTH_DAY}|(?:[12]?\\d|3[01])(?:st|nd|rd|th))\\b`, 'gi'),
  CARD_MENU_OPTION_RE,
  new RegExp(`\\bnumber\\s+(?:to|for)\\s+(?:call|text|reach)(?:ing)?(?:\\s+back)?\\s+(?:is|was|as)\\s+${CARD_PHONE_VALUE}`, 'gi'),
  new RegExp(`\\b(?:phone|cell|mobile|office|fax|area)\\s+(?:number|code)\\s+(?:(?:is|of|as)\\s+)?${CARD_PHONE_VALUE}`, 'gi'),
  new RegExp(`\\b(?:phone|cell|mobile|office|fax)(?:\\s+number)?\\s+(?:for|on|of)\\s+(?:the\\s+)?(?:card|payment method|account|portal)(?:\\s+portal)?\\s+(?:is|was|as)\\s+${CARD_PHONE_VALUE}`, 'gi'),
  new RegExp(`\\b(?:phone|cell|mobile|fax)(?:\\s+number)?\\s+(?:is|was|as)\\s+${CARD_PHONE_VALUE}`, 'gi'),
  new RegExp(`\\b(?:call|text|reach)(?:\\s+(?:me|us|the office|our office))?(?:\\s+(?:at|on))?\\s+${CARD_PHONE_VALUE}`, 'gi'),
  new RegExp(`${CARD_PHONE_VALUE}\\s+(?:is|was)\\s+(?:our|the|my|your)?\\s*(?:phone|cell|mobile|fax|callback)\\s+number\\b`, 'gi'),
  new RegExp(`${CARD_PHONE_VALUE}[^.!?;]{0,20}\\b(?:from|on)\\s+(?:your|the|my|our)\\s+(?:phone|cell|mobile)\\b`, 'gi'),
  /\bzip(?:\s+code)?\s+(?:is\s+)?\d{5}(?:-\d{4})?\b/gi,
  /\b\d+\s+[A-Za-z]+\s+(?:lane|ln|street|st|road|rd|avenue|ave|drive|dr|court|ct|way|boulevard|blvd|circle|cir|place|pl|terrace|trail|trl)\b(?:,\s*[A-Za-z]+(?:\s+[A-Za-z]+)?,\s*\d{5}\b)?/gi,
]);

const NON_CARD_EXPIRATION_SUBJECT = '(?:service|coupon|promo(?:tion)?|discount|offer|contract|warranty|plan|subscription|licen[cs]e|servicio|cup[oó]n)(?:[\\x27\\u2019]s)?(?:\\s+(?:has|have|had|with)(?:\\s+(?:an?|the))?)?';
const NON_CARD_EXPIRATION_SUBJECT_RE = new RegExp(`\\b${NON_CARD_EXPIRATION_SUBJECT}\\s+$`, 'i');
const CARD_EXPIRATION_CUE = `(?:${CARD_PAYMENT_LABEL}(?:[\\x27\\u2019]s)?\\s+(?:that\\s+)?(?:(?:will|does|did)\\s+)?(?:expir(?:e|es|ed|y|ation|a|ar[aá]|[oó])|venc(?:e|er[aá]|i[oó])|caduc(?:a|ar[aá]|[oó]))|expir(?:y|ation)|${CARD_PAYMENT_LABEL}(?:[\\x27\\u2019]s)?\\s+(?:(?:is|was)\\s+(?:valid|good)\\s+through|(?:(?:es|era)\\s+)?v[aá]lid[ao]\\s+hasta)|(?:fecha\\s+de\\s+)?vencimiento(?:\\s+de\\s+(?:la\\s+)?tarjeta)?)`;
const CARD_EXPIRATION_VALUE_RE = new RegExp(
  `\\b${CARD_EXPIRATION_CUE}(?:\\s+date)?(?:\\s+on\\s+(?:(?:your|the|my|this|that)\\s+)?${CARD_PAYMENT_LABEL})?`
    + `(?:\\s+(?:(?:is|was|es|era)(?:\\s+(?:on|in|en|el|(?:listed|shown|recorded)\\s+as|set\\s+(?:to|for)))?|on|in|en|el|of|(?:listed|shown|recorded)\\s+as|set\\s+(?:to|for)|at\\s+(?:the\\s+)?end\\s+of))?(?:\\s+(?:next|this))?(?:\\s+|\\s*[:—–,-]\\s*)`
    + `((?:(?:${MONTHS})\\s+(?:(?:\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*|\\s+)(?:19|20)\\d{2})|(?:(?:19|20)\\d{2})|(?:\\d{2})))|(?:(?:0?[1-9]|1[0-2])\\s*[/.-]\\s*(?:(?:0?[1-9]|[12]\\d|3[01])\\s*[/.-]\\s*)?(?:\\d{2}|(?:19|20)\\d{2}))|(?:(?:19|20)\\d{2}))\\b`,
  'gi',
);
const CARD_CUE_RE = new RegExp(`\\b${CARD_CUE}\\b`, 'i');
const CARD_VALUE_CONTEXT_RE = new RegExp(`\\b(?:${CARD_PAYMENT_LABEL}|pan|cvv|cvc|security code|expir(?:y|ation|es|ed)|tarjeta|n[uú]mero de (?:la|su)?\\s*tarjeta|c[oó]digo de seguridad|vencimiento|fecha de vencimiento)\\b`, 'i');
const CARD_READBACK_CUE_RE = new RegExp(`\\b(?:read|repeat|confirm)(?:ing)?\\b(?:[^.!?;]{0,50}\\b(?:${CARD_FIELD_LABEL}|card)\\b[^.!?;]{0,20}\\bback\\b|\\s+back\\b[^.!?;]{0,50}\\b${CARD_FIELD_LABEL}\\b)`, 'i');
const CARD_VALUE_INTRO_RE = new RegExp(`(?:^|[.!?;—–])\\s*(?:(?:okay|ok|sure|yes|yeah|bien|claro)[\\s,:-]+)?(?:(?:my|your|the|our|this|that|su|mi|tu|la|el)\\s+)?(?:${CARD_FIELD_LABEL}|n[uú]mero\\s+de\\s+(?:(?:la|su|tu)\\s+)?tarjeta|c[oó]digo\\s+de\\s+seguridad|${CARD_PAYMENT_LABEL}\\s+(?:${CARD_DIGIT_LABEL}))\\b(?:\\s+(?:is|are|was|were|es|son))?\\s*(?=[:.!?;—–-]|$)`, 'i');
const CARD_BARE_FRAGMENT_RE = /^\s*(?:(?:yes|yeah|okay|sure)[\s,:-]+)?(?:(?:it(?:[\x27\u2019]s| (?:is|was))|the (?:number|digits?|(?:first|last) \d+) (?:is|are|was|were))[\s,:-]+)?\d+(?:[\s/.-]+\d+)*\s*(?:(?:,\s*)?(?:(?:is|that(?:[\x27\u2019]s| is))\s+)?(?:correct|right)|,\s*got it)?\s*$/i;
const AMBIGUOUS_ONCE_VALUE_RE = /^\s*once(?:\s*,?\s*(?:correct[oa]|s[ií]|gracias))?[.!?]?\s*$/i;
const CARD_LABELED_VALUE_RE = new RegExp(`\\b(?:${CARD_DIGIT_LABEL})\\s*(?:[—–-]\\s*)?(\\d+(?:[\\s-]\\d+)*)\\b`, 'gi');
const CARD_EXPLICIT_VALUE_RE = new RegExp(`\\b${CARD_FIELD_LABEL}\\b(?:\\s+(?:is|was))?\\s*[:#—–-]?\\s*((?:\\(\\d+\\)|\\d+)(?:[\\s./-]\\d+)*)\\b`, 'gi');
const CARD_SLASHED_VALUE_RE = /\b\d+(?:[/.]\d+)+\b/g;
const DIGIT_RUN_RE = /\d+(?:[\s-]\d+)*/g;
const SEPARATED_DIGIT_RUN_RE = /\b\d(?:[\s,-]+\d)+\b/g;
const joinSeparatedDigits = (text) => text.replace(SEPARATED_DIGIT_RUN_RE, (run) => run.replace(/[\s,-]+/g, ''));
const cardIntroducesReadback = (text) => CARD_READBACK_CUE_RE.test(text) || CARD_VALUE_INTRO_RE.test(text);
const containsSpan = (span, start, end) => start >= span[0] && end <= span[1];

function allowsAmbiguousSpanishCardinal(text, precedingReadback) {
  if (!AMBIGUOUS_ONCE_VALUE_RE.test(text)) return false;
  if (precedingReadback === true) return true;
  return Array.isArray(precedingReadback)
    && precedingReadback.some((value) => cardValuesMatch(value, '11'));
}

function clauseBounds(text, at) {
  const boundary = /[.!?;:]|[—–]|\b(?:but|and|or|though|although|however|yet|so|then|while|because|pero|sin embargo|aunque)\b/gi;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(boundary)) {
    const right = text.slice(match.index + match[0].length);
    const independent = /^\s*(?:(?:you|he|she|it|your|our|their|his|her|i|we|they|the office|the team|someone|billing)\b|(?:an?|the|this|that|these|those)\s+(?:[\w\x27\u2019-]+\s+){0,5}\b(?:is|are|was|were|has|have|had|will|would|should|can|could|did|does|do)\b|(?:is|are|was|were|has|have|had|will|would|should|can|could|did|does|do)\b)/i.test(right);
    if (/^:$/.test(match[0]) && !independent) continue;
    if (/^(?:and|or)$/i.test(match[0]) && !independent) continue;
    if (match.index + match[0].length <= at) start = match.index + match[0].length;
    else { end = match.index; break; }
  }
  return [start, end];
}

function normalizedCardExpiration(value) {
  const text = normalizedCardText(value).trim().toLowerCase();
  const named = CARD_NAMED_EXPIRATION_VALUE_RE.exec(text);
  const numeric = CARD_NUMERIC_EXPIRATION_VALUE_RE.exec(text);
  const match = named || numeric;
  if (!match) return null;
  const month = named ? CARD_MONTH_NUMBER[match[1]] : match[1].padStart(2, '0');
  const day = match[2] ? match[2].padStart(2, '0') : '';
  return `${month}${day}${match[3].slice(-2)}`;
}

function cardValuesMatch(supplied, candidate) {
  const suppliedExpiration = normalizedCardExpiration(supplied);
  const candidateExpiration = normalizedCardExpiration(candidate);
  if (suppliedExpiration && candidateExpiration) return suppliedExpiration.includes(candidateExpiration);
  const candidateDigits = normalizedCardText(candidate).replace(/\D/g, '');
  const suppliedDigits = normalizedCardText(supplied).replace(/\D/g, '');
  return Boolean(candidateDigits) && ((suppliedExpiration || '').includes(candidateDigits) || suppliedDigits.includes(candidateDigits));
}

function cardFragmentsIn(text, precedingReadback = false, callerAnswer = false) {
  const digitParts = String(text || '').trim().split(new RegExp(`(${SENTENCE_SPLIT_RE.source})`));
  const allowAmbiguousSpanish = allowsAmbiguousSpanishCardinal(text, precedingReadback);
  const digits = joinSeparatedDigits(digitParts.map((part, index) => (
    index % 2 ? part : normalizedCardText(part, allowAmbiguousSpanish)
  )).join(''));
  const nonFragments = CARD_NON_FRAGMENT_RES.flatMap((re) => [...digits.matchAll(re)].map((match) => [match.index, match.index + match[0].length]));
  const calendarValues = CARD_CALENDAR_VALUE_RES.flatMap((re) => [...digits.matchAll(re)].map((match) => [match.index, match.index + match[0].length]));
  const expirationValues = [...digits.matchAll(CARD_EXPIRATION_VALUE_RE)].map((match) => {
    const start = match.index + match[0].lastIndexOf(match[1]);
    const span = [start, start + match[1].length];
    if (/^(?:expir|(?:fecha de )?vencimiento)/i.test(match[0]) && NON_CARD_EXPIRATION_SUBJECT_RE.test(digits.slice(0, match.index))) {
      nonFragments.push(span);
      return null;
    }
    return span;
  }).filter(Boolean);
  const labeledValues = [...digits.matchAll(CARD_LABELED_VALUE_RE)].map((match) => {
    const start = match.index + match[0].lastIndexOf(match[1]);
    const [labelStart, labelEnd] = clauseBounds(digits, match.index);
    const labelClause = digits.slice(labelStart, labelEnd);
    const priorLabelClause = digits.slice(0, labelStart).replace(/[.!?;—–\s]+$/g, '').split(/[.!?;—–]/).pop() || '';
    const labelContext = labelClause.replace(/^\s*it\b/i, `${priorLabelClause} it`);
    return [start, start + match[1].length, CARD_VALUE_CONTEXT_RE.test(labelContext.trim())];
  });
  nonFragments.push(...labeledValues);
  const explicitCardValues = [...digits.matchAll(CARD_EXPLICIT_VALUE_RE)].map((match) => {
    const start = match.index + match[0].lastIndexOf(match[1]);
    return [start, start + match[1].length];
  });
  const slashedValues = [...digits.matchAll(CARD_SLASHED_VALUE_RE)].map((match) => [match.index, match.index + match[0].length]);
  const fragments = [];
  expirationValues.forEach((span) => fragments.push([span[0], digits.slice(...span)]));
  labeledValues.filter((span) => span[2])
    .forEach((span) => fragments.push([span[0], digits.slice(span[0], span[1])]));
  explicitCardValues.filter((span) => !/^\s*(?:digits?|numbers?)\b/i.test(digits.slice(span[1])))
    .forEach((span) => fragments.push([span[0], digits.slice(...span)]));
  const suppliedValues = [].concat(precedingReadback || []).filter((value) => typeof value === 'string');
  const precedingValues = suppliedValues.concat(suppliedValues.join(' '));
  for (const match of digits.matchAll(DIGIT_RUN_RE)) {
    const matchEnd = match.index + match[0].length;
    const [clauseStart, clauseEnd] = clauseBounds(digits, match.index);
    const clause = digits.slice(clauseStart, clauseEnd);
    const priorText = digits.slice(0, clauseStart).replace(/[.!?;—–\s]+$/g, '');
    const priorClause = priorText.split(/[.!?;—–]/).pop() || '';
    const expirationSpan = expirationValues.find((span) => containsSpan(span, match.index, matchEnd));
    const slashedSpan = slashedValues.find((span) => containsSpan(span, match.index, matchEnd));
    const calendarSpan = calendarValues.find((span) => containsSpan(span, match.index, matchEnd));
    const valueSpan = [expirationSpan, slashedSpan, calendarSpan].find(Boolean);
    const candidateValue = valueSpan ? digits.slice(...valueSpan) : match[0];
    const precedingValueMatches = precedingValues.some((value) => cardValuesMatch(value, candidateValue));
    const carriedValue = precedingValueMatches || (precedingReadback === true && Boolean(calendarSpan));
    const contextual = nonFragments.some((span) => containsSpan(span, match.index, matchEnd));
    const explained = contextual || (Boolean(calendarSpan) && !carriedValue);
    const responseLooksLikeAnswer = callerAnswer || CARD_BARE_FRAGMENT_RE.test(clause);
    const hasReadbackContext = precedingReadback === true || cardIntroducesReadback(priorClause);
    const inheritedReadback = carriedValue || (responseLooksLikeAnswer && hasReadbackContext);
    if (!CARD_CUE_RE.test(clause) && !inheritedReadback) continue;
    if (explained) continue;
    fragments.push([match.index, candidateValue]);
  }
  fragments.sort((left, right) => left[0] - right[0]);
  return [...new Set(fragments.map(([, value]) => value))];
}

module.exports = { cardFragmentsIn, normalizedCardExpiration, cardValuesMatch };
