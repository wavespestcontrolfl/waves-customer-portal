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

// Maximal digit run: digits joined by short separators. Transcription
// providers punctuate pauses, so a card readback commonly lands as
// "4242, 4242, 4242, 4242" or period/newline-separated groups — commas,
// periods, and whitespace must join a run or each group is an unmatchable
// <13-digit island (Codex #2676 round-2 P1). Slashes join too: a trailing
// "12/28 123" expiry/CVV must ride the same run so the absorb step can
// swallow it — stopping at the slash left "/28 123" (raw CVV) beside the
// mask (round-7 P1). Slash-joined non-card runs (dates, phones) stay under
// the 13-digit floor or phone-lock, so nothing new becomes maskable.
// A diarization label sitting mid-readback ("4242 4242\nSpeaker 1: 4242
// 4242" — same caller, split by the provider) must not break the run into
// unmatchable islands (Codex #2676 round-5 P1). The label text is swallowed
// into the mask when a PAN bridges it — a small diarization loss, the right
// trade against a stored card number.
const LABEL_SEP = '(?:(?:speaker\\s*\\d+|agent|caller)\\s*:[\\s,.-]{1,3})';
// The negative lookbehind on "speaker" keeps a run from STARTING on the
// label's own digit ("Speaker 1: 4242…" must begin at 4242, not at the 1) —
// and scrubNumericRun drops any digit group that sits inside a label token,
// so "Speaker 1:" mid-readback can never poison the Luhn stream (Codex
// #2676 round-6 P1).
const NUMERIC_RUN_RE = new RegExp(
  `(?<![\\d-])(?<!speaker\\s{0,3})\\d(?:(?:[\\s,./-]{1,3}${LABEL_SEP}?|${LABEL_SEP})?\\d)*(?![\\d-])`,
  'gi'
);
const LABEL_TOKEN_RE = new RegExp('(?:speaker\\s*\\d+|agent|caller)\\s*:', 'gi');
const MAX_RUN_DIGITS = 40;

// Real-world PAN length priority: 16 (Visa/MC dominant), 15 (Amex), 19
// (extended Visa/JCB), 14 (Diners), 13 (legacy Visa), then the rare tail.
// Priority order — NOT longest-first — so a 16-digit PAN followed by a
// code-shaped tail whose concatenation happens to also pass Luhn masks as
// the real card and the tail is absorbed, instead of the tail's digits
// leaking into the last4 mask (Codex #2676 round-2 P1). IIN-aware
// (round-3 P2): an Amex (34/37) prefers its native 15 and Diners (30/36/
// 38/39) its native 14 BEFORE 16, so "<Amex> <code digit>" can't mask as a
// 16 that swallows one code digit into the displayed last4.
const PAN_LENGTH_PRIORITY = [16, 15, 19, 14, 13, 18, 17];
function panLengthPriority(prefix) {
  if (/^3[47]/.test(prefix)) return [15, 16, 14, 13, 19, 18, 17];
  if (/^3[0689]/.test(prefix)) return [14, 16, 15, 13, 19, 18, 17];
  return PAN_LENGTH_PRIORITY;
}

// NANP phone shape: consecutive groups of (3,3,4) digits (optionally led by
// a lone "1") are a dictated phone number — locked out of span candidates
// entirely so contact numbers feeding the dictation decoder can never be
// eaten by a Luhn coincidence (Codex #2676 round-2 P2). A card read in
// 3-3-4 chunks is indistinguishable from a phone and loses to the phone.
function lockPhoneGroups(groups) {
  const locked = new Array(groups.length).fill(false);
  for (let i = 0; i + 2 < groups.length; i += 1) {
    if (groups[i].digits.length === 3 && groups[i + 1].digits.length === 3 && groups[i + 2].digits.length === 4) {
      locked[i] = locked[i + 1] = locked[i + 2] = true;
      if (i > 0 && groups[i - 1].digits === '1') locked[i - 1] = true;
    }
  }
  return locked;
}

// Scrub one numeric run via group-span search. Returns the replacement
// string for the run and how many PANs were masked.
function scrubNumericRun(run) {
  // Digit groups that belong to a diarization label ("Speaker 1:") are NOT
  // part of the readback — collecting them would corrupt the digit stream
  // and fail Luhn on a genuinely bridged card (round-6 P1). The label text
  // itself still gets swallowed by the mask when a span crosses it.
  const labelRanges = [];
  let lm;
  LABEL_TOKEN_RE.lastIndex = 0;
  while ((lm = LABEL_TOKEN_RE.exec(run)) !== null) {
    labelRanges.push([lm.index, lm.index + lm[0].length]);
  }
  const insideLabel = (start, end) => labelRanges.some(([ls, le]) => start >= ls && end <= le);
  // Split into groups while tracking each group's char offsets in the run.
  const groups = [];
  const groupRe = /\d+/g;
  let g;
  while ((g = groupRe.exec(run)) !== null) {
    if (insideLabel(g.index, g.index + g[0].length)) continue;
    groups.push({ digits: g[0], start: g.index, end: g.index + g[0].length });
  }
  const totalDigits = groups.reduce((n, grp) => n + grp.digits.length, 0);
  if (totalDigits < 13 || totalDigits > MAX_RUN_DIGITS) return { text: run, count: 0 };
  const locked = lockPhoneGroups(groups);

  let count = 0;
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < groups.length) {
    if (locked[i]) { i += 1; continue; }
    // Candidate spans from group i (sum capped at 19, never crossing a
    // phone-locked group), selected by PAN-length priority.
    let matched = null;
    let sum = 0;
    const byLen = new Map();
    for (let j = i; j < groups.length; j += 1) {
      if (locked[j]) break;
      sum += groups[j].digits.length;
      if (sum > 19) break;
      if (sum >= 13 && !byLen.has(sum)) byLen.set(sum, j);
    }
    let spanPrefix = '';
    for (let j = i; j < groups.length && spanPrefix.length < 2; j += 1) {
      spanPrefix += groups[j].digits;
    }
    for (const len of panLengthPriority(spanPrefix)) {
      if (!byLen.has(len)) continue;
      const j = byLen.get(len);
      const spanDigits = groups.slice(i, j + 1).map((grp) => grp.digits).join('');
      if (panCandidateValid(spanDigits)) {
        matched = { endGroup: j, digits: spanDigits };
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
      // sitting next to the mask it belongs to. Never absorbs into a
      // phone-locked block — a dictated callback number after the card
      // survives intact.
      let absorbed = 0;
      while (i < groups.length && !locked[i] && groups[i].digits.length <= 4 && absorbed < 3) {
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
// Comma/period/ALL-whitespace pause punctuation joins the run (round-4),
// and so do a couple of FILLER tokens or a mid-readback diarization label
// (round-5): the transcription prompt preserves "um"/"uh" verbatim, so
// "four two um four two…" is exactly how a real readback lands.
const SPOKEN_FILLER = '(?:um+|uh+|erm|ah|hm+)';
const SPOKEN_SEP = `(?:[\\s,.]+(?:(?:${SPOKEN_FILLER}|(?:speaker\\s*\\d+|agent|caller)\\s*:)[\\s,.]+){0,2})`;
const WORD_RUN_RE = new RegExp(
  `\\b(?:(?:${DIGIT_WORD_ALT})${SPOKEN_SEP}){12,}(?:${DIGIT_WORD_ALT})\\b`,
  'gi'
);

// Prefix-anchored window search over a spoken-digit run: the card readback
// leads the run; expiry/CVV words trail it. Windows are tried in
// PAN-length-priority order (see the numeric twin) so a Luhn-colliding
// tail never leaks into the last4 mask.
// A digit string that decomposes ENTIRELY into NANP phone numbers
// ([2-9]xx [2-9]xx xxxx, optionally led by a lone "1") — dictated callback
// numbers read as words have no group boundaries, so this is the spoken
// twin of the numeric phone-lock (Codex #2676 round-3 P2).
const NANP10 = /^[2-9]\d\d[2-9]\d{6}$/;
function looksLikeSpokenPhoneRun(digits) {
  let rest = digits;
  let found = false;
  while (rest.length) {
    if (rest[0] === '1' && NANP10.test(rest.slice(1, 11))) { rest = rest.slice(11); found = true; continue; }
    if (NANP10.test(rest.slice(0, 10))) { rest = rest.slice(10); found = true; continue; }
    return false;
  }
  return found;
}

// Does the leftover after a candidate PAN window look like the expiry/CVV a
// card readback trails with? Empty, a 3-digit CVV, or MMYY(+CVV) with a
// real month. Used to break the phone-vs-card ambiguity: two dictated
// phones ending "…9876" fail the MMYY check, a real "…12 28" expiry passes.
function isValidCodeTail(tail) {
  if (tail.length === 0 || tail.length === 3) return true;
  if (tail.length === 4 || tail.length === 7 || tail.length === 8) {
    const mm = Number(tail.slice(0, 2));
    return mm >= 1 && mm <= 12;
  }
  return false;
}

// Networks whose prefix is UNAMBIGUOUSLY card-shaped (Visa 4, Amex 34/37,
// classic MC 51–55, Discover 6011/64x/65). The 2221–2720 MC range and the
// generic 3x/6x space are deliberately excluded here: NANP area codes live
// in 2xx–6xx, so a weak prefix on a phone-decomposable spoken run means
// "those are phone numbers", not "that's a card" (Codex #2676 round-4 P2 —
// two dictated callbacks whose concatenation Luhn-collides must survive).
function strongCardIin(digits) {
  return /^4/.test(digits) || /^3[47]/.test(digits) || /^5[1-5]/.test(digits) || /^(6011|65|64[4-9])/.test(digits);
}

// 2-series Mastercard (2221–2720): too weak for the generic guard above —
// NANP area codes live in 2xx, and 239/261/272… are REAL dictated-phone
// prefixes (239 is Waves' own Fort Myers market) — but the PRECISE 4-digit
// range check plus a STRICT FUTURE-DATED expiry tail is card evidence: a
// spoken 2-series MC + real expiry must not survive as "two phone numbers"
// (round-7 P1), while a phone pair whose tail merely LOOKS like MMYY keeps
// losing to the phone decomposition (round-4 P2) because a coincidental
// tail is as likely a past date as a future one and real card expiries are
// always in the future. Residual trade documented as with the 4xx case.
function mc2SeriesIin(digits) {
  const four = Number(digits.slice(0, 4));
  return Number.isFinite(four) && four >= 2221 && four <= 2720;
}

function isStrictFutureExpiryTail(tail) {
  if (tail.length !== 4 && tail.length !== 7 && tail.length !== 8) return false;
  const mm = Number(tail.slice(0, 2));
  if (!(mm >= 1 && mm <= 12)) return false;
  const yy = Number(tail.slice(2, 4));
  const nowYY = new Date().getFullYear() % 100;
  const ahead = (yy - nowYY + 100) % 100;
  return ahead <= 15; // cards expire ≤ ~10y out; 15 leaves slack, past years fail
}

function scrubSpokenRun(run) {
  // Words may include fillers/label tokens the separator let through —
  // track which word positions are DIGIT words so windows count digits,
  // not words (a filler inside the readback is swallowed by the mask).
  const words = run.split(/[\s,.]+/).filter(Boolean);
  const digitWordIdx = [];
  const digitChars = [];
  words.forEach((w, i) => {
    const d = DIGIT_WORDS[w.toLowerCase()];
    if (d !== undefined) {
      digitWordIdx.push(i);
      digitChars.push(d);
    }
  });
  const digits = digitChars.join('');
  if (digits.length < 13 || digits.length > MAX_RUN_DIGITS) return { text: run, count: 0 };
  const phoneRun = looksLikeSpokenPhoneRun(digits);
  for (const len of panLengthPriority(digits.slice(0, 2))) {
    if (len > digits.length) continue;
    const candidate = digits.slice(0, len);
    // Phone-shaped runs only mask when the prefix is a STRONG card IIN and
    // the leftover is genuinely code-shaped — dictated callbacks (weak
    // 2xx/3xx-style prefixes, or non-code tails like a second number's
    // last four) survive for the contact decoder, while a real Visa/Amex
    // readback + valid expiry that happens to also parse as phones still
    // masks. Privacy bias documented: a 4xx-area-code phone pair with a
    // Luhn-colliding prefix AND a valid-MMYY-shaped tail can still mask —
    // the residual trade accepted in favor of never persisting a PAN.
    if (phoneRun
      && !(strongCardIin(candidate) && isValidCodeTail(digits.slice(len)))
      && !(mc2SeriesIin(candidate) && isStrictFutureExpiryTail(digits.slice(len)))) continue;
    if (panCandidateValid(candidate)) {
      // Mask through the len-th DIGIT word (fillers inside the readback are
      // swallowed by the mask). A short DIGIT tail (≤8) is the expiry/CVV
      // that followed — absorb it; a longer tail is other content and stays
      // verbatim.
      const lastMaskedWordIdx = digitWordIdx[len - 1];
      const tailWords = words.slice(lastMaskedWordIdx + 1);
      const tailDigitCount = digits.length - len;
      if (tailDigitCount > 0 && tailDigitCount <= 8) {
        return { text: maskFor(candidate) + ' [code removed]', count: 1 };
      }
      if (tailWords.length) {
        // A longer tail can be a SECOND card in the same utterance (a caller
        // repeating or replacing a card) — recursively scrub it instead of
        // returning it verbatim (round-8 P1). Sub-13-digit tails come back
        // untouched from the recursion's floor check.
        const rest = scrubSpokenRun(tailWords.join(' '));
        return { text: `${maskFor(candidate)} ${rest.text}`, count: 1 + rest.count };
      }
      return { text: maskFor(candidate), count: 1 };
    }
  }
  return { text: run, count: 0 };
}

// Diarized-segment scrub with cross-boundary bridging (round-5 P1): the
// provider can split one same-caller readback across two segments, leaving
// each side under 13 digits. Per-segment scrub first; then every adjacent
// pair is re-checked as a joined string — a bridging hit masks in the first
// segment and empties the second (a small diarization loss, the right trade
// against a stored card number). Returns { segments, count }.
function scrubSegments(segments) {
  if (!Array.isArray(segments)) return { segments, count: 0 };
  let count = 0;
  const out = segments.map((seg) => {
    if (!seg || typeof seg.text !== 'string') return seg;
    const s = scrubPansDetailed(seg.text);
    count += s.count;
    return s.count ? { ...seg, text: s.text } : seg;
  });
  // Sliding multi-segment window (round-7/8 P1): a readback split one
  // 4-digit chunk per segment never reaches the 13-digit floor in any
  // PAIR — keep extending the joined window (bounded at 8 hops) until a
  // scrub hits, then mask in the first segment and empty the rest of the
  // window. Windows only START at a segment that carries digit content.
  const DIGITISH_RE = /\d|\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i;
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i];
    if (!a || typeof a.text !== 'string' || !DIGITISH_RE.test(a.text)) continue;
    let joined = a.text;
    for (let j = i + 1; j < out.length && j - i <= 8; j += 1) {
      const b = out[j];
      if (!b || typeof b.text !== 'string') break;
      joined = `${joined}\n${b.text}`;
      const r = scrubPansDetailed(joined);
      if (r.count > 0) {
        out[i] = { ...a, text: r.text };
        for (let k = i + 1; k <= j; k += 1) out[k] = { ...out[k], text: '' };
        count += r.count;
        i = j;
        break;
      }
    }
  }
  return { segments: out, count };
}

// Read-aloud CVV with context ("cvv 123", "security code is one two three").
// Bare 3–4 digit runs stay untouched — context is what disambiguates.
// Providers spell the acronym out ("C V V", "C.V.V.") — spaced/punctuated
// forms must match or the keyword check never runs (round-7 P1).
const CVV_ACRONYM = '(?:c[\\s.]{0,2}v[\\s.]{0,2}v2?|c[\\s.]{0,2}v[\\s.]{0,2}c|c[\\s.]{0,2}s[\\s.]{0,2}c)';
const CVV_KEYWORD = `(?:${CVV_ACRONYM}|card\\s+(?:security\\s+)?code|verification\\s+(?:code|number))`;
// Bare "security code" is context-gated (round-7/8 P2): in a pest-service
// call it usually means a GATE/lockbox/access code — an artifact the call
// extraction explicitly persists for booked visits — and masking it (plus
// the quarantine the count triggers) would destroy entry instructions over
// zero card data. It only scrubs when card wording appears nearby AND no
// access wording does; "card security code" stays in the always-on set.
const BARE_SECURITY_CODE = 'security\\s+code';
const CARD_CONTEXT_RE = /\b(?:card|visa|master\s*card|amex|american\s+express|discover|debit|credit|c[\s.]{0,2}v[\s.]{0,2}[vc]|expir)/i;
const ACCESS_CONTEXT_RE = /\b(?:gate|door|garage|lock\s*box|community|entry|access|alarm|building|call\s*box|keypad|pool|fence|hoa)\b/i;
// Digit separators mirror the PAN path — providers punctuate pauses, so
// "cvv is 1, 2, 3" must match as readily as "cvv 123" (round-3 P1).
const CVV_TAIL_NUMERIC = '((?:\\d[\\s,.-]{0,2}){2,3}\\d)(?![\\d])';
const CVV_NUMERIC_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)${CVV_TAIL_NUMERIC}`, 'gi');
const CVV_SPOKEN_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)((?:(?:${DIGIT_WORD_ALT})[ ,.]+){2,3}(?:${DIGIT_WORD_ALT}))\\b`, 'gi');
const SEC_NUMERIC_RE = new RegExp(`(${BARE_SECURITY_CODE}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)${CVV_TAIL_NUMERIC}`, 'gi');
const SEC_SPOKEN_RE = new RegExp(`(${BARE_SECURITY_CODE}\\b[\\s:,.-]*(?:is\\s+|was\\s+|number\\s+)?)((?:(?:${DIGIT_WORD_ALT})[ ,.]+){2,3}(?:${DIGIT_WORD_ALT}))\\b`, 'gi');

function bareSecurityCodeIsCardCvv(full, offset) {
  const windowText = full.slice(Math.max(0, offset - 80), offset + 20);
  if (ACCESS_CONTEXT_RE.test(windowText)) return false;
  return CARD_CONTEXT_RE.test(windowText);
}

function scrubCvvContext(text) {
  let count = 0;
  let out = text.replace(CVV_NUMERIC_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  out = out.replace(CVV_SPOKEN_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  out = out.replace(SEC_NUMERIC_RE, (m, kw, code, offset, full) => {
    if (!bareSecurityCodeIsCardCvv(full, offset)) return m;
    count += 1;
    return `${kw}[code removed]`;
  });
  out = out.replace(SEC_SPOKEN_RE, (m, kw, code, offset, full) => {
    if (!bareSecurityCodeIsCardCvv(full, offset)) return m;
    count += 1;
    return `${kw}[code removed]`;
  });
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

module.exports = { luhnValid, scrubPans, scrubPansDetailed, scrubSegments };
