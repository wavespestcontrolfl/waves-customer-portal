/**
 * Dictated dollar amounts, read the way the operator said them (GATE_DICTATION_MONEY_NORMALIZE).
 *
 * The staff mic's transcriber hears "sixty-one thirty-three" and writes "6133", "$60.33" or
 * "$61.33". Staff mean $61.33. normalizeSpokenMoney(text) fixes the forms that are unambiguous
 * and FLAGS the one that is not, in a text that already has a money cue next to the number:
 *
 *   "sixty-one thirty-three a month"            -> "$61.33 a month"
 *   "charge 61 33"                               -> "charge $61.33"
 *   "sixty one dollars and thirty three cents"   -> "$61.33"
 *   "six thousand one hundred thirty three dollars" -> "$6,133"   (an explicit thousand is not ambiguous)
 *   "a hundred and five dollars"                 -> "$105"
 *   "6133 a month" / "$6133"                     -> digits kept, ambiguous: [{ heard: '6133', candidates: ['$61.33', '$6,133'] }]
 *
 * A money cue is a "$" or a money word (price, charge, cost, dollars, bucks, rate, a month,
 * per visit, invoice, pay, paid, total, amount, quote, fee...) within a few words, in the same
 * sentence. Nothing else is touched: phone numbers, street numbers, times, dates, ZIPs, invoice
 * and ticket numbers, and numbers followed by a unit (oz, gallons, sq ft, lbs...) pass through.
 *
 * Pure: no I/O, no gate read. The route decides whether to call it.
 * Returns { text, changes: [{ from, to, kind }], ambiguous: [{ heard, candidates }] }.
 */

const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ONES_RE = `(?:${ONES.join('|')})`;
const TEENS_RE = `(?:${TEENS.join('|')})`;
const TENS_RE = `(?:${TENS.join('|')})`;

const WORD_VALUE = new Map();
ONES.forEach((w, i) => WORD_VALUE.set(w, i + 1));
TEENS.forEach((w, i) => WORD_VALUE.set(w, 10 + i));
TENS.forEach((w, i) => WORD_VALUE.set(w, 20 + i * 10));

// 1..99 in words: "sixty-one", "sixty one", "thirteen", "fifty", "nine"
const U100 = `(?:${TENS_RE}(?:[-\\s]${ONES_RE})?|${TEENS_RE}|${ONES_RE})`;
// 100..999 in words with an explicit "hundred": "a hundred and five", "two hundred fifty"
const HUNDREDS = `(?:(?:${ONES_RE}|a)\\s+hundred(?:\\s+(?:and\\s+)?${U100})?)`;
const U1000 = `(?:${HUNDREDS}|${U100})`;
// a number with an explicit hundred or thousand in it (value >= 100)
const BIG = `(?:(?:${U1000}|a)\\s+thousand(?:\\s+(?:and\\s+)?${U1000})?|${HUNDREDS})`;
// any 1..999,999 in words (dollar and cent counts)
const ANY = `(?:${BIG}|${U100})`;
const NUMWORD_RE = `(?:${[...ONES, ...TEENS, ...TENS, 'hundred', 'thousand'].join('|')})`;

const MONEY_WORD = new RegExp(
  '(?:\\$|\\b(?:price[ds]?|pricing|charge[ds]?|charging|cost[s]?|dollars?|bucks?|rates?|monthly|'
  + 'per\\s+(?:month|visit|service|treatment|application|mo)|a\\s+month|each\\s+(?:visit|month)|invoice[ds]?|'
  + 'pa(?:y|id|ying|ys|yment)|total|amount|quote[ds]?|fees?|bill(?:ed|ing)?|cents?|owe[sd]?|refund(?:ed)?|'
  + 'discount(?:ed)?|balance|every\\s+month)\\b|/\\s?mo\\b)',
  'i',
);

// A number that names a record, not an amount.
const IDENTIFIER_BEFORE = /(?:\b(?:invoice|inv|ticket|order|account|acct|confirmation|job|number|no|unit|apt|apartment|suite|ste|lot|room|route|zip)\b\.?|#)\s*(?:number|no\.?|#)?\s*(?:is|was|of)?\s*#?\s*$/i;
const UNIT_AFTER = /^\s*(?:cents?|oz|ounces?|fl|gal|gals|gallons?|lbs?|pounds?|sq\.?\s*ft|square\s+(?:feet|foot)|sf|feet|foot|ft|inch(?:es)?|acres?|minutes?|mins?|hours?|hrs?|seconds?|days?|weeks?|years?|months?\s+(?:ago|old)|percent|%|x\b|bags?|units?|stops?|ml|liters?|litres?|pints?|quarts?|miles?|mi\b|mph|degrees?|psi|ppm|bait\s+stations?|stations?|traps?|points?|pieces?|people|customers?|houses?|homes?|doors?|windows?|rooms?)\b/i;
const STREET_AFTER = /^\s+(?:[A-Za-z'.]+\s+){0,2}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|pt|point)\b/i;
const CLOCK_AFTER = /^\s*(?:a\.?\s?m\b|p\.?\s?m\b|o'?clock|in\s+the\s+(?:morning|afternoon|evening)|tomorrow|today|tonight)/i;
const CLOCK_BEFORE = /\b(?:at|by|around|before|after|until|till|from|between)\s+$/i;
const DATE_BEFORE = /\b(?:dated|since|year|january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\w+\s+)?$/i;
const PRICE_AFTER = /^\s*(?:dollars?|bucks?|a\s+month|per\b|each\b|\/\s?mo|monthly|every\b)/i;

const fmtDollars = (n) => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const fmtDollarsCents = (dollars, cents) => `$${dollars}.${String(cents).padStart(2, '0')}`;

/** The number a run of number words says, or null. Handles "a hundred", "two thousand", "x hundred and y". */
function wordsToNumber(raw) {
  const tokens = String(raw).toLowerCase().split(/[-\s]+/).filter((t) => t && t !== 'and');
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (t === 'a') current = current || 1;
    else if (t === 'hundred') current = (current || 1) * 100;
    else if (t === 'thousand') { total += (current || 1) * 1000; current = 0; } else if (WORD_VALUE.has(t)) current += WORD_VALUE.get(t);
    else return null;
  }
  return total + current;
}

/** A few words either side of the match, cut at the sentence end. */
function windows(text, start, end) {
  let before = text.slice(Math.max(0, start - 50), start);
  let after = text.slice(end, end + 50);
  const cut = before.search(/[.!?;]\s+(?=[^.!?;]*$)/);
  if (cut >= 0) before = before.slice(cut + 1);
  const cutAfter = after.search(/[.!?;](?:\s|$)/);
  if (cutAfter >= 0) after = after.slice(0, cutAfter);
  const lastWords = (s, n) => s.trim().split(/\s+/).slice(-n).join(' ');
  const firstWords = (s, n) => s.trim().split(/\s+/).slice(0, n).join(' ');
  return {
    beforeRaw: text.slice(Math.max(0, start - 50), start),
    afterRaw: text.slice(end, end + 50),
    cue: `${lastWords(before, 5)} ${firstWords(after, 5)}`,
    nearBefore: lastWords(before, 5),
    nearAfter: firstWords(after, 5),
  };
}

/** True when the number at [start, end) has a money cue next to it and is not an identifier, quantity, address or time. */
function moneyHere(text, start, end, { clock = null, consumedMoney = false } = {}) {
  const w = windows(text, start, end);
  if (IDENTIFIER_BEFORE.test(w.beforeRaw)) return false;
  if (UNIT_AFTER.test(w.afterRaw)) return false;
  if (!consumedMoney && DATE_BEFORE.test(w.beforeRaw)) return false;
  if (STREET_AFTER.test(w.afterRaw)) return false;
  const cued = consumedMoney || MONEY_WORD.test(w.cue) || /\$\s*$/.test(w.beforeRaw);
  if (!cued) return false;
  if (clock && !consumedMoney) {
    const [h, m] = clock;
    if (h >= 1 && h <= 12 && m <= 59 && !PRICE_AFTER.test(w.afterRaw)
      && (CLOCK_AFTER.test(w.afterRaw) || CLOCK_BEFORE.test(w.beforeRaw))) return false;
  }
  return true;
}

function normalizeSpokenMoney(input) {
  const original = typeof input === 'string' ? input : '';
  const changes = [];
  const ambiguous = [];
  let text = original;
  if (!text.trim()) return { text: original, changes, ambiguous };

  const apply = (re, replacer) => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let out = '';
    let last = 0;
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m[0] === '') { rx.lastIndex += 1; continue; }
      const r = replacer(m, m.index, m.index + m[0].length);
      if (r == null) continue;
      out += text.slice(last, m.index) + r.to;
      last = m.index + m[0].length;
      changes.push({ from: m[0], to: r.to, kind: r.kind });
    }
    text = out + text.slice(last);
  };

  // 1. "sixty one dollars and thirty three cents" / "61 dollars 33 cents" -> $61.33
  apply(new RegExp(`(?<![\\w$.,-])(?<!${NUMWORD_RE}[-\\s])(?<!${NUMWORD_RE}\\s+and\\s)(${ANY}|\\d{1,6})\\s+dollars?(?:\\s+and)?\\s+(${U100}|\\d{1,2})\\s+cents?\\b`, 'i'), (m, s, e) => {
    const d = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
    const c = /^\d+$/.test(m[2]) ? Number(m[2]) : wordsToNumber(m[2]);
    if (d == null || c == null || c > 99) return null;
    if (IDENTIFIER_BEFORE.test(text.slice(Math.max(0, s - 50), s))) return null;
    return { to: fmtDollarsCents(fmtDollars(d).slice(1), c), kind: 'dollars-and-cents' };
  });

  // 2. Two spoken numbers, dollars then cents: "sixty-one thirty-three" -> $61.33
  apply(new RegExp(
    `(?<![\\w$.,-])(?<!${NUMWORD_RE}[-\\s])(?<!\\band\\s)(${U100})\\s+(${TENS_RE}(?:[-\\s]${ONES_RE})?|${TEENS_RE})(?![\\w-])(?!\\s+(?:hundred|thousand)\\b)(?![-\\s]+${NUMWORD_RE}\\b)(\\s+dollars?\\b)?`, 'i',
  ), (m, s, e) => {
    const d = wordsToNumber(m[1]);
    const c = wordsToNumber(m[2]);
    if (d == null || c == null || c < 10 || c > 99) return null;
    if ((d === 19 || d === 20) && !m[3]) return null; // "twenty twenty-six" is a year
    if (!moneyHere(text, s, e, { clock: [d, c], consumedMoney: Boolean(m[3]) })) return null;
    return { to: fmtDollarsCents(d, c), kind: 'words-pair' };
  });

  // 3. A number with an explicit hundred or thousand, said in words: "a hundred and five" -> $105
  //    (a money cue is required; "N dollars" itself is a cue). "fifty dollars" -> $50.
  // Whole phrase only: a number word right before or after ("twenty five hundred", "one hundred twenty five fifty")
  // means the run is not one amount this pass understands, so it is left as heard.
  apply(new RegExp(`(?<![\\w$.,-])(?<!${NUMWORD_RE}[-\\s])(?<!${NUMWORD_RE}\\s+and\\s)(${BIG}|${U100}(?=\\s+(?:dollars?|bucks?)\\b))(?![-\\s]+(?:and\\s+)?${NUMWORD_RE}\\b)(\\s+(?:dollars?|bucks?)\\b)?(?![\\w-])`, 'i'), (m, s, e) => {
    const n = wordsToNumber(m[1]);
    if (n == null || n < 1) return null;
    const consumed = Boolean(m[2]);
    if (!consumed && !/\b(?:hundred|thousand)\b/i.test(m[1])) return null;
    if (!consumed && n >= 1900 && n <= 2100) return null; // "two thousand twenty six" is a year
    const afterStart = s + m[1].length; // the unit check runs after the number, past a consumed "dollars"
    if (!moneyHere(text, s, consumed ? afterStart : e, { consumedMoney: consumed })) return null;
    return { to: fmtDollars(n), kind: 'words' };
  });

  // 4. Two groups of digits: "61 33 a month" -> $61.33
  apply(/(?<![\w$.,:/#-])(?<!\d\s)(\d{1,3})[ ]+(\d{2})(?!\w)(?![.,:/-]\d)(?!\s+\d)(\s+dollars?\b)?/i, (m, s, e) => {
    const d = Number(m[1]);
    const c = Number(m[2]);
    if (d < 1 || ((d === 19 || d === 20) && !m[3])) return null; // "20 26" is a year
    if (!moneyHere(text, s, e, { clock: [d, c], consumedMoney: Boolean(m[3]) })) return null;
    return { to: fmtDollarsCents(d, c), kind: 'digits-pair' };
  });

  // 5. A run-together four-digit amount in a money text: "$6133", "6133 dollars", "charge 6133 a month".
  //    Could be $61.33 or $6,133. Keep the digits and flag it. 1000..2000 is a believable price.
  const seen = new Set();
  const fourDigits = /(?<![\w$.,:/#-])(?<!\d\s)(\$?\s?)(\d{4})(?!\w)(?![.,:/-]\d)/g;
  let m;
  while ((m = fourDigits.exec(text)) !== null) {
    const heard = m[2];
    const value = Number(heard);
    const start = m.index;
    const end = m.index + m[0].length;
    const dollarSign = m[1].includes('$');
    if (value <= 2000) continue;
    const nextIsDollars = PRICE_AFTER.test(text.slice(end, end + 30)) || /^\s*(?:dollars?|bucks?)\b/i.test(text.slice(end, end + 12));
    if (value >= 2001 && value <= 2100 && !dollarSign && !nextIsDollars) continue; // a year
    if (!moneyHere(text, start, end, { consumedMoney: dollarSign })) continue;
    if (seen.has(heard)) continue;
    seen.add(heard);
    ambiguous.push({ heard, candidates: [fmtDollarsCents(Number(heard.slice(0, 2)), Number(heard.slice(2))), fmtDollars(value)] });
  }

  return { text, changes, ambiguous };
}

/**
 * The one system-prompt note the Intelligence Bar adds when the operator's dictation carried an
 * ambiguous amount (GATE_DICTATION_MONEY_NORMALIZE). Takes the client's `dictation_money` list;
 * keeps only well-formed entries whose digits really are four characters (the client is not trusted
 * with prompt text), at most three. Returns '' when there is nothing to say.
 */
function ambiguousAmountNote(list) {
  if (!Array.isArray(list)) return '';
  const lines = [];
  for (const item of list) {
    const heard = String(item?.heard || '').trim();
    if (!/^\d{4}$/.test(heard)) continue;
    const cents = fmtDollarsCents(Number(heard.slice(0, 2)), Number(heard.slice(2)));
    const whole = fmtDollars(Number(heard));
    const line = `The operator's dictated amount '${heard}' is ambiguous: ask with offer_choices between ${cents} and ${whole} before using it.`;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length >= 3) break;
  }
  return lines.length ? `\n\nDICTATED AMOUNTS:\n${lines.join('\n')}` : '';
}

module.exports = { normalizeSpokenMoney, ambiguousAmountNote, wordsToNumber };
