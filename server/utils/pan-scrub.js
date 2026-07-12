/**
 * PAN (card number) scrubber for call transcripts.
 *
 * Phase 0 of docs/card-on-file-booking-build-spec.md: with card-on-file as
 * the booking gate, customers WILL sometimes blurt a card number on a
 * recorded line despite the text-the-link policy. A PAN must never persist
 * (call_log.transcription / transcript_structured / message mirrors) and
 * must never reach an LLM prompt (labeling, extraction, CSR coach, corpus
 * miner, KB). This module makes a blurted card number a non-event: Luhn-
 * validated 13–19-digit candidates are masked to their last4.
 *
 * Deliberately dependency-free (no logger, no db) so it can run inside the
 * transcription hot path and be required from webhook routes without cycles.
 *
 * Matching model (Codex #2676 round-1: a PAN read back-to-back with an
 * expiry/CVV — "4242 4242 4242 4242 12 28" — must not survive because the
 * combined digit run fails Luhn):
 *
 *  - NUMERIC: a maximal digit run (digits joined by single space/dash
 *    separators) is split into its separator-delimited GROUPS, and every
 *    consecutive group-span totalling 13–19 digits is a candidate —
 *    longest-first, leftmost-first, non-overlapping. Group boundaries are
 *    the natural card-readback structure ("4242 4242 4242 4242" + trailing
 *    "12 28" → the 4-group span masks, the expiry stays), and they make
 *    adjacent phone numbers structurally unmatchable (a "10 10" run has no
 *    13–19 span), so no Luhn coincidence can eat contact numbers.
 *  - SPOKEN-DIGIT: 13+ consecutive digit words ("four two four two…",
 *    "oh" = zero). Candidates are prefix-anchored windows (card readbacks
 *    lead the run; expiry/CVV trail it), longest-first.
 *  - Both gate on Luhn AND an issuer-prefix check (first digit 2–6 — Visa/
 *    MC/Amex/Discover/JCB space) before masking. Runs over 40 digits are
 *    ignored (bulk ID dumps, not readbacks).
 *  - CVV CONTEXT: "cvv/cvc/security code …" followed by 3–4 digits (or
 *    digit words) is masked to "[code removed]" — a read-aloud CVV must not
 *    outlive the call even when no PAN is nearby. 3–4 digit runs WITHOUT
 *    that context are untouched (unmatchable noise otherwise).
 *
 * The mask keeps last4 ("[card ending 4242]") — enough for the office to
 * reconcile with Stripe, never enough to charge. Known residual: a PAN with
 * expiry/CVV appended with NO separator at all ("…4242123") forms one
 * indivisible >19-digit group and is left as-is; diarized transcripts
 * separate spoken number groups, so this shape does not occur in practice.
 */

function luhnValid(digits) {
  if (typeof digits !== 'string' || !/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// First digit of every real card network (Visa 4, MC 5x/2xxx, Amex 3x,
// Discover 6x, JCB 3x). Excludes 0/1/7/8/9 — which removes most US phone
// shapes before Luhn even runs.
function plausibleIin(digits) {
  const first = digits.charCodeAt(0) - 48;
  return first >= 2 && first <= 6;
}

function panCandidateValid(digits) {
  return plausibleIin(digits) && luhnValid(digits);
}

function maskFor(digits) {
  return `[card ending ${digits.slice(-4)}]`;
}

// Maximal digit run: digits joined by single space/dash separators.
const NUMERIC_RUN_RE = /(?<![\d-])\d(?:[ -]?\d)*(?![\d-])/g;
const MAX_RUN_DIGITS = 40;

// Scrub one numeric run via group-span search. Returns the replacement
// string for the run and how many PANs were masked.
function scrubNumericRun(run) {
  // Split into groups while tracking each group's char offsets in the run.
  const groups = [];
  const groupRe = /\d+/g;
  let g;
  while ((g = groupRe.exec(run)) !== null) {
    groups.push({ digits: g[0], start: g.index, end: g.index + g[0].length });
  }
  const totalDigits = groups.reduce((n, grp) => n + grp.digits.length, 0);
  if (totalDigits < 13 || totalDigits > MAX_RUN_DIGITS) return { text: run, count: 0 };

  let count = 0;
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < groups.length) {
    // Longest valid span starting at group i (sum capped at 19).
    let matched = null;
    let sum = 0;
    const sums = [];
    for (let j = i; j < groups.length; j += 1) {
      sum += groups[j].digits.length;
      if (sum > 19) break;
      sums.push({ j, sum });
    }
    for (let k = sums.length - 1; k >= 0; k -= 1) {
      if (sums[k].sum < 13) break;
      const spanDigits = groups.slice(i, sums[k].j + 1).map((grp) => grp.digits).join('');
      if (panCandidateValid(spanDigits)) {
        matched = { endGroup: sums[k].j, digits: spanDigits };
        break;
      }
    }
    if (matched) {
      out += run.slice(cursor, groups[i].start) + maskFor(matched.digits);
      cursor = groups[matched.endGroup].end;
      i = matched.endGroup + 1;
      count += 1;
      // Absorb trailing expiry/CVV-shaped groups (≤4 digits, up to 3 of
      // them) from the same run: "…4242 12 28 123" must not leave a CVV
      // sitting next to the mask it belongs to.
      let absorbed = 0;
      while (i < groups.length && groups[i].digits.length <= 4 && absorbed < 3) {
        cursor = groups[i].end;
        i += 1;
        absorbed += 1;
      }
      if (absorbed > 0) out += ' [code removed]';
    } else {
      i += 1;
    }
  }
  out += run.slice(cursor);
  return { text: out, count };
}

const DIGIT_WORDS = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const DIGIT_WORD_ALT = Object.keys(DIGIT_WORDS).join('|');
// Maximal spoken-digit run: 13+ digit words (candidate windows are carved
// inside, so the run itself may include trailing expiry/CVV words).
const WORD_RUN_RE = new RegExp(
  `\\b(?:(?:${DIGIT_WORD_ALT})[ ,]+){12,}(?:${DIGIT_WORD_ALT})\\b`,
  'gi'
);

// Prefix-anchored window search over a spoken-digit run: the card readback
// leads the run; expiry/CVV words trail it.
function scrubSpokenRun(run) {
  const words = run.split(/[ ,]+/);
  const digits = words.map((w) => DIGIT_WORDS[w.toLowerCase()] ?? '').join('');
  if (digits.length > MAX_RUN_DIGITS) return { text: run, count: 0 };
  const maxLen = Math.min(19, digits.length);
  for (let len = maxLen; len >= 13; len -= 1) {
    const candidate = digits.slice(0, len);
    if (panCandidateValid(candidate)) {
      // Mask the first `len` words. A short spoken tail (≤8 digit words) is
      // the expiry/CVV that followed the readback — absorb it; a longer
      // tail is other content and stays verbatim.
      const tailWords = words.slice(len);
      const tail = tailWords.length > 0 && tailWords.length <= 8
        ? ' [code removed]'
        : (tailWords.length ? ` ${tailWords.join(' ')}` : '');
      return { text: maskFor(candidate) + tail, count: 1 };
    }
  }
  return { text: run, count: 0 };
}

// Read-aloud CVV with context ("cvv 123", "security code is one two three").
// Bare 3–4 digit runs stay untouched — context is what disambiguates.
const CVV_KEYWORD = '(?:cvv2?|cvc|csc|security\\s+code|card\\s+(?:security\\s+)?code|verification\\s+(?:code|number))';
const CVV_NUMERIC_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)((?:\\d[ -]?){2,3}\\d)(?!\\d)`, 'gi');
const CVV_SPOKEN_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)((?:(?:${DIGIT_WORD_ALT})[ ,]+){2,3}(?:${DIGIT_WORD_ALT}))\\b`, 'gi');

function scrubCvvContext(text) {
  let count = 0;
  let out = text.replace(CVV_NUMERIC_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  out = out.replace(CVV_SPOKEN_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  return { text: out, count };
}

/**
 * Scrub PANs + context-flagged CVVs from a string. Returns { text, count }.
 * Non-strings pass through untouched with count 0 (never throw in the
 * transcription path).
 */
function scrubPansDetailed(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, count: 0 };
  }
  let count = 0;
  let out = text.replace(NUMERIC_RUN_RE, (run) => {
    const r = scrubNumericRun(run);
    count += r.count;
    return r.text;
  });
  out = out.replace(WORD_RUN_RE, (run) => {
    const r = scrubSpokenRun(run);
    count += r.count;
    return r.text;
  });
  const cvv = scrubCvvContext(out);
  count += cvv.count;
  return { text: cvv.text, count };
}

/** Convenience: scrubbed string only. */
function scrubPans(text) {
  return scrubPansDetailed(text).text;
}

module.exports = { luhnValid, scrubPans, scrubPansDetailed };
