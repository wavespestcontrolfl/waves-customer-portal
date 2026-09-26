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
// "y <minute>" — media (30) and cuarto (15) are unambiguous; a spelled
// number is accepted ONLY when it parses to 13–59. A minute count of 1–12
// is the exact shape a genuine "entre X y Y" / "de X a Y" RANGE also takes
// ("entre dos y cuatro", "la una y tres") — since Spanish never says a
// single-digit minute count bare like that in practice ("la una y tres"
// meaning 1:03 is vanishingly rare next to "la una y tres" meaning a
// caller's own picked hour beside a range), leaving 1–12 unconverted here
// is what keeps a real range intact instead of manufacturing a fake time.
const HOUR_Y_MINUTE_RE = new RegExp(`\\b(${HOUR_TOKEN_SRC})\\s+y\\s+(media|cuarto|(?:${NUMBER_WORD_ALT})(?:\\s+y\\s+(?:${NUMBER_WORD_ALT}))?)\\b`, 'gi');
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

// ── Pass 3: a price's number-word run (immediately before dólares/pesos) ──

const PRICE_WORD_RUN_RE = new RegExp(`\\b(${NUMBER_RUN_RE_SRC})(d[oó]lares?|pesos?)\\b`, 'gi');

function convertPriceWordRuns(text) {
  return text.replace(PRICE_WORD_RUN_RE, (match, run, currencyWord) => {
    const amount = parseSpanishCardinal(run);
    if (!Number.isFinite(amount)) return match;
    return `${amount} ${currencyWord}`;
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
  let out = convertHourMinutePhrases(text);
  out = convertDigitStrings(out);
  out = convertPriceWordRuns(out);
  return out;
}

module.exports = {
  normalizeSpanishSpokenText,
  parseSpanishCardinal,
  _internals: { convertHourMinutePhrases, convertDigitStrings, convertPriceWordRuns, UNIDADES, DECENAS, CENTENAS },
};
