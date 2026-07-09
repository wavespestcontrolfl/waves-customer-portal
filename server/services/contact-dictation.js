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
 *     transcripts → { emails, addresses } candidates. Number words become
 *     digits HERE ("six three" → 63), never in the literal transcript.
 *   - applyEmailDictationPolicy(): pure decision — adopt exactly one strong,
 *     validated candidate; anything ambiguous or URL-shaped is quarantined to
 *     the review card with a ready-to-read confirmation question.
 *
 * Fail-open everywhere: any model/provider failure returns null and the
 * pipeline behaves exactly as before this module existed.
 */

const logger = require('./logger');
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
// Suffix list covers the service area's actual street vocabulary — Fruitville
// ROAD, Abalone LOOP, Sandy COVE etc. previously tripped no signal, so the
// dictation-focused second STT pass never ran for those calls.
const ADDRESS_SIGNAL_RE = /\b(address is|service address|street|avenue|boulevard|drive|road|way|loop|place|cove|point|parkway|run|bend|pass|glen|trail|terrace|court|circle|lane|zip( code)?|unit \d|apartment)\b/i;

/**
 * Cheap gate for whether the call dictated contact info worth a decoder pass.
 * Pure; runs on the primary transcript.
 */
function detectContactDictationSignals(transcript) {
  const t = String(transcript || '');
  const email = EMAIL_SIGNAL_RE.test(t) || (/@/.test(t) && SPELLING_SIGNAL_RE.test(t));
  const address = ADDRESS_SIGNAL_RE.test(t);
  return { email, address, any: email || address };
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
  return `You are decoding dictated CONTACT FIELDS (email addresses and service addresses) from a pest-control phone call. Use the transcripts as EVIDENCE — do not blindly copy malformed transcript text; transcription mishears dictation.

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
  ]
}`;
}

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
 * Returns { emails, addresses } (sanitized shape) or null on any failure.
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
    return { emails, addresses };
  } catch (err) {
    logger.warn(`[contact-dictation] decoder failed open: ${err.message}`);
    return null;
  }
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
  sanitizeEmailCandidates,
  buildDecoderPrompt,
  CONTACT_DICTATION_TRANSCRIPTION_PROMPT,
  ADOPT_CONFIDENCE,
};
