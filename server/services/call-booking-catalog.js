/**
 * Catalog-anchored resolution for phone-call auto-bookings.
 *
 * The AI call pipeline historically booked appointments from raw LLM text:
 * a coarse service label, no service_id, no price, no duration, and no
 * follow-up visit. These helpers anchor every call booking to the `services`
 * catalog so the facts (price, duration, follow-up interval) come from data,
 * not from the model:
 *
 *   - loadBookableCallServices(conn): the active, booking-enabled catalog.
 *   - resolveCallBookingCatalogService(): extraction/transcript -> catalog row.
 *   - resolveCallBookingPrice(): transcript-quoted price first (what the agent
 *     and caller actually agreed to), catalog list price as fallback.
 *   - resolveCallFollowUpPlan(): a second linked visit when the call
 *     specifically discussed a follow-up treatment.
 *
 * Every function fails open to the legacy behavior (null / empty list) so a
 * catalog problem can never block an otherwise-valid booking.
 */

const logger = require('./logger');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const BOOKABLE_SERVICE_COLUMNS = [
  'id',
  'service_key',
  'name',
  'short_name',
  // Lane-family classification for the re-service override (the prompt block
  // and its extractionPromptVersion hash render NAMES only — an extra column
  // here cannot fragment shadow cohorts).
  'category',
  'billing_type',
  'pricing_type',
  'base_price',
  'default_duration_minutes',
  'requires_follow_up',
  'follow_up_interval_days',
];

// Quoted prices outside these bounds are treated as extraction noise ("3.50",
// a phone number fragment, a lot size) rather than an agreed service price.
const MIN_QUOTED_CALL_PRICE = 20;
const MAX_QUOTED_CALL_PRICE = 20000;

const DEFAULT_FOLLOW_UP_INTERVAL_DAYS = 14;

// "Palmetto bug" callers are American-roach one-offs handled under General
// Pest Control — strip the phrase (in all its wordings: palmetto bug/roach/
// cockroach) so it can't trip the German-roach cleanout rule, which is a
// $350 two-treatment program.
const PALMETTO_BUG_RE = /\bpalmetto\s+(?:bugs?|(?:cock)?roach(?:es)?)\b/gi;
const ROACH_RE = /\b(?:german\s+)?(?:cock)?roach(?:es)?\b/i;
// A roach mention only counts as booking intent when it's affirmative:
// "not roaches, just ants" and "last time it was roaches" describe what the
// visit is NOT for, and must not force the cockroach service (and its catalog
// price) onto a booking for something else. Strip negated mentions (negation
// word + up to four fillers, e.g. "don't currently have any german roaches",
// "don't think we have roaches") and historical-context mentions within the
// same clause, then test what's left — one surviving affirmative mention is
// enough. Fillers must be plain words (punctuation breaks the run, so the
// negation never reaches across a clause boundary) and adversative
// conjunctions are excluded so "don't have ants but roaches are everywhere"
// keeps its affirmative mention.
const NEGATED_ROACH_RE = /\b(?:no|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|haven['’]?t|hasn['’]?t|never|without)\s+(?:(?!(?:but|however|though|except)\b)[\w'’]+\s+){0,4}?(?:german\s+)?(?:cock)?roach(?:es)?\b/gi;
// Historical context can sit on either side of the mention: "last time it was
// roaches" AND "we had roaches last time" — strip both orders.
const HISTORICAL_ROACH_RE = /\b(?:last\s+(?:time|visit|year)|previous(?:ly)?|in\s+the\s+past|used\s+to)\b[^.!?\n]{0,40}?\b(?:german\s+)?(?:cock)?roach(?:es)?\b/gi;
const ROACH_HISTORICAL_RE = /\b(?:german\s+)?(?:cock)?roach(?:es)?\b[^.!?\n]{0,40}?\b(?:last\s+(?:time|visit|year)|previous(?:ly)?|in\s+the\s+past|ago)\b/gi;

function hasAffirmativeRoachMention(text) {
  const cleaned = String(text || '')
    .replace(PALMETTO_BUG_RE, ' ')
    .replace(NEGATED_ROACH_RE, ' ')
    .replace(HISTORICAL_ROACH_RE, ' ')
    .replace(ROACH_HISTORICAL_RE, ' ');
  return ROACH_RE.test(cleaned);
}

// Deterministic transcript-keyword rules, tried only after the model's own
// exact catalog pick. Each maps to a service_key that must exist in the
// loaded catalog (missing/inactive keys are simply skipped), so a rule can
// never book a service the catalog doesn't offer.
// Rodent intent → the right catalog service (owner directive 2026-07-10:
// map coarse rodent calls to real catalog rows by intent, never a made-up
// label). Most-specific first — inspection wins over trapping wins over a
// general rodent call. A rodent mention with no specific action defaults to
// the general "Rodent Pest Control Service".
const RODENT_RE = /\b(rodents?|rats?|mouse|mice)\b/i;
// Rodent mentions get the same affirmative-only treatment as roaches: "not
// rats, it's ants" and "we had mice last time but now need spiders treated"
// describe what the visit is NOT for, and must not anchor the booking to a
// rodent catalog row. Same negation window as NEGATED_ROACH_RE (negation word
// + up to four plain-word fillers, adversative conjunctions excluded so
// "don't have ants but rats are everywhere" keeps its affirmative mention)
// and the same both-order historical strip — EXCEPT the trailing direction:
// "rats showed up two days ago" is a CURRENT problem with an onset time, not
// history, so the noun→"ago" strip refuses to cross an onset verb (showed/
// started/came/…). "We had rats a year ago" has no onset verb between the
// mention and "ago" and still strips.
const RODENT_NOUN = "(?:rodents?|rats?|mouse|mice)";
const RODENT_ONSET_VERBS = "(?:showed|shows?|showing|started|starting|began|begun|appeared|appearing|noticed|spotted|saw|seen|found|heard|moved|came|come|coming|returned|arrived|got|gotten|turned|popped|since)";
// A contrast cue between a history phrase and the rodent noun means the noun
// is the CURRENT problem, not the history: "Last visit we treated ants, now I
// have mice" books mice. The leading-direction strip refuses to cross one.
const RODENT_CONTRAST_CUES = "(?:now|but|today|currently|this\\s+time)";
// The negation consumes COORDINATED nouns too ("no mice or rats", "not rats
// and mice") — without the trailing group, "no mice or rats, just ants"
// strips only "no mice" and the surviving "rats" reads as affirmative.
const NEGATED_RODENT_RE = new RegExp(`\\b(?:no|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|haven['’]?t|hasn['’]?t|never|without)\\s+(?:(?!(?:but|however|though|except)\\b)[\\w'’]+\\s+){0,4}?${RODENT_NOUN}\\b(?:(?:\\s*,\\s*(?:or|and|nor)\\s+|\\s*,\\s*|\\s+(?:or|and|nor)\\s+)${RODENT_NOUN}\\b)*`, 'gi');
const HISTORICAL_RODENT_RE = new RegExp(`\\b(?:last\\s+(?:time|visit|year)|previous(?:ly)?|in\\s+the\\s+past|used\\s+to)\\b(?:(?!\\b${RODENT_CONTRAST_CUES}\\b)[^.!?\\n]){0,40}?${RODENT_NOUN}\\b`, 'gi');
const RODENT_HISTORICAL_RE = new RegExp(`\\b${RODENT_NOUN}\\b(?:(?!\\b${RODENT_ONSET_VERBS}\\b)[^.!?\\n]){0,40}?\\b(?:last\\s+(?:time|visit|year)|previous(?:ly)?|in\\s+the\\s+past|ago)\\b`, 'gi');

function hasAffirmativeRodentMention(text) {
  const cleaned = String(text || '')
    .replace(NEGATED_RODENT_RE, ' ')
    .replace(HISTORICAL_RODENT_RE, ' ')
    .replace(RODENT_HISTORICAL_RE, ' ');
  return RODENT_RE.test(cleaned);
}

// Existing-customer re-service anchoring (owner catalog rule 2026-07-10; miss
// observed 2026-08-05: a quarterly customer's "pest control revisit" booked as
// the generic "Waves Pest Control Appointment Service"). The covered re-service
// rows are booking_enabled=false ON PURPOSE — the reservice self-serve lane
// owns their public eligibility — so they never render in the extraction
// prompt's catalog block and the model structurally cannot pick them. This
// deterministic override is the phone-path equivalent, and it is the LAST
// RESORT before the generic anchors (codex #3222 r1):
//   - eligibility comes in as `reServiceLanes` — the reservice lane's own
//     LIVE plan check (reserviceLanesForCustomer), never completed history,
//     so a lapsed or one-time customer can't talk their way into a free visit;
//   - a specific model pick and the deterministic keyword rules both outrank
//     revisit wording ("rodent inspection re-visit" books the inspection);
//   - the coarse resolver's label must be lane-compatible — a mosquito or
//     termite resolution is a different service, not a covered re-service.
// Bare "retreat" is excluded on purpose — too common as a plain English
// word. "revisit" only counts when the clause ends there or a short chain
// of transparent modifiers/determiners reaches a service/premise/pest
// object (POSITIVE lookahead — codex #3231 r1-r3: a noun blacklist is
// unwinnable, and a temporal modifier alone is never sufficient —
// "revisit next month's pricing" is administrative; "revisit next week
// for the ants" is a treatment ask).
const RE_SERVICE_KEYS = { pest: 'pest_re_service', lawn: 'lawn_re_service' };
const RE_SERVICE_PHRASE = "(?:re[-\\s]?service|re[-\\s]?visit(?=\\s*$|\\s*[.;!?]|\\s*[,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|\\s*[^a-z\\s.;!?,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b)|\\s+(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|revisit(?=\\s*$|\\s*[.;!?]|\\s*[,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|\\s*[^a-z\\s.;!?,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b)|\\s+(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|re[-\\s]treat(?:ment)?|retreatment|spray\\s+again|treat\\s+again|come\\s+back\\s+out)";
const RE_SERVICE_INTENT_RE = new RegExp(`\\b${RE_SERVICE_PHRASE}\\b`, 'i');
// Negated wording ("I don't need a re-service, just my regular visit") is not
// intent (codex #3222 r3) — same shape as NEGATED_ROACH_RE: negation word +
// up to four plain-word fillers; adversative conjunctions break the run so
// "don't want the quarterly but do want a re-service" keeps its affirmative.
const NEGATED_RE_SERVICE_RE = new RegExp(`\\b(?:no|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|haven['’]?t|hasn['’]?t|won['’]?t|wouldn['’]?t|never|without|rather\\s+than|instead\\s+of)\\s+(?:(?!(?:but|however|though|except)\\b)[\\w'’]+\\s+){0,4}?${RE_SERVICE_PHRASE}\\b`, 'gi');

// Historical context is not intent either (codex #3222 r5): "schedule my
// quarterly; last month's re-service worked great" is a PLAN booking that
// merely references a past callback — with recurring plan picks now
// replaceable, an unstripped mention would convert the requested plan visit
// into a free callback. Both orders, same clause window as the roach/rodent
// historical strips.
const RE_SERVICE_HISTORY_CUE = "(?:last\\s+(?:time|visit|week|month|year)|previous(?:ly)?|in\\s+the\\s+past|used\\s+to)";
// A prior-visit cue that MOTIVATES a current request is not history (codex
// #3222 r6): "I need a re-service because the last visit did not work" and
// "last visit missed the lanai, please spray again" are affirmative current
// asks. Both strip windows refuse to cross a causal / complaint / request
// cue — same refusal-window technique as the rodent onset-verb and
// contrast-cue guards.
const RE_SERVICE_HISTORY_BREAK = "(?:because|since|but|now|please|again|missed|skipped|failed|didn['’]?t|doesn['’]?t|wasn['’]?t|not)";
const RE_SERVICE_HISTORY_WINDOW = `(?:(?!\\b${RE_SERVICE_HISTORY_BREAK}\\b)[^.!?\\n]){0,40}?`;
const HISTORICAL_RE_SERVICE_RE = new RegExp(`\\b${RE_SERVICE_HISTORY_CUE}\\b${RE_SERVICE_HISTORY_WINDOW}${RE_SERVICE_PHRASE}\\b`, 'gi');
const RE_SERVICE_HISTORICAL_RE = new RegExp(`\\b${RE_SERVICE_PHRASE}\\b${RE_SERVICE_HISTORY_WINDOW}\\b(?:${RE_SERVICE_HISTORY_CUE}|ago)\\b`, 'gi');

function hasAffirmativeReServiceIntent(text) {
  const cleaned = String(text || '')
    .replace(NEGATED_RE_SERVICE_RE, ' ')
    .replace(HISTORICAL_RE_SERVICE_RE, ' ')
    .replace(RE_SERVICE_HISTORICAL_RE, ' ');
  return RE_SERVICE_INTENT_RE.test(cleaned);
}
const RE_SERVICE_LAWN_CONTEXT_RE = /\b(?:lawn|turf|grass|weeds?|fertili[sz]\w*|chinch|sod)\b/i;
// Lane evidence for the DUAL-eligibility case (codex #3222 r5): with both
// lanes open, the lane must be evidenced by what the caller talked about —
// pest wording or lawn wording, not a default. Neither (or both) present →
// the override declines and the call falls through to the processor's
// Waves Assessment fallback (assess on-site) instead of guessing which free
// service to dispatch.
const RE_SERVICE_PEST_CONTEXT_RE = /\b(?:pests?|bugs?|insects?|ants?|roach(?:es)?|cockroach(?:es)?|spiders?|wasps?|hornets?|fleas?|ticks?|silverfish|earwigs?|millipedes?|centipedes?|scorpions?)\b/i;
const GENERIC_CALL_CATALOG_ROW_RE = /^(?:waves pest control appointment service|waves assessment|waves appointment)$/i;
// Coarse resolveSchedulableCallService labels a lane's re-service may stand in
// for. Anything else ("Mosquito Control", "Termite Inspection", …) means the
// call asked for a DIFFERENT real service and the override must not replace it
// (a null coarse label — noMatch — is compatible with either lane).
const RE_SERVICE_COARSE_COMPATIBLE = {
  pest: new Set(['Waves Appointment', 'General Pest Control']),
  lawn: new Set(['Waves Appointment', 'Lawn Care']),
};

function isGenericCallCatalogRow(row) {
  if (!row) return false;
  return row.service_key === 'general_appointment'
    || GENERIC_CALL_CATALOG_ROW_RE.test(String(row.name || '').trim());
}

function isReServiceCatalogRow(row) {
  return !!row && Object.values(RE_SERVICE_KEYS).includes(row.service_key);
}

function reServiceLaneForRow(row) {
  if (!row) return null;
  if (row.service_key === RE_SERVICE_KEYS.pest) return 'pest';
  if (row.service_key === RE_SERVICE_KEYS.lawn) return 'lawn';
  return null;
}

// Lane family of a RECURRING plan catalog row, via the reservice lane's OWN
// classifier (single source of truth — a second regex here would diverge).
// Lazy require: reservice-scheduler pulls the db module, which this
// otherwise-pure module must not load unless the branch actually runs.
function reServiceLaneForPlanRow(row) {
  if (!row || row.billing_type !== 'recurring') return null;
  const { laneForCoverageRow } = require('./reservice-scheduler');
  return laneForCoverageRow({ category: row.category, serviceType: row.name });
}

function callBookingResolutionHaystack(extracted = {}, transcription = '') {
  return [
    extracted.requested_service,
    extracted.pain_points,
    extracted.call_summary,
    transcription,
  ].filter(Boolean).join(' ');
}

// Intent text = the EXTRACTION's caller-attributed fields ONLY, never the
// raw mixed-speaker transcript (codex #3222 r9): an agent's "is this a
// re-service?" answered "No" would otherwise supply the affirmative phrase.
// The extraction's requested_service/pain_points/call_summary carry the
// model's synthesis of what the CALLER asked for.
function callBookingReServiceIntentText(extracted = {}) {
  return [
    extracted.requested_service,
    extracted.pain_points,
    extracted.call_summary,
  ].filter(Boolean).join(' ');
}

// Cheap pre-gate so the processor only runs the re-service eligibility lookups
// (customer row + live lanes) on revisit-shaped calls.
function hasCallReServiceIntent(extracted = {}) {
  const intentText = callBookingReServiceIntentText(extracted);
  return !!intentText && hasAffirmativeReServiceIntent(intentText);
}

// The two covered re-service rows, loaded OUTSIDE loadBookableCallServices on
// purpose: adding them there would change the prompt's catalog block (and its
// order-sensitive extractionPromptVersion hash) and let the model book a free
// re-service for anyone. Fails open to [] like the bookable load.
async function loadCallReServiceRows(conn) {
  try {
    const rows = await conn('services')
      .where({ is_active: true })
      .whereIn('service_key', Object.values(RE_SERVICE_KEYS))
      .select(BOOKABLE_SERVICE_COLUMNS);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.warn(`[call-booking-catalog] Failed to load re-service rows (revisit calls fall back to generic anchoring): ${err.message}`);
    return [];
  }
}

const KEYWORD_SERVICE_RULES = [
  {
    serviceKey: 'cockroach_control',
    matches: hasAffirmativeRoachMention,
  },
  // "inspection"/"inspect(s)" only — NOT "inspector": "the home inspector
  // found rats, I need trapping" is a trapping call, and the prefix match
  // would book (and price) an inspection before the trapping rule runs.
  { serviceKey: 'rodent_inspection', matches: (h) => hasAffirmativeRodentMention(h) && /\binspect(?:ion)?s?\b/i.test(h) },
  // Trap + seal prefers the dedicated bundle SKU (7% bundle pricing, its own
  // duration); the older rodent_exclusion key is the fallback when the bundle
  // row is absent/inactive (missing keys are skipped, so ordering does this).
  { serviceKey: 'rodent_trapping_exclusion', matches: (h) => hasAffirmativeRodentMention(h) && /\btrap/i.test(h) && /\bexclu|seal/i.test(h) },
  { serviceKey: 'rodent_exclusion', matches: (h) => hasAffirmativeRodentMention(h) && /\btrap/i.test(h) && /\bexclu|seal/i.test(h) },
  { serviceKey: 'rodent_trapping', matches: (h) => hasAffirmativeRodentMention(h) && /\btrap/i.test(h) },
  { serviceKey: 'rodent_exclusion_only', matches: (h) => hasAffirmativeRodentMention(h) && /\bexclu|seal/i.test(h) },
  { serviceKey: 'rodent_general_one_time', matches: (h) => hasAffirmativeRodentMention(h) },
];

async function loadBookableCallServices(conn) {
  try {
    // Stable order matters beyond display: these rows render the prompt's
    // catalog block AND feed extractionPromptVersion's order-sensitive hash,
    // so planner-dependent row order would stamp identical catalogs as
    // different prompt versions and fragment shadow cohorts.
    const rows = await conn('services')
      .where({ is_active: true, booking_enabled: true })
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .select(BOOKABLE_SERVICE_COLUMNS);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.warn(`[call-booking-catalog] Failed to load bookable services (falling back to legacy labels): ${err.message}`);
    return [];
  }
}

function normalizeServiceText(value) {
  return String(value || '').trim().toLowerCase();
}

function findServiceByName(services, value) {
  const text = normalizeServiceText(value);
  if (!text) return null;
  const match = (candidate) => services.find((s) => (
    normalizeServiceText(s.name) === candidate
    || normalizeServiceText(s.short_name) === candidate
    || normalizeServiceText(s.service_key) === candidate
  )) || null;
  // Rename bridging reuses the completion resolver's candidate expansion —
  // append/strip " Service", the paren insert/strip, AND the non-suffix
  // foam aliases — so a pre-migration extraction replayed after the rename
  // ("Drill-and-Foam Termite", "German Roach Initial (3-Visit)") still
  // anchors the renamed rows, and renamed labels anchor restored old-name
  // rows after a rollback (codex #3484 P1; never re-implement this list).
  const { serviceNameCandidates } = require('./service-completion-profiles');
  for (const candidate of serviceNameCandidates(value)) {
    const hit = match(normalizeServiceText(candidate));
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve the specific catalog service for a call booking.
 * Priority: the model's explicit catalog pick (specific_service_name, then
 * matched_service / requested_service when they name a catalog entry exactly),
 * then deterministic keyword rules over the extraction + transcript.
 * Returns a catalog row or null (null -> legacy coarse service label).
 */
function resolveCallBookingCatalogService({
  extracted = {}, transcription = '', services = [],
  reServices = [], reServiceLanes = [], coarseServiceLabel = null,
} = {}) {
  if (!Array.isArray(services) || services.length === 0) return null;

  const byModelPick = findServiceByName(services, extracted.specific_service_name)
    || findServiceByName(services, extracted.matched_service)
    || findServiceByName(services, extracted.requested_service);
  // A SPECIFIC pick is final — except the two shapes the re-service override
  // may replace (both keep their original precedence over the keyword rules
  // when the override misses): the generic anything-rows, and (codex #3222
  // r3) the customer's own lane-family RECURRING plan row — the extractor
  // exact-picks it from the prompt catalog on plan-customer revisit calls,
  // but a revisit is the plan's free between-visits callback, not an extra
  // plan visit.
  const pickPlanLane = reServiceLaneForPlanRow(byModelPick);
  if (byModelPick && !isGenericCallCatalogRow(byModelPick) && !pickPlanLane) return byModelPick;

  const haystack = callBookingResolutionHaystack(extracted, transcription);

  // Computed before the re-service override so a concrete service keyword
  // ("rodent inspection re-visit", "roach re-treatment") anchors the real
  // specialty row, never a free re-service (codex #3222 r1 P2).
  let keywordRow = null;
  if (haystack) {
    for (const rule of KEYWORD_SERVICE_RULES) {
      if (!rule.matches(haystack)) continue;
      const row = services.find((s) => s.service_key === rule.serviceKey);
      if (row) { keywordRow = row; break; }
    }
  }

  // Re-service override (see RE_SERVICE_INTENT_RE block above): AFFIRMATIVE
  // revisit intent from a LANE-ELIGIBLE customer anchors to the covered
  // re-service row. `reServiceLanes` carries the live plan eligibility —
  // lanes with an open callback are NOT pre-filtered (codex r3): the anchor
  // must still resolve so the locked booking transaction can reject the
  // duplicate into hold-for-review or attach to the existing visit, instead
  // of silently booking a second appointment under a generic label. The
  // coarse label must be lane-compatible, and a replaceable plan pick pins
  // the lane to its own family (a pest plan revisit never books the lawn
  // lane).
  const reServiceIntentText = callBookingReServiceIntentText(extracted);
  if (
    !keywordRow
    && reServiceIntentText
    && hasAffirmativeReServiceIntent(reServiceIntentText)
    && Array.isArray(reServiceLanes) && reServiceLanes.length > 0
  ) {
    const coarse = coarseServiceLabel ? String(coarseServiceLabel) : null;
    const candidates = reServiceLanes.filter((lane) => {
      if (pickPlanLane && lane !== pickPlanLane) return false;
      const compat = RE_SERVICE_COARSE_COMPATIBLE[lane];
      return !!compat && (coarse === null || compat.has(coarse));
    });
    if (candidates.length > 0) {
      // Single candidate: eligibility + coarse-compat + plan-pin already
      // narrowed the lane. Dual candidates need lane EVIDENCE from the call
      // — exactly one of pest/lawn wording — or the override declines
      // (codex r5: never guess which free service to dispatch; the
      // processor's Waves Assessment fallback books an assessment instead).
      let lane = null;
      if (candidates.length === 1) {
        lane = candidates[0];
      } else {
        const lawnEvidence = RE_SERVICE_LAWN_CONTEXT_RE.test(haystack);
        const pestEvidence = RE_SERVICE_PEST_CONTEXT_RE.test(haystack);
        if (lawnEvidence !== pestEvidence) lane = lawnEvidence ? 'lawn' : 'pest';
      }
      if (lane && candidates.includes(lane)) {
        const reServiceRow = (Array.isArray(reServices) ? reServices : [])
          .find((s) => s.service_key === RE_SERVICE_KEYS[lane]);
        if (reServiceRow) return reServiceRow;
      }
    }
  }

  // A GENERIC model pick is outranked by a deterministic keyword match
  // (codex #3222 r7): "rodent inspection re-visit" with a
  // Waves-Appointment pick books the inspection, not the generic anything-
  // row. A replaceable lane-family PLAN pick is still a SPECIFIC service the
  // model chose exactly — it keeps its precedence over keyword rules.
  if (byModelPick && !isGenericCallCatalogRow(byModelPick)) return byModelPick;
  return keywordRow || byModelPick || null;
}

function sanitizeQuotedCallPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') {
    n = value;
  } else {
    // Exactly one numeric amount ("$350", "1,350.50"). Multi-amount strings
    // ("50 to 60") are ranges, not an agreed price — digit-stripping would
    // inflate them into 5060.
    const tokens = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
    if (tokens.length !== 1) return null;
    n = Number(tokens[0]);
  }
  if (!Number.isFinite(n)) return null;
  if (n < MIN_QUOTED_CALL_PRICE || n > MAX_QUOTED_CALL_PRICE) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Price for a call booking. Billable prices are one_time-catalog-anchored
 * only:
 *   - A recurring service's rate (quoted or listed) is subscription billing
 *     that runs through the recurring machinery — stamping it as
 *     estimated_price would bill the visit outside that machinery.
 *   - A quote with no catalog match has an unknown billing type; fail open
 *     to the legacy no-price shape.
 *   - The catalog list price backstops a missing quote only when the row is
 *     pricing_type='fixed' — a variable-priced one_time service (termite
 *     liquid, exclusion, …) needs sizing/quote-specific pricing, so its
 *     base_price must never become the invoice amount on its own.
 * A transcript quote on a one_time row wins over the list price: it IS the
 * job-specific price the agent and caller agreed to.
 */
function resolveCallBookingPrice({ quotedPrice, catalogRow } = {}) {
  // A covered re-service is free by definition — a number the extractor
  // caught on the call (the plan rate, a misheard fee) must never become the
  // visit's invoice amount (codex #3222 r2). Same shape the self-serve
  // callback insert uses: no price, and the insert stamps
  // create_invoice_on_complete false.
  if (isReServiceCatalogRow(catalogRow)) {
    return { price: null, source: null };
  }
  if (!catalogRow || catalogRow.billing_type !== 'one_time') {
    return { price: null, source: null };
  }
  const quoted = sanitizeQuotedCallPrice(quotedPrice);
  if (quoted !== null) return { price: quoted, source: 'transcript' };
  const base = Number(catalogRow.base_price);
  if (catalogRow.pricing_type === 'fixed' && Number.isFinite(base) && base > 0) {
    return { price: Math.round(base * 100) / 100, source: 'catalog' };
  }
  return { price: null, source: null };
}

/**
 * Whether the booking should flag create_invoice_on_complete. A priced
 * one-time booking must bill at completion: without the flag the completion
 * auto-invoice skips priced, self-pay, non-WaveGuard visits
 * (GATE_AUTOINVOICE_PRICED_VISITS defaults off) and the job closes
 * uninvoiced. Only for a one_time catalog row — a recurring service's visits
 * bill through the recurring machinery, and a coarse legacy label's billing
 * type is unknown, so flagging either risks double-billing.
 */
function callBookingInvoiceOnComplete({ price, catalogRow } = {}) {
  return price != null && catalogRow?.billing_type === 'one_time';
}

// Visit-2 billing shape, mirroring callBookingInvoiceOnComplete's rule for
// the primary. A priced booking means a one-time package total that covers
// both treatments (resolveCallBookingPrice only prices one_time matches), so
// the child is a $0 "included" visit — job-costing zeroes followup_included
// rows and completion auto-invoice skips them. An UNPRICED booking's second
// visit was never prepaid: it stays billable-neutral exactly like its
// unpriced primary (estimated_price null, NOT included) so the office prices
// it at completion instead of closing real work as a free included visit.
// create_invoice_on_complete is false for both — an included child must
// never invoice, and an unpriced child has no price to invoice.
function callFollowUpBillingShape(price) {
  const included = price != null;
  return {
    estimated_price: included ? 0 : null,
    followup_included: included,
    create_invoice_on_complete: false,
  };
}

// Real-calendar check: "2026-13-40" matches a date-shaped regex but must not
// reach a scheduled_services insert — a rejected child INSERT inside the
// booking transaction would roll back the confirmed primary appointment.
function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, mo, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isValidWindowTime(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/**
 * Follow-up visit plan when the call specifically discussed one (a mention or
 * an agreed follow-up date). Date comes from the transcript when a valid
 * future date was stated, else parent date + the service's catalog interval
 * (default 14 days). Returns { scheduledDate, windowStart } or null.
 */
function resolveCallFollowUpPlan({ extracted = {}, catalogRow = null, parentDate, parentWindowStart } = {}) {
  if (!isValidCalendarDate(parentDate)) return null;

  // A stated date only counts as a mention signal when it parses as a real
  // calendar date AND falls after the initial visit: the V1 normalizer merely
  // trims follow_up_date_time, so the model can emit "two weeks"/"none"
  // garbage, or copy confirmed_start_at into the field — the primary visit's
  // own date is not evidence of a second visit, and without this guard it
  // would book a default-interval follow-up nobody discussed.
  const raw = String(extracted.follow_up_date_time || '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  const statedFutureDate = !!(m && isValidCalendarDate(m[1]) && m[1] > parentDate);
  const mentioned = extracted.follow_up_visit_mentioned === true || statedFutureDate;
  if (!mentioned) return null;

  let scheduledDate = null;
  let windowStart = null;
  if (statedFutureDate) {
    scheduledDate = m[1];
    windowStart = m[2] && isValidWindowTime(m[2]) ? m[2] : null;
  }

  if (!scheduledDate) {
    const configured = Number(catalogRow?.follow_up_interval_days);
    const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FOLLOW_UP_INTERVAL_DAYS;
    // parentDate is an ET wall-clock calendar date; the server runs UTC, so
    // day math goes through the ET helpers (noon anchor clears DST seams).
    const base = parseETDateTime(`${parentDate}T12:00`);
    if (Number.isNaN(base.getTime())) return null;
    scheduledDate = etDateString(addETDays(base, days));
  }

  const finalWindowStart = windowStart || parentWindowStart || '09:00';
  return { scheduledDate, windowStart: isValidWindowTime(finalWindowStart) ? finalWindowStart : '09:00' };
}

// scheduled_date is a pg `date` column → Knex hydrates it as a JS Date at
// LOCAL midnight; local getters recover the calendar date regardless of
// process TZ (toISOString risks an off-by-one through the tz cast).
function callBookingDateOnly(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (value == null) return null;
  const s = String(value).split('T')[0];
  return isValidCalendarDate(s) ? s : null;
}

// A call-created follow-up (visit 2) is anchored an interval after its
// parent: when the primary moves — via the rebooker OR a direct admin
// schedule edit — shift the still-pending, never-confirmed child by the
// same delta so the package keeps its spacing. Narrow filter
// (source_action) leaves every other parent-linked flow untouched.
// Callers invoke this best-effort outside their transaction: a failed
// shift leaves the child where it was, and dispatch confirms follow-up
// dates with the customer before dispatch anyway.
const pendingCallFollowUpFilter = (parentServiceId) => ({
  parent_service_id: parentServiceId,
  source_action: 'ai_call_pipeline_followup',
  status: 'pending',
  customer_confirmed: false,
});

// The still-pending, never-confirmed call-created children of a parent and
// the day each lands on after the parent's delta — what the shift writes
// from, and the destination days a caller that runs the shift INSIDE its
// own transaction must cover with rung-1 date-occupancy locks up front,
// before any row lock (scheduling/occupancy.js ORDERING CONTRACT). [] when
// nothing is to shift (no parent, bad dates, same date).
async function planCallFollowUpShift({ conn, parentServiceId, fromDate, toDate }) {
  const fromStr = callBookingDateOnly(fromDate);
  const toStr = callBookingDateOnly(toDate);
  if (!parentServiceId || !fromStr || !toStr || fromStr === toStr) return [];
  return conn('scheduled_services')
    .where(pendingCallFollowUpFilter(parentServiceId))
    .select('id', 'technician_id', 'window_start', 'window_end', 'estimated_duration_minutes',
      conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"),
      conn.raw("to_char(scheduled_date + (?::date - ?::date), 'YYYY-MM-DD') as new_day", [toStr, fromStr]));
}

// The block a child occupies on its destination day, for the canonical
// occupancy probe: stored end, else start + duration (60 default), null
// when the block would cross midnight (then nothing is probed — the child
// is skipped like a clash: never written onto an unprobed slot).
function followUpProbeEnd(windowStart, windowEnd, estimatedDurationMinutes) {
  if (windowEnd) return String(windowEnd).slice(0, 5);
  const m = String(windowStart || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dur = Number(estimatedDurationMinutes) > 0 ? Number(estimatedDurationMinutes) : 60;
  const endMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + dur;
  if (endMin > 23 * 60 + 59) return null;
  return `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
}

// options.occupancyHeld: the caller already holds rung-1 date-occupancy
// locks for every destination day (a series move locks its whole date set
// up front, BEFORE its row locks — taking them here would invert the
// order). Otherwise the shift takes them itself at the start of its own
// transaction. options.report (optional out-param): { skipped: [{ id, day,
// newDay }] } — children whose destination slot is already booked; they
// keep their date (best-effort contract) instead of being written onto an
// occupied slot (AGENTS.md booking conflict-check rule; hook r20 P1).
async function shiftCallFollowUpsForParentMove({ conn, parentServiceId, fromDate, toDate, occupancyHeld = false, report = null }) {
  const fromStr = callBookingDateOnly(fromDate);
  const toStr = callBookingDateOnly(toDate);
  if (!parentServiceId || !fromStr || !toStr || fromStr === toStr) return 0;
  const filter = pendingCallFollowUpFilter(parentServiceId);
  // Tech-day membership fence + route_order clear (uncapped audit r26 P1):
  // a date shift moves the child between tech-days, so it must hold the
  // same 'slot-reserve' fence every other date/tech writer holds — an
  // unfenced shift can land a stop into a day AFTER the nightly reorder's
  // membership read, and its carried sequence number would interleave into
  // the new day's run. Every matched row changes day (delta is non-zero by
  // the guard above), so clearing route_order is correct for all of them.
  const run = async (trx) => {
    const kids = await planCallFollowUpShift({ conn: trx, parentServiceId, fromDate, toDate });
    if (!kids.length) return 0;
    const { acquireOccupancyLocks, findConflictingVisits } = require('./scheduling/occupancy');
    // Rung 1 for every destination day, before the tech-day fence (rung 3)
    // and every row lock below.
    if (!occupancyHeld) await acquireOccupancyLocks(trx, [...new Set(kids.map((k) => k.new_day))]);
    const { lockTechDays } = require('./scheduling/tech-day-lock');
    await lockTechDays(trx, kids.flatMap((k) => [
      { techId: k.technician_id, date: k.day },
      { techId: k.technician_id, date: k.new_day },
    ]));
    // Each write is keyed to the day OBSERVED before the lock (uncapped
    // audit r28 P1): a reschedule that committed while we waited for the
    // fence has already moved the child — shifting the NEWER date would
    // double-move it into tech-days this transaction never locked. A day
    // mismatch skips that child (best-effort contract: it stays where the
    // newer writer put it).
    let shifted = 0;
    for (const k of kids) {
      // Canonical occupancy check on the destination block (a windowless
      // child occupies nothing and is not probed): a clash — or a block
      // that cannot be probed — means the child is NOT written onto that
      // slot; it keeps its date and is reported.
      if (k.window_start) {
        const probeEnd = followUpProbeEnd(k.window_start, k.window_end, k.estimated_duration_minutes);
        const clash = probeEnd
          ? await findConflictingVisits({
            db: trx,
            date: k.new_day,
            windowStart: String(k.window_start).slice(0, 5),
            windowEnd: probeEnd,
            excludeServiceIds: [String(k.id)],
            excludeStatuses: ['completed', 'cancelled'],
          })
          : [{ unprobed: true }];
        if (clash.length) {
          if (report && typeof report === 'object') (report.skipped = report.skipped || []).push({ id: k.id, day: k.day, newDay: k.new_day });
          continue;
        }
      }
      shifted += await trx('scheduled_services')
        .where({ id: k.id })
        .where(filter)
        .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [k.day])
        .update({
          scheduled_date: trx.raw('scheduled_date + (?::date - ?::date)', [toStr, fromStr]),
          route_order: null,
          updated_at: trx.fn.now(),
        });
    }
    return shifted;
  };
  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

// A call-created follow-up (visit 2) is part of the same package as its
// parent: cancelling the primary — via track-transitions, the admin bulk
// action, or the admin status route — must pull the still-pending,
// never-confirmed child off the schedule too, or dispatch would keep a
// follow-up for a cancelled booking. Each child's status change goes
// through transitionJobStatus — the sole scheduled_services.status writer
// (atomic status update + job_status_history audit row + dispatch
// broadcast) — with the tracking columns updated on the SAME trx.
// transitioned_by stays null (the column FKs technicians; the actor is
// carried by the notes). Narrow filter (source_action) keeps every other
// parent-linked flow untouched. Best-effort per child, and callers invoke
// this after their own parent-cancel commits — a cascade failure must
// never fail the parent cancel.
async function cancelCallFollowUpsForParentCancel({ conn, parentServiceId }) {
  if (!parentServiceId) return 0;
  const { transitionJobStatus } = require('./job-status');
  const now = new Date();
  const children = await conn('scheduled_services')
    .where({
      parent_service_id: parentServiceId,
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
      customer_confirmed: false,
    })
    .select('id');
  let cancelled = 0;
  for (const child of children) {
    try {
      await conn.transaction(async (trx) => {
        await transitionJobStatus({
          jobId: child.id,
          fromStatus: 'pending',
          toStatus: 'cancelled',
          transitionedBy: null,
          notes: `Cancelled with parent call booking ${parentServiceId}`,
          trx,
        });
        await trx('scheduled_services')
          .where({ id: child.id })
          .update({
            track_state: 'cancelled',
            cancelled_at: now,
            cancellation_reason: 'parent_call_booking_cancelled',
            updated_at: now,
          });
      });
      cancelled += 1;
      logger.info(`[call-booking] cancelled call-created follow-up ${child.id} with parent ${parentServiceId}`);
    } catch (childErr) {
      logger.error(`[call-booking] call follow-up cancel cascade failed for child ${child.id} of ${parentServiceId}: ${childErr.message}`);
    }
  }
  return cancelled;
}

module.exports = {
  loadBookableCallServices,
  loadCallReServiceRows,
  hasCallReServiceIntent,
  isReServiceCatalogRow,
  reServiceLaneForRow,
  reServiceLaneForPlanRow,
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  resolveCallFollowUpPlan,
  callBookingInvoiceOnComplete,
  callFollowUpBillingShape,
  callBookingDateOnly,
  sanitizeQuotedCallPrice,
  shiftCallFollowUpsForParentMove,
  planCallFollowUpShift,
  cancelCallFollowUpsForParentCancel,
  DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
};
