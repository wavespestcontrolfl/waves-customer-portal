/**
 * Contact-field dictation recovery — the transcript is EVIDENCE, not the
 * source of truth for emails and addresses.
 *
 * A phone transcript optimizes for readable prose; a dictated email or street
 * address needs token-level fidelity ("W, C as in Charlie, W, six three at
 * Gmail dot com"). Forcing one transcript to serve both produces exactly the
 * failures this module exists for: spelled sequences merged into "www.cw63",
 * "Seafoam" rendered as "C Phone". The pipeline therefore keeps two outputs:
 *
 *   1. the literal diarized transcript (unchanged, what the caller said), and
 *   2. normalized contact-field CANDIDATES with confidence + confirmation
 *      flags, produced here by a purpose-built decoder pass.
 *
 * Pieces:
 *   - detectContactDictationSignals(transcript): cheap regex gate — did the
 *     call dictate an email / street address at all?
 *   - CONTACT_DICTATION_TRANSCRIPTION_PROMPT: literal-transcript prompt for a
 *     SECOND full-call pass on a promptable STT model (gpt-4o-transcribe; the
 *     diarized primary model does not support prompts, so this pass is the
 *     only place transcription prompting actually applies on the OpenAI path).
 *   - decodeDictatedContacts(): one structured Gemini call over both
 *     transcripts → { emails, addresses, names } candidates. Number words become
 *     digits HERE ("six three" → 63), never in the literal transcript.
 *   - applyEmailDictationPolicy(): pure decision — adopt exactly one strong,
 *     validated candidate; anything ambiguous or URL-shaped is quarantined to
 *     the review card with a ready-to-read confirmation question.
 *   - nameSpellingDifferences(): pure decision — a first/last name the CALLER
 *     spelled out letter by letter that differs from the name being saved is
 *     reported for an advisory review card. Card-only: no name is ever written
 *     from it. The model decides whose name each spelling is.
 *
 * Fail-open everywhere: any model/provider failure returns null and the
 * pipeline behaves exactly as before this module existed.
 */

const logger = require('./logger');
const { properCase } = require('../utils/name-case');
const { cleanValidEmailOrNull, looksGarbledTranscriptEmail } = require('../utils/intake-normalize');

const ENABLED = () => process.env.CONTACT_DICTATION_ENABLED !== 'false';
// Literal default (NOT chained to GEMINI_EXTRACTION_MODEL): the extraction
// var is the documented instant-rollback lever for the V2 extractor, and a
// rollback there must not silently downgrade the mishear-recovery decoder.
const DECODER_MODEL = () => process.env.GEMINI_CONTACT_DECODER_MODEL
  || 'gemini-2.5-pro';
// Adopt a decoded email only when the decoder returned exactly one usable
// candidate at or above this confidence. Below it (or with 2+ candidates) the
// value rides the review card instead of the customer record.
const ADOPT_CONFIDENCE = 0.75;

// ── Signal detection ─────────────────────────────────────────────────────────

const EMAIL_SIGNAL_RE = /\b(e-?mail|at g ?mail|at gmail|gmail dot|yahoo dot|outlook dot|hotmail dot|dot com|dot net|dot org)\b/i;
const SPELLING_SIGNAL_RE = /\b(spell(ed|ing)?|letter by letter|(as|like|for) in [a-z]+|[a-z] for [a-z]+)\b/i;
// A name spelled out letter by letter ("S-E-R-O-V", "S E R O V", "S as in
// Sam"). Tighter than SPELLING_SIGNAL_RE on purpose: this gates a paid decoder
// pass, and "like in the past" must not buy one.
// Bare "spell" only counts in a dictation phrase: "a dry spell" must not buy a
// paid second transcription pass and a decoder call.
const NAME_SPELLING_WORD_RE = /\bspell(?:ed|ing)\b|\bspell\s+(?:it|that|this|my|your|the|his|her|their|our)\b|\b(?:how|to)\s+(?:(?:do|can|would|could)\s+you\s+)?spell\b/i;
const NAME_SPELLING_LETTERS_RE = new RegExp([
  // Separated single letters: four or more in any case ("S, E, R, O, V", "v a r n u m").
  String.raw`\b(?:[A-Za-z]\s*[-.,]\s*){3,}[A-Za-z]\b`,
  String.raw`\b(?:[A-Za-z] ){3,}[A-Za-z]\b`,
  // Three letters need a stronger shape: capitals ("L-E-E", "L, E, E") or a hyphenated run.
  String.raw`\b(?:[A-Z]\s*[-.,]\s*){2,}[A-Z]\b`,
  String.raw`\b(?:[a-z]-){2,}[a-z]\b`,
  // Phonetic markers.
  String.raw`\b[A-Za-z]\s+as\s+in\s+[A-Za-z]{3,}\b`,
  // "V like Victor" / "S for Sam": a capital letter (never "I like pizza")...
  String.raw`\b[A-HJ-Z]\s+(?:like|for)\s+(?:in\s+)?[A-Za-z]{3,}\b`,
  // Three or more separated single letters shortly after the word "name" ("last name is l e e").
  String.raw`\b[Nn]ame\b[^.?!\n]{0,40}?\b(?:[A-Za-z][\s,-]+){2,}[A-Za-z]\b(?![A-Za-z'’])`,
].join('|'), '');
// ...or any casing when the word starts with the letter it names ("v like victor").
// A two-letter name only when the spelling repeats the name just spoken ("Li, L-I").
const NAME_SPELLING_TWO_LETTER_RE = /\b([a-z])([a-z])\b[\s,.]+\1\s*[-.,\s]\s*\2\b/i;
const NAME_SPELLING_PHONETIC_RE = /\b([a-z])\s+(?:as|like|for)\s+(?:in\s+)?\1[a-z]{2,}\b/i;
// Suffix coverage for the service area's street vocabulary — Fruitville ROAD,
// Abalone LOOP, Sandy COVE etc. previously tripped no signal, so the
// dictation-focused second STT pass never ran for those calls. The common
// words (way/run/pass/point/place/road/...) are QUALIFIED — they only signal
// when preceded by a house number + street name ("8224 Abalone Loop"), so
// "what's the best way to prevent ants" / "can you run my card" don't buy a
// paid second transcription pass (codex P2).
const ADDRESS_SIGNAL_RE = /\b(address is|service address|street|avenue|boulevard|drive|trail|terrace|court|circle|lane|zip( code)?|unit \d|apartment)\b|\b\d{1,6}\s+[a-z][a-z.'-]*\s+(road|rd|way|loop|place|cove|point|parkway|run|bend|pass|glen)\b/i;

/**
 * Cheap gate for whether the call dictated contact info worth a decoder pass.
 * Pure; runs on the primary transcript.
 */
function detectContactDictationSignals(transcript) {
  const t = String(transcript || '');
  const email = EMAIL_SIGNAL_RE.test(t) || (/@/.test(t) && SPELLING_SIGNAL_RE.test(t));
  const address = ADDRESS_SIGNAL_RE.test(t);
  const name = NAME_SPELLING_WORD_RE.test(t) || NAME_SPELLING_LETTERS_RE.test(t) || NAME_SPELLING_PHONETIC_RE.test(t) || NAME_SPELLING_TWO_LETTER_RE.test(t);
  return { email, address, name, any: email || address || name };
}

// ── Second-pass transcription prompt ─────────────────────────────────────────
// Applied ONLY on promptable STT models (gpt-4o-transcribe). Deliberately
// example-free: concrete streets/emails in a biasing prompt can seed values
// into future transcripts. The literal transcript keeps number WORDS as
// spoken — normalization to digits happens in the decoder, where the raw
// evidence is preserved alongside the candidate.
const CONTACT_DICTATION_TRANSCRIPTION_PROMPT = `Transcribe this phone call for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

Produce a literal transcript. Do not summarize, translate, clean up, or infer missing words.

Preserve speaker turns, fillers, corrections, hesitations, addresses, phone numbers, email addresses, names, and proper nouns as spoken.

When a caller dictates contact information, especially an email address, street address, phone number, ZIP code, gate code, or account number:
- Preserve each spoken token separately.
- Preserve number words as spoken in the transcript.
- Preserve phonetic markers separately, such as "B as in boy" or "C like Charlie".
- Do not merge spelled letters into a guessed word.
- Do not convert a spelled sequence into a URL or web address unless the caller explicitly says it is a website.
- Do not add "www", "http", or "https" unless the caller explicitly says those tokens.
- If a word could be a street name, prefer a plausible street-name rendering over a nonsensical phonetic rendering, but mark uncertainty with [?] if unclear.
- If uncertain between similar sounds, include an uncertainty marker [?] rather than forcing a single confident value.

Use clear punctuation and line breaks where helpful.`;

// ── Structured decoder ───────────────────────────────────────────────────────

function buildDecoderPrompt({ transcript, contactPassTranscript }) {
  return `You are decoding dictated CONTACT FIELDS (email addresses, service addresses, and spelled-out names) from a pest-control phone call. Use the transcripts as EVIDENCE — do not blindly copy malformed transcript text; transcription mishears dictation.

PRIMARY TRANSCRIPT (diarized):
"""
${transcript}
"""
${contactPassTranscript ? `SECOND-PASS TRANSCRIPT (dictation-focused, same audio — may render spelled sequences more faithfully):
"""
${contactPassTranscript}
"""
` : ''}
EMAIL RULES:
1. Preserve the raw spoken evidence verbatim in raw_spoken.
2. Decode phonetic spelling markers ("C as in Charlie" = the letter c), including markers the transcriber CONCATENATED into nonsense tokens ("blikenboy" = "B like in boy" = b).
3. In a dictated email local part, convert spoken number words to digits ("six three" -> 63) unless the caller clearly says the word itself is part of the address.
4. Convert "at" to "@" and "dot"/"period"/"point" to "." only inside an email context. "oh" is ambiguous between the letter o and digit 0 — return both candidates unless context resolves it.
5. The caller's spelling beats any read-back or summary as transcribed — the read-back is one more chance to mishear. Trust an agent's read-back only when the caller explicitly confirms it.
6. Never produce a URL-shaped local part ("www.", "http", "slash") from call audio — that is a mis-transcription of spelled letters. Decode the letters instead, or omit the candidate.
7. When a letter/digit is ambiguous (one W vs two), return MULTIPLE candidates with honest confidences and needs_confirmation true.
8. Do not invent missing letters. Fewer, honest candidates beat one forced guess.

ADDRESS RULES:
1. Preserve the raw spoken evidence verbatim in raw_spoken.
2. Extract house number, street, city, state, zip separately in parsed_as_heard; normalize spoken number words to digits for house number and ZIP.
3. Street names are real words or proper names. If the transcribed street name is nonsensical phonetic text, list plausible real street-name alternatives that SOUND like it (street_alternatives, with suffix, no house numbers) — consider suffix mishears too (Trail/Terrace/Trace, Court/Cove, Lane/Drive).
4. Do not invent an address the caller did not say; alternatives are re-hearings of what they DID say.

NAME RULES:
1. Report a name ONLY when a speaker actually spelled it out letter by letter (a run of single letters, or letters with phonetic markers such as "B as in boy"). A name merely said aloud is not a spelling — omit it.
2. raw_spoken is the spelling evidence verbatim. spelled_value is the name those letters make, joined and capitalized the way the letters spell it. Use only the letters spelled; never invent, complete or "fix" a name.
3. field is "first_name" or "last_name".
4. whose is "caller" ONLY when the spelling is of the CALLER's OWN name (the person speaking, not the Waves agent). Use "other" for anyone else the caller mentions (a buyer, tenant, spouse, parent, neighbor, a business contact) and whenever you are unsure whose name it is.
5. If the caller spells the same field two different ways, return both entries with honest confidences.

Return ONLY JSON with this exact shape (empty arrays when nothing was dictated):
{
  "emails": [
    {
      "raw_spoken": "",
      "candidates": [ { "value": "", "confidence": 0.0, "basis": [""], "risks": [""] } ],
      "needs_confirmation": true,
      "confirmation_question": ""
    }
  ],
  "addresses": [
    {
      "raw_spoken": "",
      "parsed_as_heard": { "house_number": "", "street": "", "city": "", "state": "", "zip": "" },
      "street_alternatives": [""],
      "needs_confirmation": true,
      "confirmation_question": ""
    }
  ],
  "names": [
    { "raw_spoken": "", "spelled_value": "", "field": "first_name or last_name", "whose": "caller or other", "confidence": 0.0 }
  ]
}`;
}

// Bounded like every other provider call the call-processing pass can reach:
// this is awaited while that pass holds a claim whose heartbeat beats on a
// timer, so an unbounded fetch is indistinguishable from a hang and leaves
// the call unreclaimable (codex #3677 P1).
const DECODER_TIMEOUT_MS = Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS) > 0
  ? Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS)
  : 180000;

async function fetchDecoderResponse(prompt) {
  if (!process.env.GEMINI_API_KEY) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DECODER_MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(DECODER_TIMEOUT_MS),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || null;
}

/**
 * Filter decoder email candidates down to values that could actually be
 * stored: syntactically valid, not URL-shaped garble, confidence clamped to
 * [0,1], deduped (highest confidence wins). Deterministic and unit-tested —
 * the LLM's output never reaches a write path without passing this.
 */
function sanitizeEmailCandidates(candidates) {
  const byValue = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const value = cleanValidEmailOrNull(c?.value);
    if (!value || looksGarbledTranscriptEmail(value)) continue;
    const confidence = Math.max(0, Math.min(1, Number(c?.confidence) || 0));
    const existing = byValue.get(value);
    if (!existing || confidence > existing.confidence) {
      byValue.set(value, {
        value,
        confidence,
        basis: Array.isArray(c?.basis) ? c.basis.slice(0, 5).map(String) : [],
        risks: Array.isArray(c?.risks) ? c.risks.slice(0, 5).map(String) : [],
      });
    }
  }
  return [...byValue.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * One structured decoder pass over the call's transcripts.
 * Returns { emails, addresses, names } (sanitized shape) or null on any failure.
 */
async function decodeDictatedContacts({ transcript, contactPassTranscript = null, deps = {} } = {}) {
  if (!ENABLED() || !String(transcript || '').trim()) return null;
  try {
    const fetchResponse = deps.fetchResponse || fetchDecoderResponse;
    const rawText = await fetchResponse(buildDecoderPrompt({ transcript, contactPassTranscript }));
    if (!rawText) return null;
    const cleaned = String(rawText).replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const emails = (Array.isArray(parsed.emails) ? parsed.emails : []).slice(0, 3).map((e) => ({
      raw_spoken: String(e?.raw_spoken || '').slice(0, 500),
      candidates: sanitizeEmailCandidates(e?.candidates),
      needs_confirmation: e?.needs_confirmation !== false,
      confirmation_question: String(e?.confirmation_question || '').slice(0, 300),
    }));
    const addresses = (Array.isArray(parsed.addresses) ? parsed.addresses : []).slice(0, 3).map((a) => ({
      raw_spoken: String(a?.raw_spoken || '').slice(0, 500),
      parsed_as_heard: {
        house_number: String(a?.parsed_as_heard?.house_number || '').slice(0, 12),
        street: String(a?.parsed_as_heard?.street || '').slice(0, 120),
        city: String(a?.parsed_as_heard?.city || '').slice(0, 60),
        state: String(a?.parsed_as_heard?.state || '').slice(0, 2),
        zip: String(a?.parsed_as_heard?.zip || '').slice(0, 10),
      },
      street_alternatives: (Array.isArray(a?.street_alternatives) ? a.street_alternatives : [])
        .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5),
      needs_confirmation: a?.needs_confirmation !== false,
      confirmation_question: String(a?.confirmation_question || '').slice(0, 300),
    }));
    return { emails, addresses, names: sanitizeNameEntries(parsed.names, [transcript, contactPassTranscript]) };
  } catch (err) {
    logger.warn(`[contact-dictation] decoder failed open: ${err.message}`);
    return null;
  }
}

// ── Spelled names (card-only) ────────────────────────────────────────────────
// A spelling the caller gives of their own name is EVIDENCE for the office, never
// an automatic write: nothing here changes an extraction, a customer or a lead.
// When a grounded spelling attributed to the caller differs from the name being
// saved for the caller, the processor files ONE advisory `name_spelling_differs`
// card carrying the spelling, the saved name and the caller turn it came from.

const NAME_FIELDS = ['first_name', 'last_name'];
const SPELLED_NAME_RE = /^\p{L}[\p{L}'’ -]{0,48}\p{L}$/u;
const EMAIL_WORDING_RE = /e-?mail|@|\bdot\b|\bat\b[^\n]{0,25}\b(?:dot|gmail|yahoo|outlook|hotmail|icloud)/;

const squash = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
const nameKey = (v) => String(v || '').toLowerCase().replace(/[^\p{L}]/gu, '');

// Spoken punctuation that joins parts of one spelled name; it adds no letter and does not end the run.
const SPOKEN_JOINER_RE = /^(?:apostrophe|hyphen|dash|space|['’])$/i;

// The letters a spelling actually spells: runs of single-letter tokens, with
// "S as in Sam" reduced to its letter. Words, and apostrophe words like "it's",
// are never single-letter tokens.
function spelledLetterRuns(raw) {
  const reduced = String(raw || '').replace(/\b([A-Za-z])\s+(?:as|like|for)\s+(?:in\s+)?[A-Za-z]+/gi, '$1');
  const runs = [];
  let run = '';
  for (const tok of reduced.split(/[\s,.\-]+/).filter(Boolean)) {
    if (SPOKEN_JOINER_RE.test(tok)) continue; // "O apostrophe N-E-I-L", "M-A-R-Y hyphen A-N-N": same run
    if (/^[A-Za-z]$/.test(tok)) run += tok.toLowerCase();
    else { if (run) runs.push(run); run = ''; }
  }
  if (run) runs.push(run);
  return runs;
}

// The caller turn that contains the spelling, or null. The simple qualifier:
// when a transcript carries Agent:/Caller: labels the turn must be labeled
// Caller:; an unlabeled transcript (the dictation pass) is taken as it is; a turn
// with email wording is an address, not a name.
function callerTurnWithSpelling(raw, sources) {
  const flat = (v) => String(v || '').replace(/[ \t]+/g, ' ');
  const needle = flat(raw).trim().replace(/\s*\n\s*/g, ' ').toLowerCase();
  if (!needle) return null;
  for (const src of sources) {
    const text = flat(src);
    const lower = text.toLowerCase();
    const labeled = /^\s*(?:agent|caller)\s*:/im.test(text);
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      const start = text.lastIndexOf('\n', at) + 1;
      const endIdx = text.indexOf('\n', at + needle.length);
      const turn = text.slice(start, endIdx < 0 ? text.length : endIdx).trim();
      if ((!labeled || /^caller\s*:/i.test(turn)) && !EMAIL_WORDING_RE.test(turn.toLowerCase())) return turn.slice(0, 300);
    }
  }
  return null;
}

/**
 * Keep the decoder's name entries that are well formed and GROUNDED: field
 * first_name|last_name, a letters-only value, raw_spoken present in a source
 * transcript, and the letters it spells equal to the value. `whose` is the
 * model's judgment ("caller" only when it said so); `turn` is the caller turn
 * the spelling sits in (null when it fails the simple qualifier).
 */
function sanitizeNameEntries(entries, sources = []) {
  const srcs = (Array.isArray(sources) ? sources : []).filter(Boolean);
  const haystacks = srcs.map(squash).filter(Boolean);
  const out = [];
  for (const n of (Array.isArray(entries) ? entries : []).slice(0, 6)) {
    const spelled = String(n?.spelled_value || '').trim().replace(/\s+/g, ' ');
    if (!NAME_FIELDS.includes(n?.field) || !SPELLED_NAME_RE.test(spelled)) continue;
    const raw = squash(n?.raw_spoken);
    if (!raw || !haystacks.some((h) => h.includes(raw))) continue;
    if (!spelledLetterRuns(n.raw_spoken).includes(nameKey(spelled))) continue;
    out.push({
      raw_spoken: String(n.raw_spoken).slice(0, 300),
      spelled_value: properCase(spelled),
      field: n.field,
      whose: n?.whose === 'caller' ? 'caller' : 'other',
      confidence: Math.max(0, Math.min(1, Number(n?.confidence) || 0)),
      turn: callerTurnWithSpelling(n.raw_spoken, srcs),
    });
  }
  return out;
}

/**
 * The name-spelling differences to put on the review card. `saved` is the name
 * being saved for the caller ({ first_name, last_name }). Per field, only entries
 * the model attributed to the caller, at ADOPT_CONFIDENCE or above, in a qualifying
 * caller turn count; two caller spellings of one field that disagree decide nothing;
 * a field with no saved name is the missing-name cards' job; letters that already
 * match (any case) need no card. Pure.
 */
function nameSpellingDifferences({ dictation = null, saved = {} } = {}) {
  const out = [];
  for (const field of NAME_FIELDS) {
    const entries = (dictation?.names || []).filter((n) => n.field === field && n.whose === 'caller'
      && n.confidence >= ADOPT_CONFIDENCE && n.turn);
    if (new Set(entries.map((n) => nameKey(n.spelled_value))).size !== 1) continue;
    const best = entries.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const savedValue = String(saved[field] || '').trim();
    if (!savedValue || nameKey(savedValue) === nameKey(best.spelled_value)) continue;
    out.push({ field, spelled_value: best.spelled_value, saved_value: savedValue, quote: best.turn, confidence: best.confidence });
  }
  return out;
}

/**
 * The name_spelling_differs card payload: the main discrepancy, the card text, the other
 * differing entries, and WHAT it was compared against (the linked customer's record, whose id
 * the card carries so the office opens that record, or the name heard on the call). Pure.
 */
function nameSpellingCardPayload({ top, others = [], saved = {}, filingCustomer = null }) {
  return {
    ...top,
    card_text: nameSpellingCardText(top),
    also: others,
    compared_against: {
      source: filingCustomer ? 'customer' : 'extracted',
      name: [saved.first_name, saved.last_name].filter(Boolean).join(' ') || null,
    },
    customer_ids: [filingCustomer].filter(Boolean),
  };
}

/**
 * Drop the discrepancies a HUMAN already settled for the SAME filing customer (or unlinked):
 * each is judged on its own (customer, field, spelling, saved name) against every settled card's
 * evidence (its main entry and its `also` list), so a decision for customer A does not suppress
 * the same discrepancy for customer B after a relink. `settledPayloads` are the settled cards'
 * payload objects. Pure.
 */
function unsettledNameDifferences(differences, settledPayloads, filingCustomer) {
  const key = (d, who) => `${who}|${d?.field}|${d?.spelled_value}|${d?.saved_value}`;
  const seen = new Set((settledPayloads || []).flatMap((o) => {
    const who = String((Array.isArray(o?.customer_ids) && o.customer_ids[0]) || 'unlinked');
    return [o, ...(Array.isArray(o?.also) ? o.also : [])].map((d) => key(d, who));
  }));
  return differences.filter((d) => !seen.has(key(d, filingCustomer || 'unlinked')));
}

// "Caller spelled their name S-E-R-O-V; the record says Sirov. Fix the name if the spelling is theirs."
function nameSpellingCardText({ spelled_value: spelled, saved_value: saved }) {
  const letters = nameKey(spelled).toUpperCase().split('').join('-');
  return `Caller spelled their name ${letters}; the record says ${saved}. Fix the name if the spelling is theirs.`;
}

/**
 * Pure email adoption policy over the decoder output.
 *
 *   - exactly ONE usable candidate at/above ADOPT_CONFIDENCE, with NO declared
 *     risks, that does not CONTRADICT a clean already-extracted email → adopt
 *     (caller still applies the cross-customer ownership gate before writing);
 *   - anything else with dictation evidence → quarantine: candidates +
 *     confirmation question ride the review payload, nothing is stored.
 *     A candidate the decoder itself flagged with a risk ("caller's summary
 *     contradicts the spelling") is exactly the mail-the-wrong-person case,
 *     no matter how confident the value looks.
 *
 * Returns { adopt: string|null, hold: boolean, payload: object|null }.
 *   adopt — value to write into extracted.email (ownership-gated by caller).
 *   hold  — the dictation evidence is ambiguous/risk-flagged and an email the
 *     primary extraction already captured came from that SAME dictation, so
 *     it must be DEMOTED (email → email_raw) before any write/send path reads
 *     it — quarantine is meaningless if the risky value stays stored. The only
 *     existing value that survives dictation review is one the decoder cleanly
 *     agrees with (single risk-free strong candidate equal to it).
 *   payload — attached to the email triage item so the reviewer sees the
 *     candidates and the exact question to ask.
 */
function applyEmailDictationPolicy({ extracted = {}, dictation = null } = {}) {
  const entry = dictation?.emails?.[0];
  if (!entry || (!entry.candidates.length && !entry.raw_spoken)) return { adopt: null, hold: false, payload: null };

  const payload = {
    email_as_heard: entry.raw_spoken || null,
    email_candidates: entry.candidates.map((c) => ({ value: c.value, confidence: c.confidence })),
    confirmation_question: entry.confirmation_question || null,
  };
  const existing = String(extracted.email || '').trim().toLowerCase();
  const top = entry.candidates[0];
  const single = entry.candidates.length === 1
    && top.confidence >= ADOPT_CONFIDENCE
    && top.risks.length === 0;
  // A clean extracted email that disagrees with the single candidate is a
  // conflict, not a correction — hold both for the read-back.
  const conflictsWithExtracted = !!existing && !!top && existing !== top.value;

  if (single && !conflictsWithExtracted) {
    return { adopt: existing === top.value ? null : top.value, hold: false, payload };
  }
  return { adopt: null, hold: !!existing, payload };
}

module.exports = {
  detectContactDictationSignals,
  decodeDictatedContacts,
  applyEmailDictationPolicy,
  nameSpellingDifferences,
  nameSpellingCardText,
  unsettledNameDifferences,
  nameSpellingCardPayload,
  sanitizeEmailCandidates,
  sanitizeNameEntries,
  buildDecoderPrompt,
  CONTACT_DICTATION_TRANSCRIPTION_PROMPT,
  ADOPT_CONFIDENCE,
};
