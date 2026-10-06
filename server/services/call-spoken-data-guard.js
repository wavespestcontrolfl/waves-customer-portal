/**
 * Call spoken-data guard — deterministic backstops for three classes of caller
 * data the extraction model gets wrong even with a correct prompt (7-day audit
 * of production calls, 2026-10-05). Pure functions, no DB, no network.
 *
 * 1. SPELLED NAMES WIN. A caller who spells a surname letter by letter ("M-C-L-
 *    O-U-G-H-L-I-N") spells it because the transcriber mishears the spoken
 *    form. The prompt already says the spelled letters beat the heard word and
 *    the record on file, and the model still kept "McLaughlin", "Sirov" and the
 *    on-file "Earlbeck". This module reads the spelled letters straight from
 *    the transcript (the email dictation parser's approach, applied to names)
 *    and overrides the extracted name when a spelled run is a near-spelling of
 *    it. It never invents a name: a run that matches no extracted name closely
 *    is ignored. It also splits the "Dingman over at ..." transcription merge
 *    ("Dingmanover at 1083 ...") back into the surname.
 *
 * 2. IMPOSSIBLE PHONES ARE NEVER SAVED. NANP area and exchange codes cannot
 *    start with 0 or 1. A spoken number that does is a mishearing; saved as a
 *    contact number it sends texts to a stranger. Secondary-contact and caller
 *    numbers like that are nulled here, and the call keeps its existing
 *    advisory card (secondary_contact_captured: "confirm their name and
 *    number") or, when no number of any kind remains, caller_phone_missing, so
 *    a person asks again.
 *
 * 3. "YOU CAN'T TEXT THIS ONE." A caller on a video-relay service, a landline
 *    or a voice-only line says the number reaching us cannot take texts. The
 *    model's caller_id_disclaimed field was defined as "this number is not
 *    mine", so "this is my number but you can't text it" never set it. This
 *    module sets it from the caller's own words; the existing
 *    callback_number_needed machinery (call-triage-flags.js
 *    callerIdDisclaimedNeedsCallback) then holds texts to the ANI, and a spoken
 *    text number that differs from the ANI is what resolveCallContactPhone
 *    saves and texts.
 */

const { properCase } = require('../utils/name-case');
const { isImpossibleNanpPhone } = require('../utils/phone');

const normLetters = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// How different a heard name and a spelled name may be and still be the SAME
// name mis-transcribed (Serov/Sirov = 1, McLoughlin/McLaughlin = 1,
// Irlbeck/Earlbeck = 2). Half the shorter length, capped at 3, so short names
// stay strict and a spelled street name never rewrites an unrelated surname.
function closeSpelling(spelledLetters, heardLetters) {
  if (!spelledLetters || !heardLetters || spelledLetters === heardLetters) return false;
  const cap = Math.min(3, Math.floor(Math.min(spelledLetters.length, heardLetters.length) / 2));
  if (cap < 1) return false;
  return editDistance(spelledLetters, heardLetters) <= cap;
}

// ── transcript parsing ─────────────────────────────────────────────────────

const STAFF_SPEAKER = /^(agent|staff|waves|csr|operator|assistant|receptionist)\b/i;

// "Agent: ..." / "Caller: ..." turns. A transcript with no labels is one turn.
function splitTurns(transcript) {
  const text = String(transcript || '');
  const turns = [];
  const label = /^\s*([A-Za-z][A-Za-z0-9 _.-]{0,24}):\s*(.*)$/;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = label.exec(line);
    if (m) {
      cur = { speaker: m[1].trim(), text: m[2] };
      turns.push(cur);
    } else if (cur && line.trim()) {
      cur.text += ` ${line.trim()}`;
    }
  }
  if (!turns.length && text.trim()) turns.push({ speaker: 'unknown', text });
  return turns;
}

const MARKER_WORDS = new Set(['as', 'like', 'for', 'is']);
const MARKER_FILLER = new Set(['in', 'a', 'an', 'the']);
const SEPARATOR_ONLY = /^[\s,.\-–—]*$/;
const EMAIL_AFTER = /^[^.?!]{0,60}?\b(?:at|@)\b[^.?!]{0,40}?\b(?:dot|gmail|yahoo|outlook|hotmail|icloud|aol|com)\b/i;
const EMAIL_BEFORE = /e-?mail|\bat sign\b|\bdot com\b/i;
const ADDRESS_BEFORE = /\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|circle|boulevard|blvd|way|trail|city|town|county|address)\b[^.?!]{0,12}$/i;

// Letter runs the caller spelled in ONE turn: hyphen/space/comma separated
// single letters ("I-R-L-B-E-C-K", "S E R O V"), phonetic markers ("B as in
// boy") and "double L". Needs 3+ letters, and either hyphens, ALL-CAPS letters
// or two phonetic markers, so ordinary prose with a stray "I" or "a" never
// reads as a spelled word.
function spelledRunsInTurn(turnText) {
  const tokens = [];
  const re = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;
  let m;
  while ((m = re.exec(turnText))) tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });

  // One spelled item at token idx: a letter, "double L", or a letter with its
  // phonetic marker ("B as in boy"). `next` is the first token after the item.
  const readItem = (idx) => {
    const tok = tokens[idx];
    if (!tok) return null;
    let letter = null;
    let last = idx;
    let doubled = false;
    if (tok.word.toLowerCase() === 'double' && tokens[idx + 1] && tokens[idx + 1].word.length === 1
        && /^\s+$/.test(turnText.slice(tok.end, tokens[idx + 1].start))) {
      letter = tokens[idx + 1].word;
      last = idx + 1;
      doubled = true;
    } else if (tok.word.length === 1) {
      letter = tok.word;
    }
    if (!letter) return null;
    let marker = false;
    const k = last + 1;
    if (!doubled && tokens[k] && MARKER_WORDS.has(tokens[k].word.toLowerCase())) {
      let w = k + 1;
      if (tokens[w] && MARKER_FILLER.has(tokens[w].word.toLowerCase())) w += 1;
      if (tokens[w] && tokens[w].word.length > 1 && tokens[w].word[0].toLowerCase() === letter.toLowerCase()) {
        marker = true;
        last = w;
      }
    }
    return {
      letters: doubled ? letter.toLowerCase().repeat(2) : letter.toLowerCase(),
      upper: letter === letter.toUpperCase(),
      marker,
      first: idx,
      last,
      next: last + 1,
    };
  };

  const runs = [];
  let i = 0;
  while (i < tokens.length) {
    const head = readItem(i);
    if (!head) { i += 1; continue; }
    const items = [head];
    let idx = head.next;
    while (idx < tokens.length) {
      const gap = turnText.slice(tokens[idx - 1].end, tokens[idx].start);
      if (!SEPARATOR_ONLY.test(gap)) break;
      const item = readItem(idx);
      if (!item) break;
      item.gap = gap;
      items.push(item);
      idx = item.next;
    }
    const letters = items.map((it) => it.letters).join('');
    const hyphen = items.some((it) => it.gap && /[-\u2013\u2014]/.test(it.gap));
    const allCaps = items.every((it) => it.upper);
    const markers = items.filter((it) => it.marker).length;
    if (letters.length >= 3 && (hyphen || allCaps || markers >= 2)) {
      runs.push({
        letters,
        start: tokens[items[0].first].start,
        end: tokens[items[items.length - 1].last].end,
      });
    }
    i = Math.max(idx, i + 1);
  }
  return runs;
}

function runIsEmailOrAddressContext(turnText, run) {
  const before = turnText.slice(Math.max(0, run.start - 50), run.start);
  const after = turnText.slice(run.end, run.end + 120);
  if (EMAIL_BEFORE.test(before)) return true;
  if (EMAIL_AFTER.test(after)) return true;
  if (ADDRESS_BEFORE.test(before)) return true;
  return false;
}

// Every name-shaped spelled run the CALLER produced, in call order. Staff turns
// are skipped (an agent's read-back is one more chance to mishear); an
// unlabeled transcript is read as the caller's.
function findSpelledNameRuns(transcripts) {
  const list = (Array.isArray(transcripts) ? transcripts : [transcripts]).filter(Boolean);
  const runs = [];
  for (const transcript of list) {
    for (const turn of splitTurns(transcript)) {
      if (STAFF_SPEAKER.test(turn.speaker)) continue;
      for (const run of spelledRunsInTurn(turn.text)) {
        if (runIsEmailOrAddressContext(turn.text, run)) continue;
        runs.push({ letters: run.letters });
      }
    }
  }
  return runs;
}

// ── 1. spelled names ───────────────────────────────────────────────────────

function replaceToken(text, from, to) {
  if (typeof text !== 'string' || !from) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'i'), to);
}

// Resolve ONE person's first/last name against the spelled runs. `person` is a
// mutable object carrying first_name / last_name (and optionally name_full).
// Returns { first_name, last_name } booleans: true when the spelled letters
// (already equal, or just applied) decided that field.
function resolvePersonNames(person, runs, changes, role) {
  const decided = { first_name: false, last_name: false };
  if (!person || typeof person !== 'object' || !runs.length) return decided;
  const fields = ['first_name', 'last_name'].filter((f) => normLetters(person[f]).length >= 3);
  const used = new Set();

  // Pass 1: a run that already equals the heard name confirms it as spelled.
  for (const field of fields) {
    const heard = normLetters(person[field]);
    const idx = runs.findIndex((r, n) => !used.has(n) && r.letters === heard);
    if (idx >= 0) { used.add(idx); decided[field] = true; }
  }
  // Pass 2: the nearest unused run that is a near-spelling replaces the name.
  // Ties go to the LATER run (a caller correcting a spelling spells it again).
  for (const field of fields) {
    if (decided[field]) continue;
    const heard = normLetters(person[field]);
    let best = -1;
    let bestDistance = Infinity;
    runs.forEach((r, n) => {
      if (used.has(n) || !closeSpelling(r.letters, heard)) return;
      const d = editDistance(r.letters, heard);
      if (d <= bestDistance) { best = n; bestDistance = d; }
    });
    if (best < 0) continue;
    used.add(best);
    const from = String(person[field]);
    const to = properCase(runs[best].letters);
    person[field] = to;
    if (typeof person.name_full === 'string') person.name_full = replaceToken(person.name_full, from, to);
    decided[field] = true;
    changes.push({ kind: 'spelled_name', role, field });
  }
  return decided;
}

// A surname the transcriber glued to the next words: "Sally Dingmanover at
// 1083 Blue Shell" is "Dingman over at". Splits only a single-token surname of
// 4+ letters plus "over" that the caller says directly before a preposition
// introducing the address ("...over at", "...over in"). Real surnames of this
// shape (Hanover, Stover, Glover, Grover, Hoover, Vanover) have a stem under 4
// letters, so they never qualify.
const OVER_PREPOSITION = '(?:at|in|on|from|with|near)';
function splitMergedSurname(person, transcripts, changes, role) {
  if (!person || typeof person.last_name !== 'string') return false;
  const m = /^([A-Za-z]{4,})over$/i.exec(person.last_name.trim());
  if (!m) return false;
  const token = person.last_name.trim();
  const seen = new RegExp(`\\b${token}\\s+${OVER_PREPOSITION}\\b`, 'i');
  const heardMerged = (Array.isArray(transcripts) ? transcripts : [transcripts]).filter(Boolean)
    .some((t) => splitTurns(t).some((turn) => !STAFF_SPEAKER.test(turn.speaker) && seen.test(turn.text)));
  if (!heardMerged) return false;
  const to = properCase(m[1]);
  if (typeof person.name_full === 'string') person.name_full = replaceToken(person.name_full, token, to);
  person.last_name = to;
  changes.push({ kind: 'merged_surname_split', role, field: 'last_name' });
  return true;
}

function secondaryPeople(extracted, v2Extraction) {
  const out = [];
  const push = (p, role) => { if (p && typeof p === 'object') out.push({ person: p, role }); };
  push(extracted && extracted.secondary_contact, 'secondary');
  if (v2Extraction) {
    push(v2Extraction.secondary_contact, 'secondary');
    (Array.isArray(v2Extraction.secondary_contacts) ? v2Extraction.secondary_contacts : [])
      .forEach((p) => push(p, 'secondary'));
  }
  return out;
}

function applySpelledNames({ extracted, v2Extraction, transcripts, changes }) {
  const runs = findSpelledNameRuns(transcripts);
  const spelled = { first_name: false, last_name: false };
  const callerObjects = [extracted, v2Extraction && v2Extraction.caller].filter(Boolean);

  // The V1 view and the V2 caller are the same person: resolve on the V1 view
  // first, then mirror what it decided onto V2 so the two never disagree.
  if (extracted) {
    const decided = resolvePersonNames(extracted, runs, changes, 'caller');
    spelled.first_name = decided.first_name;
    spelled.last_name = decided.last_name;
  }
  const v2Caller = v2Extraction && v2Extraction.caller;
  if (v2Caller) {
    if (extracted) {
      for (const field of ['first_name', 'last_name']) {
        if (spelled[field] && extracted[field] && normLetters(v2Caller[field]) !== normLetters(extracted[field])
            && (closeSpelling(normLetters(extracted[field]), normLetters(v2Caller[field]))
              || normLetters(extracted[field]) === normLetters(v2Caller[field]))) {
          if (typeof v2Caller.name_full === 'string' && v2Caller[field]) {
            v2Caller.name_full = replaceToken(v2Caller.name_full, String(v2Caller[field]), extracted[field]);
          }
          v2Caller[field] = extracted[field];
        }
      }
    } else {
      const decided = resolvePersonNames(v2Caller, runs, changes, 'caller');
      spelled.first_name = decided.first_name;
      spelled.last_name = decided.last_name;
    }
  }

  for (const { person, role } of secondaryPeople(extracted, v2Extraction)) {
    resolvePersonNames(person, runs, changes, role);
  }

  // Merged "...over at" surname: only when the spelled letters did not already
  // decide the last name.
  if (!spelled.last_name) {
    for (const person of callerObjects) splitMergedSurname(person, transcripts, changes, 'caller');
    if (extracted && v2Caller && extracted.last_name && v2Caller.last_name
        && normLetters(v2Caller.last_name) !== normLetters(extracted.last_name)
        && normLetters(v2Caller.last_name) === `${normLetters(extracted.last_name)}over`) {
      v2Caller.last_name = extracted.last_name;
    }
  }
  return spelled;
}

// ── 2. impossible phones ──────────────────────────────────────────────────

function rejectImpossiblePhones({ extracted, v2Extraction, changes }) {
  let rejectedSecondary = 0;
  for (const { person } of secondaryPeople(extracted, v2Extraction)) {
    for (const key of ['phone', 'phone_e164']) {
      if (person[key] && isImpossibleNanpPhone(person[key])) {
        person[key] = null;
        rejectedSecondary += 1;
        changes.push({ kind: 'impossible_phone_rejected', role: 'secondary', field: key });
      }
    }
  }
  const v2Caller = v2Extraction && v2Extraction.caller;
  let rejectedCaller = false;
  if (extracted && extracted.phone && isImpossibleNanpPhone(extracted.phone)) {
    extracted.phone = null;
    rejectedCaller = true;
  }
  if (v2Caller && v2Caller.phone_e164 && isImpossibleNanpPhone(v2Caller.phone_e164)) {
    v2Caller.phone_e164 = null;
    if (v2Caller.phone_source === 'spoken' || v2Caller.phone_source === 'both') v2Caller.phone_source = 'unknown';
    rejectedCaller = true;
  }
  if (rejectedCaller) changes.push({ kind: 'impossible_phone_rejected', role: 'caller', field: 'phone' });
  return { rejectedSecondary, rejectedCaller };
}

// ── 3. "you can't text this one" ──────────────────────────────────────────

const TEXT_REFUSAL_PATTERNS = [
  // "you can't text this one", "don't text this number", "can not text my phone"
  /\b(?:can(?:'|’)?t|cannot|can not|don(?:'|’)?t|do not|won(?:'|’)?t|will not|unable to|not able to|no)\s+(?:be\s+)?(?:texts?|texting|sms)\s+(?:to\s+)?(?:this|that|my|the)\s+(?:one|number|phone|line|cell|landline)\b/i,
  // "this number can't take texts", "this line doesn't receive texts"
  /\b(?:this|that)\s+(?:number|phone|line|one|landline)\s+(?:can(?:'|’)?t|cannot|can not|doesn(?:'|’)?t|does not|won(?:'|’)?t|isn(?:'|’)?t able to|is not able to)\s+(?:take|get|receive|accept|do)\s+(?:any\s+)?(?:texts?|text messages|sms)\b/i,
  // "this one doesn't text", "this number doesn't do text"
  /\b(?:this|that)\s+(?:number|phone|line|one)\s+(?:doesn(?:'|’)?t|does not|can(?:'|’)?t|cannot)\s+text\b/i,
  // "I have a different number that's a text number only" (a SEPARATE number is
  // the text line). Last on purpose: an explicit refusal is the better quote.
  // A bare "texts only" is a preference for texting, not a refusal, and is NOT
  // matched.
  /\b(?:different|other|another|separate)\s+(?:number|phone)[^.?!]{0,30}\btext(?:s|ing)?(?:\s+number)?\s+only\b/i,
];

// Video relay / TTY callers reach us from the relay provider's number, which
// cannot receive texts meant for the caller.
const RELAY_PATTERN = /\b(?:video relay(?:\s+service)?|relay service|relay operator|VRS|TTY|TRS)\b/i;

// The caller's own words that say the incoming number cannot take texts, or
// null. Caller turns only; an agent's "I'll text you" never counts. An explicit
// refusal beats the relay announcement as the quoted evidence.
function detectTextRefusalQuote(transcripts) {
  const list = (Array.isArray(transcripts) ? transcripts : [transcripts]).filter(Boolean);
  const sentencesOf = (transcript) => splitTurns(transcript)
    .filter((turn) => !STAFF_SPEAKER.test(turn.speaker))
    .flatMap((turn) => turn.text.split(/(?<=[.?!])\s+/));
  const all = list.flatMap(sentencesOf);
  for (const pattern of TEXT_REFUSAL_PATTERNS) {
    const hit = all.find((sentence) => pattern.test(sentence));
    if (hit) return hit.trim().slice(0, 160);
  }
  // A relay interpreter announcing the call ("a caller using sign language is
  // calling through the video relay service") is the same fact.
  const relay = all.find((sentence) => RELAY_PATTERN.test(sentence));
  return relay ? relay.trim().slice(0, 160) : null;
}

function applyTextRefusal({ v2Extraction, transcripts, changes }) {
  const caller = v2Extraction && v2Extraction.caller;
  if (!caller || caller.caller_id_disclaimed === true) return null;
  const quote = detectTextRefusalQuote(transcripts);
  if (!quote) return null;
  caller.caller_id_disclaimed = true;
  if (!caller.phone_note) caller.phone_note = quote;
  changes.push({ kind: 'text_refusal_disclaimed', role: 'caller', field: 'caller_id_disclaimed' });
  return quote;
}

// ── entry point ───────────────────────────────────────────────────────────

// Applies all three guards. `extracted` is the V1/legacy-flat view (returned
// as the same object, mutated); `v2Extraction` is the canonical V2 extraction
// or null. Returns { extracted, changes, spelledNameFields,
// rejectedSecondaryPhones, textRefusalQuote }. Throws nothing the caller needs
// to handle beyond a defensive try/catch.
function applyCallerDataGuards({ extracted, v2Extraction = null, transcripts = [] } = {}) {
  const changes = [];
  const spelledNameFields = applySpelledNames({ extracted, v2Extraction, transcripts, changes });
  const phones = rejectImpossiblePhones({ extracted, v2Extraction, changes });
  const textRefusalQuote = applyTextRefusal({ v2Extraction, transcripts, changes });
  return {
    extracted,
    changes,
    spelledNameFields,
    rejectedSecondaryPhones: phones.rejectedSecondary,
    rejectedCallerPhone: phones.rejectedCaller,
    textRefusalQuote,
  };
}

// ── on-file record correction ────────────────────────────────────────────

// Should the customer RECORD be corrected to the spelled name? Only when the
// caller spelled the name AND the record's name is a near-spelling of it (the
// same person, written wrong once: Earlbeck vs a spelled I-R-L-B-E-C-K) AND the
// other half of the name agrees. A record whose name is wholesale different (a
// spouse or tenant calling from the same line) is never overwritten.
// `sameFirst` is the caller-supplied nickname-aware first-name comparison.
function decideOnFileNameCorrection({ onFile, extracted, spelledNameFields, sameFirst }) {
  if (!onFile || !extracted || !spelledNameFields) return null;
  const out = {};
  const firstOk = () => {
    const a = normLetters(extracted.first_name);
    const b = normLetters(onFile.first_name);
    if (!a || !b) return true;
    return sameFirst ? !!sameFirst(a, b) : a === b;
  };
  const lastOk = () => {
    const a = normLetters(extracted.last_name);
    const b = normLetters(onFile.last_name);
    return !a || !b || a === b;
  };
  if (spelledNameFields.last_name && extracted.last_name && onFile.last_name && firstOk()) {
    const spelled = normLetters(extracted.last_name);
    const stored = normLetters(onFile.last_name);
    if (closeSpelling(spelled, stored)) out.last_name = properCase(extracted.last_name);
  }
  if (spelledNameFields.first_name && extracted.first_name && onFile.first_name && lastOk()) {
    const spelled = normLetters(extracted.first_name);
    const stored = normLetters(onFile.first_name);
    const nickname = sameFirst ? !!sameFirst(spelled, stored) : false;
    if (!nickname && closeSpelling(spelled, stored)) out.first_name = properCase(extracted.first_name);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  applyCallerDataGuards,
  decideOnFileNameCorrection,
  detectTextRefusalQuote,
  findSpelledNameRuns,
  closeSpelling,
  editDistance,
};
