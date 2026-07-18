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
// <13-digit island (Codex #2676 round-2 P1). Pure WHITESPACE joins at any
// width up to 40 chars (round-11: diarized text can indent or hold wide
// pauses — "4242    4242" must not split into sub-13 islands); punctuation
// mixes stay tight at 1-3. Slashes join too: a trailing
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
// Boundaries exclude DIGITS only (round-16 P1): a punctuation dash glued
// to the run ("card-4242-4242-4242-4242") must not stop the run from
// starting/ending — internal dashes are already separators, and maximal
// matching means a suffix can't be matched apart from its head.
// The negative lookbehind on "speaker" keeps a run from STARTING on the
// label's own digit ("Speaker 1: 4242…" must begin at 4242, not at the 1) —
// and scrubNumericRun drops any digit group that sits inside a label token,
// so "Speaker 1:" mid-readback can never poison the Luhn stream (Codex
// #2676 round-6 P1).
const NUMERIC_RUN_RE = new RegExp(
  `(?<!\\d)(?<!speaker\\s{0,3})\\d(?:(?:(?:\\s{1,40}|[\\s,./-]{1,3})${LABEL_SEP}?|${LABEL_SEP})?\\d)*(?!\\d)`,
  'gi'
);
const LABEL_TOKEN_RE = new RegExp('(?:speaker\\s*\\d+|agent|caller)\\s*:', 'gi');
// Two full readbacks (card + expiry + CVV, twice) run ~46 digits — the old
// 40-digit bail left BOTH cards raw (round-13 P1). The group-span walk is
// phone-locked and Luhn/IIN-gated, so long runs are safe to scan; only true
// bulk dumps (CSV pastes, ID lists) bail.
const MAX_RUN_DIGITS = 120;

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
    // Unseparated PAN+CVV token (round-10 P1), two shapes:
    //  (a) the combined 19 digits ALSO pass Luhn — masking as a 19 would
    //      leak CVV digits into the displayed last4;
    //  (b) the combined 17–19 digits FAIL Luhn — no span matches and the
    //      raw PAN would survive verbatim.
    // Either way, when the 16-digit (or Amex 15-digit) prefix is a valid
    // PAN in its own right and the remainder is code-sized (1–4), mask the
    // prefix and absorb the tail. A genuine 19-digit PAN whose 16-prefix
    // Luhn-collides splits too — documented bias toward never displaying
    // CVV digits. Separator-grouped readbacks never reach this: the span
    // search matches their 16 first and the group absorb takes the tail.
    const trySplitUnseparated = (digits) => {
      // All supported PAN lengths, IIN-aware order (round-12 P1): an
      // Amex + CVV must prefer its native 15 so the displayed last4 never
      // includes a CVV digit, and 13/14-digit PANs with 3-4 digit codes
      // (17+ totals) split too. The floor stays at 17 TOTAL digits by
      // design: allowing 14-16 totals would split the 13-digit prefix out
      // of ordinary Luhn-invalid 16-digit tokens (order/tracking/reference
      // numbers — a pinned round-1 contract), and 13-digit Visas are
      // legacy-extinct while 16-digit non-card tokens are everywhere.
      // Totals up to 27 cover a fused MMYY + CVV4 tail
      // ("42424242424242421228123" — round-13 P1); tails of 5-8 must be
      // genuinely code-shaped, and totals ABOVE 19 additionally require a
      // STRONG card IIN — an unseparated pair of 10-digit phone numbers
      // must keep losing (same documented residual as the spoken guard:
      // a 4xx-area-code pair with a Luhn-colliding 16-prefix and an
      // MMYY-shaped tail can still mask, accepted over persisting a PAN).
      if (digits.length < 17 || digits.length > 27) return null;
      for (const plen of panLengthPriority(digits.slice(0, 2))) {
        const tailLen = digits.length - plen;
        if (tailLen < 1 || tailLen > 8) continue;
        const tail = digits.slice(plen);
        // ≤19 totals keep the loose 1–4 tail (round-12 contract); ABOVE 19
        // every tail must be genuinely code-shaped (valid MMYY / CVV) —
        // "tracking 42424242424242424242" has a Luhn-colliding 16-prefix
        // but its '4242' tail is no expiry (mm=42), so it survives
        // (round-1 pinned contract).
        if ((tailLen > 4 || digits.length > 19) && !isValidCodeTail(tail)) continue;
        const prefix = digits.slice(0, plen);
        // >19 totals need a card-shaped prefix: a strong IIN or a PRECISE
        // 2-series Mastercard (2221–2720). No live-expiry requirement here
        // (round-16 P1): an EXPIRED card number is still a PAN and must
        // not persist. The strict-future gate stays on the SPOKEN phone
        // path only — that ambiguity is grouped/dictated phone pairs,
        // which never arrive as one fused 20+ digit token; the code-shaped
        // tail requirement above already screens fused non-card tokens.
        if (digits.length > 19
          && !strongCardIin(prefix)
          && !mc2SeriesIin(prefix)
          && !jcbIin(prefix)
          && !discover622Iin(prefix)) continue;
        if (panCandidateValid(prefix)) return prefix;
      }
      return null;
    };
    if (matched && matched.digits.length >= 17) {
      // A Luhn-valid 17/18/19 "PAN" is far more likely a shorter real PAN
      // with its code fused on — same split, any over-16 match.
      const prefix = trySplitUnseparated(matched.digits);
      if (prefix) matched = { ...matched, prefixMask: prefix };
    }
    if (!matched && !locked[i]) {
      // Span-level split (round-11 P1): the provider can merge only the
      // LAST group with the CVV ("4242 4242 4242 4242123") — the 19-digit
      // span fails Luhn, no byLen candidate matches, and a single-group
      // fallback never sees it. Walk the span from i to a 17–19 digit
      // total (never crossing a phone-locked group) and try the same
      // 16/15-prefix + code-tail split.
      let spanSum = 0;
      for (let j = i; j < groups.length && !locked[j]; j += 1) {
        spanSum += groups[j].digits.length;
        if (spanSum > 27) break;
        if (spanSum >= 17) {
          const spanDigits = groups.slice(i, j + 1).map((grp) => grp.digits).join('');
          const prefix = trySplitUnseparated(spanDigits);
          // WIDEST valid split wins (round-15 P1): "…424212/28123" splits
          // at the 18-digit token too, but stopping there leaves "/28123"
          // (year + CVV) beside the mask — keep walking and take the last
          // span whose split still validates so the whole code tail is
          // absorbed.
          if (prefix) matched = { endGroup: j, digits: spanDigits, prefixMask: prefix };
        }
      }
    }
    if (matched) {
      const maskDigits = matched.prefixMask || matched.digits;
      out += run.slice(cursor, groups[i].start) + maskFor(maskDigits) + (matched.prefixMask ? ' [code removed]' : '');
      cursor = groups[matched.endGroup].end;
      i = matched.endGroup + 1;
      count += 1;
      // Absorb trailing expiry/CVV-shaped groups (≤4 digits each) from the
      // same run, budgeted by TOTAL DIGITS (≤8 — MMYY + a 4-digit CVV) not
      // by group count: a CVV read digit-by-digit ("12 28 1 2 3") is five
      // groups and a hard group cap left its tail beside the mask
      // (round-11 P1). Never absorbs into a phone-locked block — a
      // dictated callback number after the card survives intact.
      // A SECOND card read back-to-back must not lose its head to the
      // absorb ("…1111 4242 4242 4242 4242" — the first two 4242s are a
      // new PAN's opening groups, not an expiry): before each absorb step,
      // check whether a valid PAN span STARTS here and stop if so — the
      // outer loop masks it as its own card (round-12 P1).
      const startsValidPanSpan = (from) => {
        let sum = 0;
        let head = '';
        for (let j = from; j < groups.length && !locked[j]; j += 1) {
          sum += groups[j].digits.length;
          if (head.length < 2) head = (head + groups[j].digits).slice(0, 2);
          if (sum > 27) break;
          if (sum >= 13) {
            const spanDigits2 = groups.slice(from, j + 1).map((grp) => grp.digits).join('');
            for (const len of panLengthPriority(head)) {
              if (len === spanDigits2.length && panCandidateValid(spanDigits2)) return true;
            }
            // A second card whose LAST group fused with its CVV
            // ("…1111 4242 4242 4242 4242123") is split-shaped, not
            // full-Luhn-shaped — recognize it too or the absorb eats its
            // opening groups (round-13 P1).
            if (sum >= 17 && trySplitUnseparated(spanDigits2)) return true;
          }
        }
        return false;
      };
      let absorbedDigits = 0;
      let absorbedGroups = 0;
      // MM + four-digit-year expiries ("12 2028 123") need 10 digits of
      // budget; the stretch only applies when the tail actually opens with
      // that shape (round-17 P1).
      let absorbBudget = 8;
      if (i < groups.length && groups[i].digits.length === 2) {
        const mmPeek = Number(groups[i].digits);
        if (mmPeek >= 1 && mmPeek <= 12 && i + 1 < groups.length && /^20\d\d$/.test(groups[i + 1].digits)) {
          absorbBudget = 10;
        }
      }
      while (i < groups.length && !locked[i] && groups[i].digits.length <= 4
        && absorbedDigits + groups[i].digits.length <= absorbBudget
        && !startsValidPanSpan(i)) {
        absorbedDigits += groups[i].digits.length;
        cursor = groups[i].end;
        i += 1;
        absorbedGroups += 1;
      }
      if (absorbedGroups > 0) out += ' [code removed]';
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
// 'slash'/'dash' are SPOKEN separators ("one two slash two eight"), not
// content — they must not end a run or the expiry/CVV after them survives
// beside the mask (Codex #2676 round-10 P1).
const SPOKEN_FILLER = '(?:um+|uh+|erm|ah|hm+|slash|dash)';
const SPOKEN_SEP = `(?:[\\s,./-]+(?:(?:${SPOKEN_FILLER}|(?:speaker\\s*\\d+|agent|caller)\\s*:)[\\s,./-]+){0,2})`;
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
  // Four-digit expiry years are common in readbacks (round-17 P1):
  // MMYYYY (6), MMYYYY+CVV (9), MMYYYY+CVV4 (10).
  if (tail.length === 6 || tail.length === 9 || tail.length === 10) {
    const mm = Number(tail.slice(0, 2));
    return mm >= 1 && mm <= 12 && tail.slice(2, 4) === '20';
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

// Precise JCB (3528–3589) and Discover-622 (622126–622925) ranges — same
// role as the 2-series check: too weak for the generic guard (3xx/6xx NANP
// area codes), but exact-range evidence for the strict-expiry tie breakers
// (Codex #2676 round-17 P1).
function jcbIin(digits) {
  const four = Number(digits.slice(0, 4));
  return Number.isFinite(four) && four >= 3528 && four <= 3589;
}
function discover622Iin(digits) {
  const six = Number(digits.slice(0, 6));
  return Number.isFinite(six) && six >= 622126 && six <= 622925;
}

function isStrictFutureExpiryTail(tail) {
  if (tail.length !== 4 && tail.length !== 7 && tail.length !== 8) return false;
  const mm = Number(tail.slice(0, 2));
  if (!(mm >= 1 && mm <= 12)) return false;
  const yy = Number(tail.slice(2, 4));
  const now = new Date();
  const nowYY = now.getFullYear() % 100;
  const ahead = (yy - nowYY + 100) % 100;
  if (ahead === 0) {
    // Current year: an already-expired month is NOT a live card expiry —
    // a dictated phone tail like "01 26" after January 2026 keeps losing
    // to the phone decomposition (round-9 P2). Cards stay valid through
    // the end of their expiry month.
    return mm >= now.getMonth() + 1;
  }
  return ahead <= 15; // cards expire ≤ ~10y out; 15 leaves slack, past years fail
}

function scrubSpokenRun(run) {
  // Words may include fillers/label tokens the separator let through —
  // track which word positions are DIGIT words so windows count digits,
  // not words (a filler inside the readback is swallowed by the mask).
  const words = run.split(/[\s,./-]+/).filter(Boolean);
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
      && !((mc2SeriesIin(candidate) || jcbIin(candidate) || discover622Iin(candidate))
        && isStrictFutureExpiryTail(digits.slice(len)))) continue;
    if (panCandidateValid(candidate)) {
      // Mask through the len-th DIGIT word (fillers inside the readback are
      // swallowed by the mask). A short DIGIT tail (≤8) is the expiry/CVV
      // that followed — absorb it; a longer tail is other content and stays
      // verbatim.
      const lastMaskedWordIdx = digitWordIdx[len - 1];
      const tailWords = words.slice(lastMaskedWordIdx + 1);
      const tailDigitCount = digits.length - len;
      const tailDigits = digits.slice(len);
      if (tailDigitCount > 0
        && (tailDigitCount <= 8
          || (tailDigitCount <= 10 && /^(0[1-9]|1[0-2])20\d\d/.test(tailDigits)))) {
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
  const out = segments.map((seg) => (seg && typeof seg.text === 'string' ? { ...seg } : seg));
  const DIGITISH_RE = /\d|\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i;
  // A follow segment that is NOTHING but 1–4 short digit groups (numeric or
  // spoken) — the shape of an expiry/CVV read into the next diarized chunk.
  const CODE_TAIL_SEG_RE = /^[\s,./:-]*(?:(?:\d{1,4}|zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,./:-]*){1,4}$/i;
  // Window pass over ORIGINAL segment text (round-9 P1: per-segment
  // pre-scrubbing hid a PAN completed in one segment from its CVV/expiry in
  // the next — the joined re-scrub saw only the mask and left the code
  // raw). Windows start at any digit-bearing segment and grow (bounded)
  // until a scrub hits; after a hit, short code-shaped follow segments are
  // pulled in while doing so actually changes the rendered tail (i.e. the
  // absorb rule swallowed them) — an unrelated digit segment renders
  // verbatim and stops the growth. The hit masks in the window's first
  // segment and empties the rest.
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i];
    if (!a || typeof a.text !== 'string' || !DIGITISH_RE.test(a.text)) continue;
    let joined = a.text;
    let hit = null;
    for (let j = i; j < out.length && j - i <= 8; j += 1) {
      if (j > i) {
        const b = out[j];
        if (!b || typeof b.text !== 'string') break;
        joined = `${joined}\n${b.text}`;
      }
      const r = scrubPansDetailed(joined);
      if (r.count > 0) {
        hit = { j, r };
        for (let k = j + 1; k < out.length && k - i <= 10; k += 1) {
          const c = out[k];
          if (!c || typeof c.text !== 'string' || !CODE_TAIL_SEG_RE.test(c.text)) break;
          joined = `${joined}\n${c.text}`;
          const wider = scrubPansDetailed(joined);
          const verbatim = `${hit.r.text}\n${c.text}`;
          if (wider.count >= hit.r.count && wider.text !== verbatim) {
            hit = { j: k, r: wider };
          } else {
            break;
          }
        }
        break;
      }
    }
    if (hit) {
      out[i] = { ...out[i], text: hit.r.text };
      for (let k = i + 1; k <= hit.j; k += 1) out[k] = { ...out[k], text: '' };
      count += hit.r.count;
      i = hit.j;
    }
  }
  return { segments: out, count };
}

// Read-aloud CVV with context ("cvv 123", "security code is one two three").
// Bare 3–4 digit runs stay untouched — context is what disambiguates.
// Providers spell the acronym out ("C V V", "C.V.V.") — spaced/punctuated
// forms must match or the keyword check never runs (round-7 P1).
const CVV_ACRONYM = '(?:c[\\s,.]{0,3}v[\\s,.]{0,3}v2?|c[\\s,.]{0,3}v[\\s,.]{0,3}c|c[\\s,.]{0,3}s[\\s,.]{0,3}c)';
const CVV_KEYWORD = `(?:${CVV_ACRONYM}|card\\s+(?:security\\s+)?code|verification\\s+(?:code|number))`;
// Bare "security code" is context-gated (round-7/8 P2): in a pest-service
// call it usually means a GATE/lockbox/access code — an artifact the call
// extraction explicitly persists for booked visits — and masking it (plus
// the quarantine the count triggers) would destroy entry instructions over
// zero card data. It only scrubs when card wording appears nearby AND no
// access wording does; "card security code" stays in the always-on set.
const BARE_SECURITY_CODE = 'security\\s+code';
const CARD_CONTEXT_RE = /\b(?:card|visa|master\s*card|amex|american\s+express|discover|debit|credit|c[\s,.]{0,3}v[\s,.]{0,3}[vc]|expir)/i;
const ACCESS_CONTEXT_RE = /\b(?:gate|door|garage|lock\s*box|community|entry|access|alarm|building|call\s*box|keypad|pool|fence|hoa)\b/i;
// Digit separators mirror the PAN path — providers punctuate pauses, so
// "cvv is 1, 2, 3" must match as readily as "cvv 123" (round-3 P1).
const CVV_TAIL_NUMERIC = '((?:\\d[\\s,.-]{0,2}){2,3}\\d)(?![\\d])';
const CVV_NUMERIC_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:(?:number|code)\\s+)?(?:is\\s+|was\\s+)?)${CVV_TAIL_NUMERIC}`, 'gi');
const CVV_SPOKEN_RE = new RegExp(`(${CVV_KEYWORD}\\b[\\s:,.-]*(?:(?:number|code)\\s+)?(?:is\\s+|was\\s+)?)((?:(?:${DIGIT_WORD_ALT})[ ,.]+){2,3}(?:${DIGIT_WORD_ALT}))\\b`, 'gi');
const SEC_NUMERIC_RE = new RegExp(`(${BARE_SECURITY_CODE}\\b[\\s:,.-]*(?:(?:number|code)\\s+)?(?:is\\s+|was\\s+)?)${CVV_TAIL_NUMERIC}`, 'gi');
const SEC_SPOKEN_RE = new RegExp(`(${BARE_SECURITY_CODE}\\b[\\s:,.-]*(?:(?:number|code)\\s+)?(?:is\\s+|was\\s+)?)((?:(?:${DIGIT_WORD_ALT})[ ,.]+){2,3}(?:${DIGIT_WORD_ALT}))\\b`, 'gi');

function bareSecurityCodeIsCardCvv(full, offset, matchLength = 0) {
  // The forward window reaches PAST the matched code so trailing card
  // wording counts ("security code is 123 for the card" — round-12 P1).
  const windowText = full.slice(Math.max(0, offset - 80), offset + matchLength + 40);
  if (ACCESS_CONTEXT_RE.test(windowText)) return false;
  return CARD_CONTEXT_RE.test(windowText);
}

function scrubCvvContext(text) {
  let count = 0;
  let out = text.replace(CVV_NUMERIC_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  out = out.replace(CVV_SPOKEN_RE, (m, kw) => { count += 1; return `${kw}[code removed]`; });
  out = out.replace(SEC_NUMERIC_RE, (m, kw, code, offset, full) => {
    if (!bareSecurityCodeIsCardCvv(full, offset, m.length)) return m;
    count += 1;
    return `${kw}[code removed]`;
  });
  out = out.replace(SEC_SPOKEN_RE, (m, kw, code, offset, full) => {
    if (!bareSecurityCodeIsCardCvv(full, offset, m.length)) return m;
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
