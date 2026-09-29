/**
 * Structural fix (Codex round-3, PR #4946): every prior round patched a
 * Spanish number/time/phone bug at ONE regex site (a price matcher, the
 * window stripper, a readback matcher) and the next round found the same
 * class of bug at a NEW site — because each check re-implemented Spanish
 * spoken-number handling locally instead of sharing one normalizer.
 *
 * This module is that ONE shared normalizer. It runs ONCE, at the single
 * place evaluateChecks (voice-relay-replay.js) builds the graded record for
 * an `es` scenario — before ANY check regex sees the text — and converts
 * spelled-out Spanish numbers into the plain digit form the EXISTING
 * digit-based checks (price matchers, TIME_ANYWHERE_RES, windowStripper,
 * readback matchers) already understand. A downstream check that only knows
 * digits therefore closes an entire CLASS of "spelled-out Spanish number"
 * gap by construction, instead of needing its own word list.
 *
 * Deliberately conservative: every pass only fires in a narrow, unambiguous
 * context (a price immediately before "dólares/pesos", an hour immediately
 * followed by an unambiguous minute modifier, a long run of single spoken
 * digits) and leaves everything else — an article ("una visita"), a plain
 * quantity ("entre dos y cuatro habitaciones"), an ordinary hour reference
 * with no minute suffix — untouched. A run this can't confidently parse is
 * never converted; it is not, and does not need to be, a full Spanish
 * number-to-text engine.
 */

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── Cardinal number words, 0–9999 (units, tens, hundreds, thousands) ───────

const UNIDADES = Object.freeze({
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
});
const DECENAS = Object.freeze({ treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 });
const CENTENAS = Object.freeze({
  cien: 100, ciento: 100,
  doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
});
const NUMBER_TOKEN_WORDS = Object.freeze([...Object.keys(UNIDADES), ...Object.keys(DECENAS), ...Object.keys(CENTENAS), 'mil']);
// Accent-tolerant alternation for the tokens above, longest-first so e.g.
// "dieciseis" doesn't shadow-match as "diez" + leftover "iseis".
const NUMBER_WORD_ALT = NUMBER_TOKEN_WORDS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/e/g, '[eé]').replace(/o/g, '[oó]').replace(/i/g, '[ií]').replace(/a/g, '[aá]').replace(/u/g, '[uú]'))
  .join('|');
const NUMBER_RUN_RE_SRC = `(?:(?:${NUMBER_WORD_ALT})\\b(?:\\s+y\\s+|[\\s-]+)?){1,6}`;

/** A run of Spanish cardinal-number word tokens → its integer value, or NaN. */
function parseSpanishCardinal(run) {
  const tokens = strip(run).split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const raw of tokens) {
    const w = raw === 'y' ? null : raw;
    if (w === null) continue;
    if (w === 'mil') { total += (current || 1) * 1000; current = 0; seen = true; continue; }
    if (w in CENTENAS) { current += CENTENAS[w]; seen = true; continue; }
    if (w in DECENAS) { current += DECENAS[w]; seen = true; continue; }
    if (w in UNIDADES) { current += UNIDADES[w]; seen = true; continue; }
    return NaN;
  }
  return seen ? total + current : NaN;
}

// ── Pass 1: hour + minute-modifier phrases → digital "H:MM" ────────────────

// A bare hour 1–12, spoken or digit — the only context this pass touches.
const HOUR_TOKEN_SRC = '(?:1[0-2]|[1-9]|una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';
const HOUR_WORD_TO_DIGIT = Object.freeze({ una: 1, uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 });
function hourTokenToDigit(tok) {
  const t = strip(tok);
  if (/^\d+$/.test(t)) return Number(t);
  return HOUR_WORD_TO_DIGIT[t];
}
// "y <minute>" — the minute side is ENUMERATED, never "any number word":
// media (30), cuarto (15), or a spelled count of 13–59, where a compound is
// only ever tens + "y" + unit ("treinta y cinco"). Two consequences, both
// load-bearing (PR #4946 review):
//  - a 1–12 count — the exact shape a genuine "entre X y Y" range takes — is
//    not a minute at all, so "entre una y tres" never matches, and a
//    NON-match consumes nothing: "entre dos y cuatro y media" still reaches
//    "cuatro y media" (→ 4:30) instead of the range swallowing "cuatro";
//  - "una y tres y veinte" reads as "una y 3:20", never as "1:23" (the old
//    "number word (y number word)?" minute side let "tres y veinte" parse as
//    a 23-minute count).
// A minute side followed by a unit noun is a quantity, not a clock time
// ("entre dos y veinte minutos", "dos y quince por ciento") — left alone.
const accentTolerant = (w) => w.replace(/e/g, '[eé]').replace(/o/g, '[oó]').replace(/i/g, '[ií]').replace(/a/g, '[aá]').replace(/u/g, '[uú]');
const altOf = (words) => words.slice().sort((a, b) => b.length - a.length).map(accentTolerant).join('|');
const MINUTE_SINGLE_WORDS = [
  'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintiun', 'veintidos', 'veintitres', 'veinticuatro',
  'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve',
];
const MINUTE_TENS_WORDS = ['treinta', 'cuarenta', 'cincuenta'];
const MINUTE_UNIT_WORDS = ['uno', 'un', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const MINUTE_SRC = `media|cuarto|(?:${altOf(MINUTE_TENS_WORDS)})(?:\\s+y\\s+(?:${altOf(MINUTE_UNIT_WORDS)}))?|${altOf(MINUTE_SINGLE_WORDS)}`;
const QUANTITY_UNIT_AHEAD_SRC = '\\s+(?:de\\s+)?(?:minutos?|min\\b|horas?|d[ií]as?|semanas?|meses?|a[ñn]os?|veces|personas?|habitaciones?|cuartos?|ba[ñn]os?|pisos?|acres?|hect[aá]reas?|t[ée]cnicos?|mascotas?|perros?|gatos?|d[oó]lares?|pesos?|por\\s*ciento|%)';
// The first lookahead stops a backtrack from settling on a bare tens word
// when the full compound was refused ("tres y treinta y cinco minutos" must
// not become "3:30 y cinco minutos"); the second is the quantity guard.
const HOUR_Y_MINUTE_RE = new RegExp(`\\b(${HOUR_TOKEN_SRC})\\s+y\\s+(${MINUTE_SRC})\\b(?!\\s+y\\s+(?:${altOf(MINUTE_UNIT_WORDS)})\\b)(?!${QUANTITY_UNIT_AHEAD_SRC})`, 'gi');
const HOUR_MENOS_CUARTO_RE = new RegExp(`\\b(${HOUR_TOKEN_SRC})\\s+menos\\s+cuarto\\b`, 'gi');
const HOUR_EN_PUNTO_RE = new RegExp(`\\b(${HOUR_TOKEN_SRC})\\s+en\\s+punto\\b`, 'gi');
const pad2 = (n) => String(n).padStart(2, '0');

function convertHourMinutePhrases(text) {
  let out = text.replace(HOUR_Y_MINUTE_RE, (match, hourTok, minutePart) => {
    const hour = hourTokenToDigit(hourTok);
    if (hour == null) return match;
    const minuteWord = strip(minutePart);
    const minute = minuteWord === 'media' ? 30 : minuteWord === 'cuarto' ? 15 : parseSpanishCardinal(minutePart);
    if (!Number.isFinite(minute) || minute < 13 || minute > 59) return match;
    return `${hour}:${pad2(minute)}`;
  });
  out = out.replace(HOUR_MENOS_CUARTO_RE, (match, hourTok) => {
    const hour = hourTokenToDigit(hourTok);
    if (hour == null) return match;
    return `${hour === 1 ? 12 : hour - 1}:45`;
  });
  out = out.replace(HOUR_EN_PUNTO_RE, (match, hourTok) => {
    const hour = hourTokenToDigit(hourTok);
    if (hour == null) return match;
    return `${hour}:00`;
  });
  return out;
}

// ── Pass 2: spoken single digits (phone-number style) → digit characters ──

const DIGIT_WORD_SRC = '(?:cero|uno|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)';
const DIGIT_WORD_TO_DIGIT = Object.freeze({ cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 });
const DIGIT_UNIT_SRC = `(?:(?:triple|doble)\\s+${DIGIT_WORD_SRC}|${DIGIT_WORD_SRC})`;
// Only a run of SIX OR MORE digit-shaped units (a bare "una" or "dos" alone,
// as in "una visita" or "entre dos y cuatro", is one unit and never matches)
// is read as a phone number, never a price, quantity, or hour.
const DIGIT_RUN_RE = new RegExp(`\\b${DIGIT_UNIT_SRC}(?:[\\s,]+${DIGIT_UNIT_SRC}){5,}\\b`, 'gi');
const DIGIT_UNIT_RE = new RegExp(DIGIT_UNIT_SRC, 'gi');

function convertDigitStrings(text) {
  return text.replace(DIGIT_RUN_RE, (run) => run.replace(DIGIT_UNIT_RE, (unit) => {
    const m = /^(triple|doble)\s+(\w+)$/i.exec(unit.trim()) || [null, null, unit.trim()];
    const digit = DIGIT_WORD_TO_DIGIT[strip(m[2])];
    if (digit == null) return unit;
    return m[1] ? String(digit).repeat(strip(m[1]) === 'triple' ? 3 : 2) : String(digit);
  }));
}

// ── Pass 3: a price's number-word run (immediately before dólares/pesos, or
// a pricing-unit phrase like "por aplicación") ─────────────────────────────

// Codex round-6 P1: "cuesta ciento diecinueve por aplicación" (no currency
// word at all — the unit alone names it as a price) never converted, so the
// new amount_requires_unit check saw only word text and reported the price
// "never quoted". The pricing-unit lookahead consumes nothing, leaving "por
// aplicación"/"cada aplicación" itself untouched right after the digits.
// Codex pre-push on #4946: any billing unit names a price too, not only
// "por aplicación" — "noventa y nueve al año" must reach the plan-total and
// unit checks as "99 al año" — and so does a price verb before the figure
// ("el premium cuesta noventa y nueve"). Both need a two-digit amount
// (priceRe's own rule): a smaller one is a count ("dos por mes"), and a
// count before its noun ("nueve aplicaciones al año") never matches at all.
// Codex r13: before YEAR ("al año", "por año") a figure under 25 is an
// application count, not a price ("doce por año" = twelve applications a
// year), so only integer 0–24 stays exempt there. A decimal is a price even
// below 25. Every other unit needs 10+ — "veinte al mes" is a price (PR
// review): nothing is applied ten times a month.
const BILLING_UNIT_AHEAD_ES = '(?=(?:por|cada|al|a\\s+la)\\s+(?:(aplicaci[oó]n(?:es)?|tratamientos?|visitas?|servicios?|mes(?:es)?|semanas?|trimestres?)|(a[ñn]os?))(?![a-záéíóúñ]))';
const PRICE_WORD_RUN_RE = new RegExp(`\\b(${NUMBER_RUN_RE_SRC})(?:(d[oó]lares?|pesos?)\\b|${BILLING_UNIT_AHEAD_ES})`, 'gi');
// Shared with the downstream amount matcher so every conjugation that makes
// a bare figure a price is normalized before grading sees it.
const PRICE_VERB_ES = '(?:cobr(?:o|as|a|amos|an|ar(?:[ée]|emos|[ée]is|[áa](?:s|n)?|[íi]a(?:s|mos|is|n)?))|pag(?:o|as|a|amos|an|ar(?:[ée]|emos|[ée]is|[áa](?:s|n)?|[íi]a(?:s|mos|is|n)?)?)|cuestan?|costar[íi]an?|costar[áa]n?|valen?|sale(?:n)?\\s+(?:en|a)|precio\\s+(?:es|de|ser[íi]a))';
const PRICE_VERB_WORD_RUN_RE = new RegExp(`(\\b${PRICE_VERB_ES}\\s+(?:de\\s+)?)(${NUMBER_RUN_RE_SRC})`, 'gi');

// Codex r10 on #4946: "ciento diecinueve con noventa y nueve por aplicación"
// has no currency word or price verb, so the passes below would convert the
// cents run on its own (it sits right before "por aplicación") and leave
// "ciento diecinueve con 99" — whole and cents parsed as two figures. The
// whole "<words> con <words|digits> (centavos)" phrase converts FIRST, in
// one step, whenever it reads as a price (a whole of 10+, cents 1–99, and a
// price context right after it).
const DECIMAL_CONNECTOR = '(con|coma|punto|point)';
const WHOLE_AND_CENTS_WORDS_RE = new RegExp(`\\b(${NUMBER_RUN_RE_SRC})${DECIMAL_CONNECTOR}\\s+(\\d{1,2}(?!\\d)\\s*|${NUMBER_RUN_RE_SRC})(?:centavos?\\s*)?(?=(?:d[oó]lares?\\b|por\\b|cada\\b|al\\b|[.,;!?]|$))`, 'gi');
function decimalDigits(run, connector) {
  const raw = strip(run).trim();
  let digits;
  if (/^\d{1,2}$/.test(raw)) digits = raw;
  else {
    const words = raw.split(/\s+/).filter((word) => word !== 'y');
    digits = words.length > 1 && words.every((word) => word in UNIDADES && UNIDADES[word] < 10)
      ? words.map((word) => UNIDADES[word]).join('')
      : String(parseSpanishCardinal(raw));
  }
  if (!/^\d{1,2}$/.test(digits)) return null;
  if (connector === 'con') return Number(digits) <= 99 ? digits.padStart(2, '0') : null;
  return digits;
}
function convertWholeAndCents(text) {
  return text.replace(WHOLE_AND_CENTS_WORDS_RE, (match, wholeRun, connector, centsRun) => {
    const whole = parseSpanishCardinal(wholeRun);
    const fraction = decimalDigits(centsRun, connector.toLowerCase());
    // A whole below 10 is a price only with an explicit decimal separator:
    // "nueve punto noventa y nueve" is 9.99, "dos con cinco" stays words.
    if (!Number.isFinite(whole) || (whole < 10 && connector.toLowerCase() === 'con') || fraction === null) return match;
    return `${whole}.${fraction}${/\s$/.test(match) ? ' ' : ''}`;
  });
}

// Bare annual whole numbers below 25 describe application frequency. A
// decimal cannot be an application count. Currency markers and price verbs
// establish a price separately; they never use this exemption. Share the
// rule with both disclosure and unit grading.
function isBareAnnualCount(amount) {
  return Number.isInteger(amount) && amount >= 0 && amount < 25;
}

function convertPriceWordRuns(text) {
  // A digit-led decimal ("119 punto nueve nueve por aplicación") merges
  // before the word-run pass: that pass would otherwise sum the fraction's
  // digit words ("nueve nueve" → 18) and leave "119 punto 18".
  const out = mergeCents(convertWholeAndCents(text)).replace(PRICE_WORD_RUN_RE, (match, run, currencyWord, otherUnit, yearUnit) => {
    const amount = parseSpanishCardinal(run);
    if (!Number.isFinite(amount)) return match;
    if (currencyWord) return `${amount} ${currencyWord}`;
    const isPrice = yearUnit ? !isBareAnnualCount(amount) : amount >= 10;
    return isPrice ? `${amount} ` : match;
  });
  const convertLed = (t, re) => t.replace(re, (match, lead, run) => {
    const amount = parseSpanishCardinal(run);
    if (!Number.isFinite(amount) || amount < 10) return match;
    return `${lead}${amount}${/\s$/.test(run) ? ' ' : ''}`;
  });
  return mergeCents(convertLed(convertLed(out, PRICE_VERB_WORD_RUN_RE), PLAN_COPULA_WORD_RUN_RE));
}

// Codex r11 on #4946: a copular plan price ("el premium es ciento
// cincuenta") — a plan/price noun, then es/son/sería/queda en, then the
// figure — is a price too; a count right after it ("son doce aplicaciones")
// is not.
const PLAN_NOUN_ES = '(?:programa|plan|premium|mejorado|b[aá]sico|servicio|tratamiento|precio|opci[oó]n|paquete|costo|tarifa)';
const COUNT_AHEAD_ES = '(?!\\s*(?:pies|metros|aplicaciones|visitas|veces|meses|a[ñn]os|d[ií]as|semanas|horas|minutos|por\\s*ciento|%))';
const PLAN_COPULA_WORD_RUN_RE = new RegExp(`(\\b${PLAN_NOUN_ES}\\b[^.!?;,\\d]{0,30}?\\b(?:es|son|ser[íi]an?|queda\\s+en|est[áa]\\s+en)\\s+(?:de\\s+)?)(${NUMBER_RUN_RE_SRC})${COUNT_AHEAD_ES}`, 'gi');

// Codex pre-push on #4946: a converted figure followed by its cents
// ("119 dólares con noventa y nueve centavos", "119 con noventa y nueve")
// is ONE amount — grading only the integer prefix would read $119.99 as
// the returned $119. Merged atomically into "119.99"; a tail that does not
// parse as 1–99 cents is left untouched.
// The cents may already be digits: an earlier pass converts "noventa y
// nueve" before "por aplicación" on its own, so both forms are accepted.
const CENTS_SRC = `(?:\\d{1,2}(?!\\d)\\s*|${NUMBER_RUN_RE_SRC})`;
const CENTS_AFTER_CURRENCY_RE = new RegExp(`\\b(\\d+)\\s*(d[oó]lares?)\\s+${DECIMAL_CONNECTOR}\\s+(${CENTS_SRC})\\s*(?:centavos?)?`, 'gi');
const CENTS_BARE_RE = new RegExp(`\\b(\\d+)\\s+${DECIMAL_CONNECTOR}\\s+(${CENTS_SRC})(?:\\s*centavos?)?(?=\\s*(?:d[oó]lares?\\b|por\\b|cada\\b|al\\b|[.,;!?]|$))`, 'gi');
function mergeCents(text) {
  const a = text.replace(CENTS_AFTER_CURRENCY_RE, (match, whole, currency, connector, run) => {
    const fraction = decimalDigits(run, connector.toLowerCase());
    return fraction !== null ? `${whole}.${fraction} ${currency}${/\s$/.test(match) ? ' ' : ''}` : match;
  });
  return a.replace(CENTS_BARE_RE, (match, whole, connector, run) => {
    const fraction = decimalDigits(run, connector.toLowerCase());
    return fraction !== null ? `${whole}.${fraction}${/\s$/.test(match) ? ' ' : ''}` : match;
  });
}

// ── Pass 4: grouped Spanish CARDINALS (phone-number style) → digit groups ──

// Codex round-6 P1: a caller/agent reads a phone number back in NATURAL
// GROUPS ("novecientos cuarenta y uno, quinientos cincuenta y cinco, cero
// dos cuarenta y seis" = 941, 555, 0246), not only as single spoken digits
// (Pass 2 above already handles "nueve cuatro uno…"). Pass 2's DIGIT_WORD_SRC
// only knows 0–9, so a compound like "cuarenta y seis" (46) or "novecientos
// cuarenta y uno" (941) never matched it. This pass chunks a run of Spanish
// cardinal-number tokens into the maximal valid numbers Spanish grammar
// actually allows (hundreds, optionally + tens (+"y"+ units) or + a bare
// unit directly; a tens word alone, optionally +"y"+ units; a teens/veinti
// word or a bare digit alone; "cero" always its own chunk) and concatenates
// their digits — but ONLY when that concatenation is unambiguously
// phone-shaped: 7–11 digits from 3 or more chunks. A price ("noventa y
// nueve dólares"), a quantity ("entre dos y cuatro habitaciones") or an hour
// either has too FEW chunks (a single price or a single hour+minute phrase
// is 1 chunk) or is walled off by Pass 1/3's own currency/duration word
// immediately breaking the run — so neither is ever swept in by this pass.
function chunkPhoneCardinals(tokens) {
  const chunks = [];
  let current = null; // { value, stage: 'centena' | 'decena' }
  let pendingY = false;
  const closeCurrent = () => { if (current !== null) { chunks.push(current.value); current = null; } };
  for (const raw of tokens) {
    const w = strip(raw);
    if (w === 'y') {
      // "y" only ever glues a completed tens word to its trailing unit
      // ("cuarenta Y uno") — anywhere else ("dos Y cuatro", a range
      // connector) this is not a phone-cardinal run at all.
      if (current && current.stage === 'decena') { pendingY = true; continue; }
      return null;
    }
    if (pendingY && !(w in UNIDADES)) return null;
    if (w === 'cero') {
      closeCurrent();
      chunks.push(0);
      pendingY = false;
      continue;
    }
    if (w in CENTENAS) {
      closeCurrent();
      current = { value: CENTENAS[w], stage: 'centena' };
      pendingY = false;
      continue;
    }
    if (w in DECENAS) {
      if (current && current.stage === 'centena') { current.value += DECENAS[w]; current.stage = 'decena'; } else {
        closeCurrent();
        current = { value: DECENAS[w], stage: 'decena' };
      }
      pendingY = false;
      continue;
    }
    if (w in UNIDADES) {
      // A units word right after a units word (nothing pending) is a NEW
      // chunk — Spanish never concatenates two bare units into one number.
      if (pendingY && current && current.stage === 'decena') { current.value += UNIDADES[w]; closeCurrent(); } else if (current && current.stage === 'centena') { current.value += UNIDADES[w]; closeCurrent(); } else {
        closeCurrent();
        chunks.push(UNIDADES[w]);
      }
      pendingY = false;
      continue;
    }
    return null; // "mil" or anything else — not a valid cardinal chunk shape
  }
  closeCurrent();
  return pendingY ? null : chunks; // a trailing "y" with nothing after it
}

const PHONE_GROUP_TOKEN_SRC = `(?:${NUMBER_WORD_ALT})`;
// A run of 3+ cardinal tokens, comma/space (or "y") separated, not
// immediately followed by a currency word — a real phone-number readback is
// never adjacent to "dólares"/"pesos", and this keeps a spelled-out price
// run ("noventa y nueve dólares") out even if grammar alone wouldn't.
const PHONE_GROUP_RUN_RE = new RegExp(`\\b${PHONE_GROUP_TOKEN_SRC}\\b(?:(?:\\s+y\\s+|[\\s,]+)${PHONE_GROUP_TOKEN_SRC}\\b){2,30}(?!\\s*(?:d[oó]lares?|pesos?|por\\s*ciento|%))`, 'gi');

function convertPhoneCardinalGroups(text) {
  return text.replace(PHONE_GROUP_RUN_RE, (match) => {
    const tokens = match.trim().split(/[\s,]+/).filter(Boolean);
    const chunks = chunkPhoneCardinals(tokens);
    if (!chunks || chunks.length < 3) return match;
    const digits = chunks.join('');
    if (digits.length < 7 || digits.length > 11) return match;
    return chunks.join(' ');
  });
}

/**
 * Normalizes spelled-out Spanish numbers, hour+minute phrases, and spoken
 * phone-digit strings in agent-spoken text to plain digits, so the existing
 * digit-based checks (prices, times, readbacks) see them without needing
 * their own Spanish word list. Idempotent — safe to call more than once on
 * the same text (already-digit spans are inert to every pass's word regex).
 */
function normalizeSpanishSpokenText(text) {
  if (typeof text !== 'string' || !text) return text;
  // "a. m."/"p. m." (the written Spanish form, with a space) first: the
  // sentence splitter breaks on ". ", which would otherwise cut a spoken
  // time in half before any time check sees it. Same rewrite as
  // voice-relay-spoken-language.js's normalizeTimeAbbreviations.
  let out = text.replace(/\b([ap])\.\s*m\./gi, '$1m');
  out = convertHourMinutePhrases(out);
  out = convertDigitStrings(out);
  out = convertPriceWordRuns(out);
  out = convertPhoneCardinalGroups(out);
  return out;
}

module.exports = {
  normalizeSpanishSpokenText,
  parseSpanishCardinal,
  isBareAnnualCount,
  PRICE_VERB_ES,
  _internals: { convertHourMinutePhrases, convertDigitStrings, convertPriceWordRuns, convertPhoneCardinalGroups, chunkPhoneCardinals, UNIDADES, DECENAS, CENTENAS },
};
