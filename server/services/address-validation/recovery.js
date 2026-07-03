/**
 * Address recovery — second-chance lookup for a street Google Address
 * Validation could NOT resolve (missing_component / ambiguous / confirm_needed).
 *
 * Call transcription garbles street names phonetically ("Seafoam Trail" →
 * "C. Phone Trail"), and Address Validation only validates what it's given —
 * it never suggests what the caller more plausibly said. This module closes
 * that gap in two phases, both anchored on the house number the caller stated:
 *
 *   1. Places Autocomplete on the raw street as heard — catches mild garbles
 *      Google can fuzzy-match directly.
 *   2. Phonetic re-hearing: ask Gemini for up to MAX_CANDIDATES street names
 *      that SOUND like the garbled one, then run each through Autocomplete.
 *
 * Every Autocomplete prediction is filtered to the caller's house number and
 * then confirmed through the Address Validation API. A recovery is returned
 * ONLY when exactly one distinct premise survives confirmation (status
 * validated_accept/corrected, house number match, and the caller's ZIP —
 * or city when no ZIP was given — corroborates). Anything weaker is returned
 * as `candidates` for the human reviewer, never adopted.
 *
 * Fail-open by design: any provider/model error yields { recovered: null } and
 * the caller keeps the raw address + address_unverified flag exactly as before
 * this module existed. Kill switch: ADDRESS_RECOVERY_ENABLED=false (default on,
 * but the processor only invokes recovery when address validation itself ran,
 * so the ADDRESS_VALIDATION_ENABLED + key preconditions are inherited).
 */

const logger = require('../logger');
const { validateAddress, STATUSES } = require('./index');

const GOOGLE_KEY = () => process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY
  || process.env.GOOGLE_API_KEY
  || process.env.GOOGLE_MAPS_API_KEY;

const ENABLED = () => process.env.ADDRESS_RECOVERY_ENABLED !== 'false';

const RECOVERY_MODEL = () => process.env.GEMINI_RECOVERY_MODEL
  || process.env.GEMINI_EXTRACTION_MODEL
  || 'gemini-2.5-pro';

// AV statuses where the input street may simply be a mis-hearing worth a
// second-chance lookup. validated_accept/corrected already resolved;
// out_of_service_area resolved somewhere real (recovery would fabricate an
// in-area address for an out-of-area caller); api_unavailable/not_attempted
// have nothing to recover from.
const RECOVERABLE_STATUSES = new Set([
  STATUSES.MISSING_COMPONENT,
  STATUSES.AMBIGUOUS,
  STATUSES.CONFIRM_NEEDED,
]);

const MAX_CANDIDATES = 5; // phonetic re-hearings per call
const MAX_CONFIRMATIONS = 3; // AV confirmation calls per recovery

const houseNumberOf = (street) => (String(street || '').trim().match(/^\d+/) || [null])[0];
const zip5 = (zip) => (String(zip || '').match(/^\d{5}/) || [null])[0];
const cityKey = (city) => String(city || '').toLowerCase().replace(/[^a-z]/g, '');

/** Places Autocomplete → array of prediction descriptions ([] on zero results, null on API failure). */
async function fetchAutocompletePredictions(input) {
  const key = GOOGLE_KEY();
  if (!key) return null;
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
      + `?input=${encodeURIComponent(input)}&types=address&components=country:us&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return null;
    return (data.predictions || []).map((p) => p.description).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Gemini phonetic re-hearing: street names that sound like the garbled one.
 * Returns [] on any model failure — recovery just proceeds with nothing.
 */
async function fetchPhoneticStreetCandidates({ streetName, city, state, zip }) {
  if (!process.env.GEMINI_API_KEY) return [];
  const prompt = `A phone-call transcription mis-heard a street name. The transcriber wrote the street name as "${streetName}" for an address in ${[city, state, zip].filter(Boolean).join(', ')}.
Street names are usually real words or proper names; transcription errors are PHONETIC (the written words sound like the real street when read aloud — e.g. "C Phone" is how "Seafoam" sounds, "Amber Crick" is "Amber Creek").
List up to ${MAX_CANDIDATES} plausible real street names (with their suffix, e.g. "Trail", "Drive") that "${streetName}" could be a mis-hearing of. Order by phonetic closeness. Do NOT include house numbers, cities, or the garbled name itself.
Return ONLY JSON: {"candidates": ["...", "..."]}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${RECOVERY_MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
        }),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || '{}';
    const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map((c) => String(c || '').trim())
      .filter(Boolean)
      .slice(0, MAX_CANDIDATES);
  } catch (err) {
    logger.warn(`[address-recovery] phonetic candidates failed: ${err.message}`);
    return [];
  }
}

/**
 * Confirm one Autocomplete prediction through Address Validation. Accepts only
 * a resolved premise whose house number matches the caller's and whose ZIP
 * (or city, when the caller gave no ZIP) corroborates what the caller stated.
 * Returns the AV-normalized address or null.
 */
async function confirmPrediction(prediction, { houseNumber, callerZip, callerCity }, validate) {
  const av = await validate({ addressLines: [prediction] });
  if (!av || (av.status !== STATUSES.VALIDATED_ACCEPT && av.status !== STATUSES.CORRECTED)) return null;
  const n = av.normalized || {};
  if (houseNumberOf(n.street_line_1) !== houseNumber) return null;
  const callerZip5 = zip5(callerZip);
  if (callerZip5) {
    if (zip5(n.postal_code) !== callerZip5) return null;
  } else if (!callerCity || cityKey(n.city) !== cityKey(callerCity)) {
    // No ZIP to corroborate — require the city to match instead. A prediction
    // matching on house number alone is not evidence it's the caller's street.
    return null;
  }
  return { ...n, county: av.county || null };
}

/**
 * Try to recover a real premise from a garbled street.
 *
 * @param {object} opts.extracted  flat V1-style record: address_line1/city/state/zip
 * @param {string} opts.avStatus   the Address Validation status for that record
 * @param {string[]} [opts.extraStreetCandidates]  street-name re-hearings an
 *   upstream pass already produced (contact-dictation decoder) — tried before
 *   this module spends its own phonetic model call.
 * @param {object} [opts.deps]     injectable { autocomplete, phonetic, validate } for tests
 * @returns {{ attempted: boolean, recovered: object|null, candidates: string[], method: string|null }}
 *   recovered = { address_line1, city, state, zip } — set only on exactly ONE confirmed premise.
 *   candidates = distinct house-number-matching prediction strings (for the review payload).
 */
async function recoverStreetAddress({ extracted = {}, avStatus, extraStreetCandidates = [], deps = {} } = {}) {
  const none = { attempted: false, recovered: null, candidates: [], method: null };
  if (!ENABLED() || !RECOVERABLE_STATUSES.has(avStatus)) return none;

  const street = String(extracted.address_line1 || '').trim();
  const houseNumber = houseNumberOf(street);
  const streetName = street.replace(/^\d+\s*/, '').trim();
  const callerCity = String(extracted.city || '').trim();
  const callerZip = String(extracted.zip || '').trim();
  // The house number anchors every match; without it (or any locality context)
  // an Autocomplete hit could be anywhere.
  if (!houseNumber || !streetName || (!callerCity && !zip5(callerZip))) return none;

  const autocomplete = deps.autocomplete || fetchAutocompletePredictions;
  const phonetic = deps.phonetic || fetchPhoneticStreetCandidates;
  const validate = deps.validate || validateAddress;

  const locality = [callerCity, extracted.state || 'FL', callerZip].filter(Boolean).join(' ');
  const matchesHouse = (p) => houseNumberOf(p) === houseNumber;
  const seen = new Set();
  const distinct = (list) => (list || []).filter((p) => {
    const k = String(p).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  try {
    // Phase 1: the street as heard — Autocomplete's own fuzzy matching.
    let method = 'autocomplete';
    let predictions = distinct((await autocomplete(`${street}, ${locality}`) || []).filter(matchesHouse));

    // Phase 1.5: re-hearings an upstream pass (contact-dictation decoder)
    // already produced — free candidates before spending our own model call.
    if (!predictions.length && extraStreetCandidates.length) {
      method = 'dictation';
      for (const candidate of extraStreetCandidates.slice(0, MAX_CANDIDATES)) {
        const preds = await autocomplete(`${houseNumber} ${candidate}, ${locality}`);
        predictions.push(...distinct((preds || []).filter(matchesHouse)));
      }
    }

    // Phase 2: our own phonetic re-hearings, anchored to the caller's house number.
    if (!predictions.length) {
      method = 'phonetic';
      const candidates = await phonetic({ streetName, city: callerCity, state: extracted.state || 'FL', zip: callerZip });
      for (const candidate of candidates) {
        const preds = await autocomplete(`${houseNumber} ${candidate}, ${locality}`);
        predictions.push(...distinct((preds || []).filter(matchesHouse)));
      }
    }
    if (!predictions.length) return { attempted: true, recovered: null, candidates: [], method: null };

    const confirmed = [];
    for (const prediction of predictions.slice(0, MAX_CONFIRMATIONS)) {
      const hit = await confirmPrediction(prediction, { houseNumber, callerZip, callerCity }, validate);
      if (hit) confirmed.push(hit);
    }
    // Distinct confirmed premises — two different validated streets is genuine
    // ambiguity, which belongs to a human, not an auto-adopt.
    const premiseKeys = new Set(confirmed.map((c) => `${cityKey(c.street_line_1)}|${zip5(c.postal_code)}`));
    const recovered = premiseKeys.size === 1
      ? {
        address_line1: confirmed[0].street_line_1,
        city: confirmed[0].city,
        state: confirmed[0].state,
        zip: confirmed[0].postal_code,
      }
      : null;
    return { attempted: true, recovered, candidates: predictions.slice(0, MAX_CONFIRMATIONS), method: recovered ? method : null };
  } catch (err) {
    logger.warn(`[address-recovery] failed open: ${err.message}`);
    return { attempted: true, recovered: null, candidates: [], method: null };
  }
}

module.exports = {
  recoverStreetAddress,
  fetchAutocompletePredictions,
  fetchPhoneticStreetCandidates,
  confirmPrediction,
  RECOVERABLE_STATUSES,
  houseNumberOf,
};
