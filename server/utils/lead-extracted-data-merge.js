/**
 * mergeLeadExtractedData — the ONE merge policy for `leads.extracted_data`.
 *
 * Both writers of this column resolve a lead by PHONE, so any later call from
 * the same number lands on the same row: the voice agent's capture_lead
 * (`lead-from-extraction.js`) and the recorded-call enrichment
 * (`call-recording-processor.js` Step 4b). Whichever one happens to handle a
 * caller decided whether their earlier data survived — the voice-agent path
 * merged (codex #3569), the recorded-call path rebuilt the payload wholesale.
 *
 * The wholesale rebuild is a data-loss bug, and it has now fired on both
 * paths. 2026-08-31: a 157-second call captured the caller's pest problem and
 * the recurring service they wanted, with a quote promised on the call; the
 * caller rang back 18 minutes later for 14 seconds to chase that estimate, and
 * the second payload REPLACED the first — the problem statement and the
 * standing quote obligation both vanished from the lead card the office works
 * from, and the lead was demoted to unqualified.
 *
 * The policy, applied to every writer:
 *   - FILL-FORWARD: a payload that simply didn't mention a field keeps the
 *     value already on the lead instead of nulling it.
 *   - STICKY-ON: an obligation the business took on ("we'll send you a
 *     quote") is never cleared by a later payload that doesn't restate it.
 *     Discharging it is a human act, not the absence of a mention.
 *   - LATEST-WINS: genuinely per-call facts (sentiment, call_type) are a
 *     snapshot of THIS call and replace the prior value.
 *   - RECOMPUTED: keys the caller re-derives every pass (needs_confirmation,
 *     missing_for_qualification) must NOT fill-forward — a stale value would
 *     outlive the condition that produced it. The caller names them.
 */

// A payload that omits these keeps the lead's value.
// FILL-FORWARD: a stored value survives a payload that doesn't restate it.
//
// An explicit null CANNOT be treated as "clear this" here, and the extraction
// schema is why: preferred_date_time is documented as "null if not confirmed"
// and the model emits the key on EVERY extraction. So null means "this call
// didn't state a time", never "the caller withdrew the one they gave" — the
// two are indistinguishable in the payload. Honouring null as a clear would
// wipe a stored appointment preference on every follow-up that didn't repeat
// it, which is the exact degradation this module exists to prevent (the
// incident's own thin follow-up carried preferred_date_time: null).
// Clearing an obsolete preference needs a real withdrawal signal in the
// extraction schema; it is not recoverable from the absence of a value.
const FILL_FORWARD_KEYS = ['preferred_date_time'];
// additional_properties is a COLLECTION, so latest-wins is data loss of the
// same kind this module exists to stop: a later call that mentions one
// property would drop every property an earlier call captured. Union by a
// stable identity instead.
//
// Deliberately UNCAPPED. An earlier draft sliced the list to ten as
// growth insurance, but that silently discarded captured service addresses —
// and worse, truncated a stored row that already held more than ten the next
// time any property merged. Every property a caller discusses drives an
// estimate and a dispatch, so dropping one is unrecoverable; the union is
// identity-keyed, so the list only grows when a genuinely new address is
// named, which real callers bound on their own.
// pain_points ACCUMULATES rather than fills forward. Fill-forward alone only
// defends against a payload that OMITS the field; the 2026-08-31 incident had
// the follow-up call SUPPLY one (its complaint about the missing estimate),
// which would still have swapped out the pest problem. That problem is what the
// office dispatches against, so the first statement is kept and a genuinely new
// one is appended.
// Uncapped, for the same reason additional_properties is: a concern a caller
// reported is a fact about the job, and silently dropping the fourth one loses
// it from the lead entirely. De-duplication (below) is what keeps this bounded
// in practice — a caller restating the same problem adds nothing.
const PAIN_POINTS_SEPARATOR = ' · ';
// Once true on the lead, only a human clears it.
const STICKY_ON_KEYS = ['quote_requested', 'quote_promised'];

function parseLeadExtractedData(value) {
  if (!value) return {};
  // Postgres hands a JSONB array back as a JS ARRAY, which is typeof 'object'.
  // Returning it unchanged would let the merge spread its indexes into
  // extracted_data as numeric keys; degrade it to {} exactly as the string
  // branch below does.
  if (Array.isArray(value)) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// A property's identity is its normalized STREET line. Zip only
// DISAMBIGUATES: two entries match when their zips are equal or either side
// simply didn't capture one. Keying on street+zip meant a later partial
// re-mention that omitted the zip minted a duplicate property, which would
// then mislead multi-property estimate handling.
function propertyStreetKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = String(entry.address_line1 || entry.address || '').trim();
  if (!raw) return null;
  // Peel any unit written INTO the street line so "100 Main St Apt 4" and
  // "100 Main St" + address_line2 "Apt 4" key the same street; the unit then
  // decides identity separately, in propertyUnitKey below.
  const { splitStreetLineUnit, normalizeStreetLine } = require('./address-normalizer');
  const street = splitStreetLineUnit(raw).street || raw;
  // Through the shared normalizer, per the existing-mechanism rule: it
  // canonicalizes suffix aliases, so "100 First Street" and "100 First St."
  // are ONE property rather than a restatement turning into an extra job on
  // the estimate. It canonicalizes spellings of the same street; it does not
  // loosen what counts as the same address.
  const canonical = normalizeStreetLine(street) || street;
  const line = canonical.trim().toLowerCase().replace(/\s+/g, ' ');
  return line || null;
}

// The unit is part of a property's IDENTITY, not a detail of it: two units at
// one street address are two service addresses, and merging them overwrites
// the first — dropping a real address and sending estimating or dispatch to
// the wrong door. Read from address_line2, falling back to a unit embedded in
// the street line, through the shared address-normalizer so "#4", "Apt 4" and
// "Unit 4" are one key.
function propertyUnitKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const { normalizeUnitLine, unitLineValueKey, splitStreetLineUnit } = require('./address-normalizer');
  const explicit = String(entry.address_line2 || entry.unit || '').trim();
  const embedded = explicit ? '' : (splitStreetLineUnit(String(entry.address_line1 || entry.address || '')).unit || '');
  const unit = explicit || embedded;
  return unit ? unitLineValueKey(normalizeUnitLine(unit)) : '';
}

// Key-sorted so two structurally identical entries serialize identically
// whatever order Postgres handed their keys back in.
function stablePropertyJson(value) {
  if (Array.isArray(value)) return `[${value.map(stablePropertyJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stablePropertyJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function propertyZip(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.zip || entry.postal_code || '').trim();
}

function propertyCity(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.city || '').trim().toLowerCase();
}

// Two entries are the same property when the street matches AND the location
// actively corroborates it. Zip decides when both carry one. When either zip
// is missing, city must corroborate — same street name in two different towns
// is two properties, and merging them would silently drop one, which the
// call-pipeline rule forbids. Street alone, with NO location evidence on
// either side, is not enough to merge: ambiguous entries stay separate.
function sameProperty(a, b) {
  const keyA = propertyStreetKey(a);
  const keyB = propertyStreetKey(b);
  if (!keyA || !keyB) return stablePropertyJson(a) === stablePropertyJson(b);
  if (keyA !== keyB) return false;
  // Units decide before location does. Different units are different
  // properties however well the zip corroborates, and a unit on only ONE
  // side is ambiguous — the same stance this function already takes on a
  // one-sided zip or city, and the safe one when the cost of guessing wrong
  // is losing a service address.
  const unitA = propertyUnitKey(a);
  const unitB = propertyUnitKey(b);
  if (unitA || unitB) {
    if (unitA !== unitB) return false;
  }
  const zipA = propertyZip(a);
  const zipB = propertyZip(b);
  if (zipA && zipB) return zipA === zipB;
  const cityA = propertyCity(a);
  const cityB = propertyCity(b);
  if (cityA && cityB) return cityA === cityB;
  // One side has a zip/city the other simply didn't capture: corroborate on
  // whichever the partial side DOES carry, else keep them apart — EXCEPT when
  // the two entries are literally the same record. Without that exception an
  // address-only property was never equal even to itself, so the under-lock
  // re-merge (which re-applies this pass's own payload over the locked row)
  // appended another copy every time and one address read as several jobs.
  return stablePropertyJson(a) === stablePropertyJson(b);
}

// Prior fields survive unless this payload supplies a real replacement.
function mergeEntryFields(prior, next) {
  const out = { ...prior };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
}

// A merge can end up holding the SAME unit twice — the stored entry keeps its
// address_line2 while a later equivalent entry overwrites line 1 with the
// inline form ("100 First St Apt 4"). Consumers that join both fields then
// render "100 First St Apt 4 Apt 4" onto an estimate or a dispatch card. When
// line 1's inline unit is the same unit line 2 already holds, the separated
// form wins and the inline copy is peeled off. A DIFFERENT unit in the two
// fields is bad data, not a duplicate, and is left exactly as captured.
function canonicalizePropertyUnit(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const line1 = String(entry.address_line1 || '').trim();
  const line2 = String(entry.address_line2 || '').trim();
  if (!line1 || !line2) return entry;
  const { normalizeUnitLine, unitLineValueKey, splitStreetLineUnit } = require('./address-normalizer');
  const { street, unit } = splitStreetLineUnit(line1);
  if (!street || !unit) return entry;
  const sameUnit = unitLineValueKey(normalizeUnitLine(unit))
    === unitLineValueKey(normalizeUnitLine(line2));
  return sameUnit ? { ...entry, address_line1: street } : entry;
}

// Union earlier and later property lists, earlier entries first. A later
// mention of the SAME property merges into that entry; a property only an
// earlier call captured is never dropped.
function unionAdditionalProperties(prior, next) {
  const priorList = Array.isArray(prior) ? prior : [];
  const nextList = Array.isArray(next) ? next : [];
  if (!nextList.length) return priorList.length ? priorList : (Array.isArray(next) ? next : priorList);
  const out = priorList.slice();
  for (const entry of nextList) {
    const at = out.findIndex((existing) => sameProperty(existing, entry));
    if (at === -1) {
      out.push(entry);
      continue;
    }
    const existing = out[at];
    out[at] = existing && typeof existing === 'object' && entry && typeof entry === 'object'
      ? canonicalizePropertyUnit(mergeEntryFields(existing, entry))
      : entry;
  }
  return out;
}

// A concern is compared WHOLE, never as a substring. Substring containment
// silently ate real reports: "no termites were observed" contains "termites",
// so a later call reporting termites was treated as a restatement and the
// negation was all that survived — the newly reported pest vanished from the
// information estimating and dispatch work from. Concerns are split on the
// separator this function itself writes and matched as complete normalized
// segments, so only a genuine restatement is dropped.
function concernSegments(text) {
  return String(text || '')
    .split(PAIN_POINTS_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

// Case, spacing and trailing punctuation don't make a concern new.
function concernKey(segment) {
  return String(segment || '')
    .toLowerCase()
    .replace(/[.!;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep the problem the caller first described and add anything genuinely new.
// The field is bounded so a caller who rings ten times cannot grow the column
// without limit.
function accumulatePainPoints(prior, next) {
  const priorText = typeof prior === 'string' ? prior.trim() : '';
  const nextText = typeof next === 'string' ? next.trim() : '';
  if (!nextText) return priorText || null;
  if (!priorText) return nextText;
  const seen = new Set(concernSegments(priorText).map(concernKey));
  // Segment-wise matching is what keeps the merge IDEMPOTENT: the under-lock
  // pass re-merges an already-accumulated payload over the locked row, and
  // every one of its segments is already present.
  const additions = concernSegments(nextText).filter((segment) => {
    const key = concernKey(segment);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!additions.length) return priorText;
  return [priorText, ...additions].join(PAIN_POINTS_SEPARATOR);
}

/**
 * @param {object|string|null} prior   the lead's current extracted_data
 * @param {object} payload             this pass's freshly built payload
 * @param {string[]} recomputedKeys    keys the caller re-derives every pass
 * @returns {object} the merged payload (caller stringifies)
 */
function mergeLeadExtractedData(prior, payload, { recomputedKeys = [] } = {}) {
  const priorData = parseLeadExtractedData(prior);
  const out = { ...priorData };
  // Re-derived every pass: drop the prior value so an absent key means
  // "no longer applies" rather than resurrecting a stale reason.
  for (const key of recomputedKeys) delete out[key];

  for (const [key, value] of Object.entries(payload || {})) {
    // secondary_contact stays latest-wins ON PURPOSE. It is a SINGULAR column
    // that the Leads UI renders as one party, and a later call naming a
    // different person is far more likely to be a correction (the tenant's
    // contact changed, the first was misheard) than a second party to keep.
    // A payload that OMITS it still keeps the stored one — absent keys never
    // clear — so the only thing that replaces it is another explicit answer.
    if (STICKY_ON_KEYS.includes(key)) {
      if (value === true) out[key] = true;
      continue;
    }
    if (key === 'additional_properties') {
      out[key] = unionAdditionalProperties(out[key], value);
      continue;
    }
    if (key === 'pain_points') {
      out[key] = accumulatePainPoints(out[key], value);
      continue;
    }
    if (FILL_FORWARD_KEYS.includes(key)) {
      out[key] = value || out[key] || null;
      continue;
    }
    out[key] = value;
  }
  // Both writers previously emitted these unconditionally; keep the column
  // shape stable so nothing downstream starts seeing the key disappear.
  for (const key of [...FILL_FORWARD_KEYS, 'pain_points']) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = null;
  }
  return out;
}

/**
 * Should this pass replace leads.transcript_summary — the lead card's "Notes",
 * which the office reads to know what the job IS?
 *
 * Latest-wins was the bug: the LAST call always won regardless of content, so
 * a short "did you send it yet?" callback replaced the summary describing the
 * actual work.
 *
 * The rule is deliberately the simplest one that cannot lose information:
 * Notes holds the FULLEST description of the job seen so far. Take the
 * incoming summary when the lead has none, or when it says strictly more than
 * what is already there. Never trade down — not for a contact fill, not for a
 * newly named service, not for a new property.
 *
 * Earlier drafts gated this on "did the pass add a material detail", which
 * fails in both directions: the signal list is never complete (a substantive
 * later call can be missing from it) and any signal on the list becomes a
 * licence for arbitrarily thin text to replace a rich description. Length is a
 * crude proxy for information, but it is monotone, and the facts a signal list
 * was trying to protect are already preserved without it — every material
 * value lives in extracted_data (which this module merges independently of the
 * summary), and each call's own summary is on the lead timeline as an
 * ai_triage activity row.
 *
 * Shared by all three writers of this column so the policy cannot drift.
 */
function shouldRefreshLeadSummary({ currentSummary, newSummary }) {
  const existing = typeof currentSummary === 'string' ? currentSummary.trim() : '';
  const incoming = typeof newSummary === 'string' ? newSummary.trim() : '';
  if (!incoming) return false;
  if (!existing) return true;
  return incoming.length > existing.length;
}

module.exports = {
  mergeLeadExtractedData,
  parseLeadExtractedData,
  shouldRefreshLeadSummary,
  FILL_FORWARD_KEYS,
  STICKY_ON_KEYS,
};
