const { recurringDispatchDuePatch } = require('./scheduling/recurring-dispatch-due');
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
 *     specifically discussed a follow-up treatment (never for a rodent
 *     service: its trap check is booked after the visit).
 *
 * Every function fails open to the legacy behavior (null / empty list) so a
 * catalog problem can never block an otherwise-valid booking.
 */

const logger = require('./logger');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');
const { recurringIntentEvidence, callerOnlyText } = require('./call-cadence-intent');

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
//     revisit wording ("rodent inspection re-visit" books the inspection) —
//     EXCEPT the plan-covered pest one-time rows (PLAN_COVERED_PEST_ONE_TIME_KEYS
//     below): a roach pick or roach wording from a customer with a live pest
//     lane is the plan's free re-service, not a new paid job;
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
// Plan-covered pest one-time rows (owner ruling 2026-11-02, call 534ea913): the
// Quarterly Pest Control plan targets roaches, ants, spiders, silverfish and
// occasional invaders, so a plan customer who asks for a re-service while the
// call names one of these pests gets the free Pest Control Re-Service, not a
// paid one-time row plus its package follow-up visit. Only these two keys:
// rodent rows and German Roach Cleanout stay paid specialty work. Eligibility
// is still the live pest lane (reServiceLanes) — with no live pest lane the
// paid row books as before.
const PLAN_COVERED_PEST_ONE_TIME_KEYS = new Set(['cockroach_control', 'one_time_pest_control']);
// Plan-covered lawn one-time row (owner 2026-11-27, call 12647dd6): active
// recurring lawn customers calling for a between-visits callback/follow-up
// (fungicide, breakthrough weeds, chinch bugs) get Lawn Care Re-Service, not
// a paid One-Time Lawn Care row. Specialty lawn add-ons (plugging, dethatching,
// top dressing, soil test, area addons) stay paid work.
const PLAN_COVERED_LAWN_ONE_TIME_KEYS = new Set(['lawn_care_one_time']);
// German roach words come from the species catalog's high-risk indoor roach
// subgroup: every common name and alias word that is not a generic roach word,
// plus the scientific species epithet ("german", "germanica"). "croton" (the
// "croton bug" nickname) is added because the catalog does not list it. Any
// of them anywhere in the call text, negated or not, keeps the paid row (codex
// #7480 r2-r5). The check only runs once the call already resolved to a roach
// row (pick or keyword), so a stray or negated word can only keep a paid
// booking paid, which is what every roach call did before this exception.
const GENERIC_ROACH_WORDS = new Set(['cockroach', 'cockroaches', 'roach', 'roaches', 'bug', 'bugs']);
let germanRoachRe = null;
function highRiskRoachRe() {
  if (germanRoachRe) return germanRoachRe;
  const words = new Set(['german', 'germanica', 'croton']);
  try {
    const entries = require('./species-catalog').listEntries({ subgroup: 'high-risk-indoor-roaches' });
    const names = entries.flatMap((e) => [e.common_name, ...(e.aliases || [])]);
    names.flatMap((name) => String(name || '').toLowerCase().split(/[^a-z]+/))
      .filter((w) => w && !GENERIC_ROACH_WORDS.has(w))
      .forEach((w) => words.add(w));
    entries.map((e) => String(e.scientific_name || '').toLowerCase().split(/\s+/)[1])
      .filter(Boolean)
      .forEach((w) => words.add(w));
  } catch (err) {
    logger.warn(`[call-booking-catalog] species catalog unreadable (German roach words fall back to the built-in list): ${err.message}`);
  }
  germanRoachRe = new RegExp(`\\b(?:${[...words].join('|')})\\b`, 'i');
  return germanRoachRe;
}

function isPlanCoveredPestRow(row) {
  return !!row && PLAN_COVERED_PEST_ONE_TIME_KEYS.has(row.service_key);
}

function isPlanCoveredLawnRow(row) {
  return !!row && PLAN_COVERED_LAWN_ONE_TIME_KEYS.has(row.service_key);
}

// German roach stays a paid specialty cleanout even for a plan customer, so an
// affirmative German-roach mention switches the plan-covered exception off.
function mentionsGermanRoach(haystack) {
  return highRiskRoachRe().test(String(haystack || ''));
}

// A keyword match anchors the real paid row UNLESS every matched row is a
// plan-covered pest row (and no German roach): then the re-service override
// may still run, and if it declines the keyword row stands as before. That
// override is pest work, so it runs toward the pest lane only (codex #7480
// r1): a pick pinned to another lane (a lawn plan row) keeps the block.
function keywordRowsBlockReService(keywordRows, haystack, pickPlanLane, agreedPrice = false) {
  if (keywordRows.length === 0) return false;
  return (!pickPlanLane && agreedPrice)
    || keywordRows.some((row) => !isPlanCoveredPestRow(row))
    || mentionsGermanRoach(haystack)
    || (!!pickPlanLane && pickPlanLane !== 'pest');
}

// The re-service override behind the keyword gate: a blocking keyword row
// keeps the paid row; plan-covered roach wording with no pick pins the pest lane
// unless the call agreed on a one-time visit price.
function keywordGatedReServiceRow({ keywordRows, pickPlanLane, ...overrideArgs }) {
  const agreedPrice = agreedOneTimeVisitPrice(overrideArgs.extracted, overrideArgs.v2Extraction) !== null;
  if (keywordRowsBlockReService(keywordRows, overrideArgs.haystack, pickPlanLane, agreedPrice)) return null;
  return reServiceOverrideRow({ ...overrideArgs, pickPlanLane: pickPlanLane || (keywordRows.length > 0 ? 'pest' : null) });
}
const RE_SERVICE_PHRASE = "(?:re[-\\s]?service|re[-\\s]?visit(?=\\s*$|\\s*[.;!?]|\\s*[,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|\\s*[^a-z\\s.;!?,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b)|\\s+(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|revisit(?=\\s*$|\\s*[.;!?]|\\s*[,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|\\s*[^a-z\\s.;!?,:—–-]\\s*(?:$|(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b)|\\s+(?:(?:the|my|our|your|this|that|its?|them|next|coming|after|before|between|on|in|at|for|early|late|later|week|weeks|month|months|morning|afternoon|evening)\\b\\s+){0,4}(?:(?:service|visit|treatment|treatments|appointment|spray|spraying|house|home|property|yard|lawn|garden|kitchen|bathroom|bedroom|garage|attic|lanai|patio|pool|cage|inside|outside|interior|exterior|front|back|ants?|roach(?:es)?|cockroach(?:es)?|bugs?|pests?|spiders?|wasps?|hornets?|fleas?|ticks?|mosquito(?:e?s)?|rodents?|rats?|mice|weeds?|soon|asap|today|tomorrow|again|us|me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|noon|midday)\\b|(?:(?:at|on|by|until|around)\\s+(?:the\\s+)?[0-9]{1,4}(?:st|nd|rd|th)?\\b|[0-9]{1,2}(?::[0-9]{2})?\\s*(?:am|pm|a\\.m|p\\.m)\\b)))|re[-\\s]treat(?:ment)?|retreatment|spray\\s+again|treat\\s+again|come\\s+back\\s+out|callback\\s+(?:treatment|visit|service))";
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
const RE_SERVICE_LAWN_CONTEXT_RE = /\b(?:lawn|turf|grass|weeds?|fertili[sz]\w*|chinch|sod|fung(?:us|al|icide)|irrigation)\b/i;
// Lane evidence for the DUAL-eligibility case (codex #3222 r5): with both
// lanes open, the lane must be evidenced by what the caller talked about —
// pest wording or lawn wording, not a default. Neither (or both) present →
// the override declines and the call falls through to the processor's
// Waves Assessment fallback (assess on-site) instead of guessing which free
// service to dispatch.
const RE_SERVICE_PEST_CONTEXT_RE = /\b(?:pests?|bugs?|insects?|ants?|roach(?:es)?|cockroach(?:es)?|spiders?|wasps?|hornets?|fleas?|ticks?|silverfish|earwigs?|millipedes?|centipedes?|scorpions?)\b/i;
// Strip the company greeting/name before reading lane evidence: every call
// transcript starts with "Waves Pest Control", which would otherwise match
// RE_SERVICE_PEST_CONTEXT_RE (\bpests?\b) and supply fake pest evidence on a
// neutral or V2-identified lawn callback.
const BRAND_NAME_FOR_LANE_RE = /\bwaves[,\s]+pest(?:\s+control)?(?:\s*(?:&|and)\s*lawn(?:\s+care)?)?\b/gi;
const GENERIC_CALL_CATALOG_ROW_RE = /^(?:waves pest control appointment service|waves appointment)$/i;
// Coarse resolveSchedulableCallService labels a lane's re-service may stand in
// for. Anything else ("Mosquito Control", "Termite Inspection", …) means the
// call asked for a DIFFERENT real service and the override must not replace it
// (a null coarse label — noMatch — is compatible with either lane).
const RE_SERVICE_COARSE_COMPATIBLE = {
  pest: new Set(['Waves Appointment', 'General Pest Control']),
  lawn: new Set(['Waves Appointment', 'Lawn Care']),
};

// Generic = a pick the re-service override may replace. The Waves Assessment
// is generic here by its canonical identity (key or name), so a renamed
// label stays replaceable; keyword rules still never replace it (see the
// resolver's last step).
function isGenericCallCatalogRow(row) {
  if (!row) return false;
  return row.service_key === 'general_appointment'
    || GENERIC_CALL_CATALOG_ROW_RE.test(String(row.name || '').trim())
    || isAssessmentCatalogRow(row);
}

// The canonical assessment identity (stable lawn_inspection key OR display
// name). Lazy require: assessment-booking loads the db module, which this
// otherwise-pure module must not load at import.
function isAssessmentCatalogRow(row) {
  return require('./assessment-booking').isAssessmentServiceRow(row);
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

// Structured V2 existing-customer service follow-up / callback intent (owner
// 2026-11-27, call 12647dd6): existing recurring customers rarely say the
// literal word "re-service" — they call about a lawn fungicide follow-up or
// breakthrough bugs after a recent treatment, and V2 classifies the call as
// `existing_customer_service` + `follow_up_existing_service` (or
// `complaint_or_callback`). Scoped tightly so:
//   - only the two covered re-service families qualify (never termite,
//     mosquito, rodent, tree/shrub, bed bug, etc.);
//   - calls with a distinct secondary category decline (never guess lane);
//   - `existing_customer_scheduling` + `follow_up_existing_service` stays out
//     of this rule so missed-visit make-up moves (call-reschedule-apply.js)
//     and regular-visit scheduling are untouched;
//   - any agreed/quoted price keeps the booking paid;
//   - explicit negation ("don't need a re-service") or an explicit regular
//     plan booking ("schedule my regular quarterly visit") always wins.
const STRUCTURED_RE_SERVICE_CATEGORY_LANE = Object.freeze({
  lawn_care: 'lawn',
  pest_general: 'pest',
  bundled_waveguard: 'either',
});
const EXISTING_SERVICE_FOLLOWUP_INTENTS = new Set(['follow_up_existing_service', 'complaint_or_callback']);
const REGULAR_PLAN_VISIT_PHRASE = "(?:(?:my|our|the|their|a|her|his)\\s+)?(?:regular|routine|normal|next|scheduled)\\s+(?:(?:quarterly|monthly|bi[-\\s]?monthly|6[-\\s]?week|every\\s+6\\s+weeks?|pest(?:\\s+control)?|lawn(?:\\s+care)?)\\s+){0,2}(?:visit|service|treatment|appointment)";
const REGULAR_PLAN_VISIT_RE = new RegExp(`\\b(?:book(?:ed|ing)?|schedul(?:e|ed|ing)|set(?:ting)?\\s+up|confirm(?:ed|ing)?|just\\s+(?:want|need)(?:ed|ing)?)\\s+${REGULAR_PLAN_VISIT_PHRASE}\\b`, 'i');
const NEGATED_REGULAR_PLAN_VISIT_RE = new RegExp(`\\b(?:no|not|don['’]?t|doesn['’]?t|didn['’]?t|won['’]?t|never|rather\\s+than|instead\\s+of|already|previously)\\s+(?:[\\w'’]+\\s+){0,3}(?:book(?:ed|ing)?|schedul(?:e|ed|ing)|set(?:ting)?\\s+up|confirm(?:ed|ing)?|want(?:ed|ing)?|need(?:ed|ing)?)\\s+${REGULAR_PLAN_VISIT_PHRASE}\\b`, 'gi');
const HISTORICAL_REGULAR_PLAN_VISIT_RE = new RegExp(`\\b(?:book(?:ed)?|scheduled|set\\s+up|confirmed)\\s+${REGULAR_PLAN_VISIT_PHRASE}\\b[^.!?\\n]{0,30}\\b(?:last\\s+(?:time|visit|week|month|year)|yesterday|earlier|before|ago)\\b`, 'gi');
// Recurring cadence units only (matches call-commercial-dictated-booking.js:
// per_application is a valid per-visit price unit on one-time jobs unless tied
// to a WaveGuard tier or annual prepay plan).
const RECURRING_V2_PRICE_UNITS = new Set(['per_month', 'per_quarter', 'per_year']);
const REJECTED_V2_PRICE_RESPONSES = new Set(['declined', 'no_response', 'not_at_issue']);
const PRICE_HEDGE_OR_ADDON_RE = /\b(?:varies|vary|depend(?:s|ing)?|before|plus\s+(?:a|any|\$|tax|\d)|extra|additional|on\s+top\s+of|starting\s+at|at\s+least|estimate\s+only|up\s+to|more\s+if|trip\s+fee|probably|maybe|might\s+be|could\s+be|looking\s+at|ballpark|guess(?:ing)?|roughly|approximately|optional|if\s+you\s+(?:want|need|decide)|instead|or\s+(?:the|a)\s+(?:treatment|plan))\b|\b(?:like|around|about)\s+\$?\d/i;
const PACKAGE_DISCOUNT_SINGLE_RATIO = 0.75;
const NEGATED_TWO_VISIT_RE = /\b(?:no|not|without|skip(?:ping)?|don['’]?t\s+(?:want|need)|never)\s+(?:a\s+|the\s+|any\s+)?(?:second|two|2)[-\s]?(?:visits?|treatments?|times?|package)\b/gi;
const TWO_VISIT_EXPLICIT_RE = /\b(?:two|2)\s*[-\s]?(?:visits?|treatments?|times?)\b|\bsecond\s+(?:visit|treatment)\b|\b(?:two[-\s]?treatment|2[-\s]?treatment)\s+package\b/i;
const FOLLOWUP_OMITTED_RE = /\b(?:no\s+(?:follow[-\s]?up|second\s+visit|return\s+visit)|without\s+(?:a\s+|the\s+)?(?:follow[-\s]?up|second\s+visit|return\s+visit)|skip(?:ping)?\s+(?:the\s+)?(?:follow[-\s]?up|second\s+visit)|not\s+(?:a|the)\s+(?:two[-\s]?(?:visit|treatment)|package)|just\s+(?:the\s+|this\s+|a\s+)?(?:one|single)\s+(?:\$\d[\d,.]*\s+)?(?:visit|treatment)|(?:a|one)\s+single\s+(?:\$\d[\d,.]*\s+)?(?:treatment|visit)|single\s+(?:\$\d[\d,.]*\s+)?(?:treatment|visit)\s+only|one[-\s]?time\s+only)\b/i;
const SINGLE_TREATMENT_EXPLICIT_RE = /\b(?:single\s+(?:\$\d[\d,.]*\s+)?(?:treatment|visit)|just\s+(?:a\s+)?single\s+(?:treatment|visit))\b/i;
const NEGATED_SINGLE_TREATMENT_RE = /\b(?:not|isn['’]?t|won['’]?t\s+be)\s+(?:just\s+)?(?:a\s+)?(?:one[-\s]?time|single\s+(?:visit|treatment))\b/i;
const WDO_CLAUSE_REFUSAL_RE = /\b(?:(?:don['’]?t|do\s+not|didn['’]?t|did\s+not|doesn['’]?t|does\s+not|won['’]?t|will\s+not)\s+(?:want|need|require|get|do|order|book|schedule)|declin(?:e[ds]?|ing)|refus(?:e[ds]?|ing)|skip(?:p(?:ed|ing))?|without|rather\s+not|instead\s+of|no\s+need\s+for|not\s+looking\s+for|no|not)\s+(?:(?:a|an|the|any|official|formal|fdacs)\s+){0,3}(?:wdo(?:\s+(?:inspection|report|form|letter|clearance|paperwork|certificate|service))?|termite\s+(?:letter|clearance(?:\s+letter)?|report|form)|wood[- ]destroying[- ]organism\s+(?:inspection|report|form|letter))\b/i;
const WDO_CLAUSE_AFFIRM_RE = /\b(?:need|want|would\s+like|require[sd]?|book|schedule|order(?:ing)?|get(?:ting)?|do(?:ing)?)\s+(?:(?:a|an|the|any|official|formal|fdacs)\s+){0,3}(?:wdo(?:\s+(?:inspection|report|form|letter|clearance|certificate))?|termite\s+(?:letter|clearance(?:\s+letter)?))\b/i;
const ONE_TIME_ONLY_INTENT_RE = /\b(?:(?:just|only)\s+(?:want(?:ed)?|need(?:ed)?|looking\s+for|do(?:ing)?)?\s*(?:a|the|this)?\s*one[- ]?time(?:\s+(?:treatment|service|visit|spray|job))?|one[- ]?time\s+(?:only|treatment|service|visit)|(?:just|only)\s+once|no\s+(?:ongoing|recurring|monthly|quarterly|plan|package|membership)|(?:don['’]?t|do\s+not|not)\s+(?:want(?:ing)?|need(?:ing)?|looking\s+for|interested\s+in)\s+(?:a\s+|an\s+)?(?:ongoing|recurring|monthly|quarterly|plan|package|membership|subscription))\b/i;

function v2PriceEntries(v2Extraction) {
  const sr = v2Extraction?.service_request;
  if (!sr) return [];
  return [sr.price, ...(Array.isArray(sr.prices) ? sr.prices : [])].filter(Boolean);
}

function isAcceptedV2Price(entry) {
  return Boolean(entry && (entry.caller_response
    ? entry.caller_response === 'accepted'
    : entry.accepted === true));
}

function isRejectedV2Price(entry) {
  return Boolean(entry && (REJECTED_V2_PRICE_RESPONSES.has(entry.caller_response) || entry.accepted === false));
}

function isPlanRateV2Price(entry) {
  return Boolean(entry && (
    RECURRING_V2_PRICE_UNITS.has(entry.unit)
    || Boolean(entry.tier_mentioned)
    || entry.prepay_term === 'annual'
  ));
}

function v2StructuredPriceEntries(sr) {
  if (!sr || typeof sr !== 'object') return [];
  const rawList = Array.isArray(sr.prices) && sr.prices.length ? sr.prices : [sr.price];
  return rawList.filter((e) => e && typeof e === 'object' && (e.amount_usd != null || e.amount_max_usd != null));
}

function hasMultipleServicesOrProperties(v2Extraction) {
  const sr = v2Extraction?.service_request;
  if (Array.isArray(sr?.secondary_categories) && sr.secondary_categories.length > 0) return true;
  if (Array.isArray(sr?.prices) && sr.prices.length > 1) return true;
  return Array.isArray(v2Extraction?.property?.additional_properties) && v2Extraction.property.additional_properties.length > 0;
}

function normalizeCatalogLookupKey(label) {
  return String(label || '').trim().toLowerCase().replace(/\s+service$/, '');
}

function priceMatchesBookedCatalogRow(sr, catalogRow) {
  if (!catalogRow || !sr?.specific_service_name) return false;
  const reqNorm = normalizeCatalogLookupKey(sr.specific_service_name);
  const rowKeys = [catalogRow.name, catalogRow.short_name, catalogRow.service_key].filter(Boolean);
  return rowKeys.some((k) => normalizeCatalogLookupKey(k) === reqNorm);
}

function isEligibleImplicitPriceContext(v2Extraction, catalogRow = null) {
  const sr = v2Extraction?.service_request;
  if (!sr || typeof sr !== 'object') return false;
  if (v2Extraction?.scheduling?.status !== 'confirmed') return false;
  if (sr.price_is_final !== true || sr.price_offered_by_staff !== true) return false;
  if (hasMultipleServicesOrProperties(v2Extraction)) return false;
  if (!priceMatchesBookedCatalogRow(sr, catalogRow)) return false;
  return sr.service_intent !== 'recurring_membership_inquiry'
    && !sr.billing_choice
    && !sr.waveguard_tier_mentioned;
}

function evidenceSupportsImplicitAmount(quote, amount) {
  const numericMatches = [
    ...quote.matchAll(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g),
    ...quote.matchAll(/\b(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:dollars?|bucks)\b/gi),
  ];
  const rawNums = numericMatches.length > 0
    ? numericMatches.map((m) => Number(String(m[1]).replace(/,/g, '')))
    : [...quote.matchAll(/\b(\d{2,5}(?:\.\d{1,2})?)\b/g)].map((m) => Number(m[1]));
  const finiteNums = rawNums.filter((n) => Number.isFinite(n));
  if (finiteNums.length === 0) return false;
  return finiteNums.every((n) => Math.abs(n - amount) < 0.01);
}

function isUnhedgedNoResponseAgentQuote(entry) {
  if (!entry || entry.stated_by !== 'agent' || entry.unit === 'per_application' || isPlanRateV2Price(entry)) {
    return false;
  }
  if (entry.amount_max_usd != null || entry.caller_response !== 'no_response') return false;
  const amount = sanitizeQuotedCallPrice(entry.amount_usd);
  if (amount === null) return false;
  const quote = String(entry.evidence_quote || '').trim();
  return quote.length > 0 && !PRICE_HEDGE_OR_ADDON_RE.test(quote) && evidenceSupportsImplicitAmount(quote, amount);
}

// When the agent quotes ONE firm, final, unhedged dollar amount tied to the
// booked service on a confirmed booking and the caller confirms the slot without
// a verbal price "yes", count it as agreed rather than blanking estimated_price.
function implicitConfirmedAgentPrice(v2Extraction = null, catalogRow = null) {
  if (!isEligibleImplicitPriceContext(v2Extraction, catalogRow)) return null;
  const entries = v2StructuredPriceEntries(v2Extraction.service_request);
  const entry = entries.length === 1 ? entries[0] : null;
  if (!isUnhedgedNoResponseAgentQuote(entry)) return null;
  const amount = sanitizeQuotedCallPrice(entry.amount_usd);
  return amount === null ? null : { status: 'agreed', amount };
}

// Classify the booked service's quoted total under V2 evidence:
//   - 'none': no quoted total on the call;
//   - 'agreed': final, accepted per-visit price (usable for selection & billing);
//   - 'plan_rate': recurring/tier/annual plan rate echoed into quoted_price_usd
//     (does not block covered callbacks and is not billed as a one-time quote);
//   - 'disputed': caller declined or price is non-final (never silently bill
//     either the disputed number OR a higher fixed catalog list price).
function classifyOneTimeVisitPrice(extracted = {}, v2Extraction = null, catalogRow = null) {
  const sr = v2Extraction?.service_request;
  const scalar = sanitizeQuotedCallPrice(sr?.quoted_price_usd)
    ?? sanitizeQuotedCallPrice(extracted?.quoted_price);
  if (scalar === null) {
    return implicitConfirmedAgentPrice(v2Extraction, catalogRow) || { status: 'none', amount: null };
  }
  if (sr?.price_accepted_by_caller === false || sr?.price_is_final === false) {
    return { status: 'disputed', amount: null };
  }
  const matching = v2PriceEntries(v2Extraction).filter((e) => sanitizeQuotedCallPrice(e.amount_usd) === scalar);
  if (matching.length === 0) return { status: 'agreed', amount: scalar };
  const accepted = matching.filter(isAcceptedV2Price);
  const usable = accepted.length > 0 ? accepted : matching.filter((e) => !isRejectedV2Price(e));
  if (usable.length === 0) return { status: 'disputed', amount: null };
  if (usable.every(isPlanRateV2Price)) return { status: 'plan_rate', amount: null };
  return { status: 'agreed', amount: scalar };
}

function agreedOneTimeVisitPrice(extracted = {}, v2Extraction = null) {
  return classifyOneTimeVisitPrice(extracted, v2Extraction).amount;
}

function requestsRegularPlanVisit(extracted = {}, v2Extraction = null) {
  const combined = [
    callBookingReServiceIntentText(extracted),
    v2Extraction?.meta?.call_summary,
    v2Extraction?.scheduling?.scheduling_notes_raw,
  ].filter(Boolean).join(' ');
  const cleaned = combined
    .replace(NEGATED_REGULAR_PLAN_VISIT_RE, ' ')
    .replace(HISTORICAL_REGULAR_PLAN_VISIT_RE, ' ');
  return REGULAR_PLAN_VISIT_RE.test(cleaned);
}

function v2CategoryLaneForReService(v2Extraction) {
  const sr = v2Extraction?.service_request;
  if (!sr || typeof sr !== 'object') return null;
  const category = String(sr.primary_service_category || '').trim();
  const secondary = Array.isArray(sr.secondary_categories)
    ? sr.secondary_categories.filter((c) => c && c !== category)
    : [];
  if (secondary.length > 0) return 'blocked';
  if (!category || category === 'other') return null;
  return STRUCTURED_RE_SERVICE_CATEGORY_LANE[category] || 'blocked';
}

function hasNegatedReServiceIntent(text) {
  const raw = String(text || '');
  return !!raw && Boolean(raw.match(NEGATED_RE_SERVICE_RE)) && !hasAffirmativeReServiceIntent(raw);
}

function structuredReServiceCategoryLane(v2Extraction) {
  if (!v2Extraction || typeof v2Extraction !== 'object') return null;
  const sr = v2Extraction.service_request || {};
  const intent = String(sr.service_intent || '');
  const nature = String(v2Extraction.call_nature || '');
  const isCallback = intent === 'complaint_or_callback'
    && (nature === 'existing_customer_service'
      || nature === 'existing_customer_scheduling'
      || v2Extraction.customer_history?.status === 'current_active');
  const isServiceFollowUp = intent === 'follow_up_existing_service'
    && nature === 'existing_customer_service';
  if (!isCallback && !isServiceFollowUp) return null;
  const lane = v2CategoryLaneForReService(v2Extraction);
  return lane && lane !== 'blocked' ? lane : null;
}

function structuredReServiceLane(extracted = {}, v2Extraction = null) {
  const lane = structuredReServiceCategoryLane(v2Extraction);
  if (!lane) return null;
  if (agreedOneTimeVisitPrice(extracted, v2Extraction) !== null) return null;
  if (requestsRegularPlanVisit(extracted, v2Extraction)) return null;
  const combined = [
    callBookingReServiceIntentText(extracted),
    v2Extraction?.meta?.call_summary,
    v2Extraction?.scheduling?.scheduling_notes_raw,
  ].filter(Boolean).join(' ');
  if (hasNegatedReServiceIntent(combined)) return null;
  return lane;
}

// Cheap pre-gate so the processor only runs the re-service eligibility lookups
// (customer row + live lanes) on revisit-shaped calls.
function hasCallReServiceIntent(extracted = {}, v2Extraction = null) {
  if (requestsRegularPlanVisit(extracted, v2Extraction)) return false;
  const intentText = callBookingReServiceIntentText(extracted);
  if (intentText && hasAffirmativeReServiceIntent(intentText)) return true;
  return Boolean(structuredReServiceLane(extracted, v2Extraction));
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

// `strict`: a caller that must tell "the read failed" from "nothing is bookable" gets the
// error instead of the legacy empty list.
async function loadBookableCallServices(conn, { strict = false } = {}) {
  try {
    // Stable order matters beyond display: these rows render the prompt's
    // catalog block AND feed extractionPromptVersion's order-sensitive hash,
    // so planner-dependent row order would stamp identical catalogs as
    // different prompt versions and fragment shadow cohorts.
    // A retired-for-sale row (still active for the grandfathered plan) is
    // never offered to the call pipelines, even if booking_enabled is
    // re-selected later (codex r22 on #4786) — the same authority the public
    // menu reads.
    const { RETIRED_SALE_SERVICE_KEYS } = require('./pricing-engine/retired-sale-catalog');
    const rows = await conn('services')
      .where({ is_active: true, booking_enabled: true })
      .whereNotIn('service_key', [...RETIRED_SALE_SERVICE_KEYS])
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .select(BOOKABLE_SERVICE_COLUMNS);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (strict) throw err;
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
  // A stored extraction that still says "Waves Assessment" after the row was
  // renamed resolves to the row with the stable assessment key.
  const { isAssessmentServiceType } = require('./assessment-booking');
  return isAssessmentServiceType(value) ? (services.find(isAssessmentCatalogRow) || null) : null;
}

/**
 * Resolve the specific catalog service for a call booking.
 * Priority: the model's explicit catalog pick (specific_service_name, then
 * matched_service / requested_service when they name a catalog entry exactly),
 * then deterministic keyword rules over the extraction + transcript.
 * Returns a catalog row or null (null -> legacy coarse service label).
 */
// Re-service override (see RE_SERVICE_INTENT_RE block above): AFFIRMATIVE
// revisit intent from a LANE-ELIGIBLE customer anchors to the covered
// re-service row. `reServiceLanes` carries the live plan eligibility —
// lanes with an open callback are NOT pre-filtered (codex r3): the anchor
// must still resolve so the locked booking transaction can reject the
// duplicate into hold-for-review or attach to the existing visit, instead
// of silently booking a second appointment under a generic label. The
// coarse label must be lane-compatible, and a replaceable plan pick pins
// the lane to its own family (a pest plan revisit never books the lawn
// lane). Single candidate: eligibility + coarse-compat + plan-pin already
// narrowed the lane. Dual candidates need lane EVIDENCE from the call —
// exactly one of pest/lawn wording — or the override declines (codex r5:
// never guess which free service to dispatch; the processor's Waves
// Assessment fallback books an assessment instead).
function resolveReServiceLane(candidates, evidence, structuredLane, pickPlanLane) {
  // Bundled WaveGuard with no plan pick never guesses a lane: the call's own
  // wording must uniquely identify one lane AND the customer must cover it.
  if (structuredLane === 'either' && !pickPlanLane) {
    return evidence.length === 1 && candidates.includes(evidence[0]) ? evidence[0] : null;
  }
  // When no plan pick pins the lane and the call's wording uniquely names the
  // OPPOSITE uncovered lane (e.g. fungicide wording for a pest-only customer),
  // decline instead of dispatching the wrong service.
  if (!pickPlanLane && evidence.length === 1 && !candidates.includes(evidence[0])) return null;
  if (candidates.length === 1) return candidates[0];
  return evidence.length === 1 && candidates.includes(evidence[0]) ? evidence[0] : null;
}

function reServiceLaneEvidence(haystack) {
  const cleaned = String(haystack || '').replace(BRAND_NAME_FOR_LANE_RE, ' ');
  return [
    RE_SERVICE_LAWN_CONTEXT_RE.test(cleaned) && 'lawn',
    RE_SERVICE_PEST_CONTEXT_RE.test(cleaned) && 'pest',
  ].filter(Boolean);
}

function reServiceOverrideRow({ extracted, haystack, reServices, reServiceLanes, coarseServiceLabel, pickPlanLane, v2Extraction }) {
  // Never replace a call that agreed on a one-time visit price or explicitly
  // asks to schedule a regular plan visit with a $0 re-service row.
  if (agreedOneTimeVisitPrice(extracted, v2Extraction) !== null) return null;
  if (requestsRegularPlanVisit(extracted, v2Extraction)) return null;
  const intentText = callBookingReServiceIntentText(extracted);
  const hasExplicitIntent = !!intentText && hasAffirmativeReServiceIntent(intentText);
  const structuredLane = hasExplicitIntent ? null : structuredReServiceLane(extracted, v2Extraction);
  if (!hasExplicitIntent && !structuredLane) return null;
  // Preserve V2's primary service category and mixed-service guard even when
  // explicit callback wording established intent: a V2 pest complaint must
  // never book a lawn callback on a lawn-only customer, and an uncovered or
  // multi-category call declines instead of dispatching a pest/lawn re-service.
  const v2CategoryLane = v2CategoryLaneForReService(v2Extraction);
  if (v2CategoryLane === 'blocked') return null;
  const effectiveLane = structuredLane || v2CategoryLane;
  const structuredPin = effectiveLane === 'pest' || effectiveLane === 'lawn' ? effectiveLane : null;
  const coarse = coarseServiceLabel ? String(coarseServiceLabel) : null;
  const candidates = (reServiceLanes || []).filter((lane) => (
    (!pickPlanLane || lane === pickPlanLane)
    && (!structuredPin || lane === structuredPin)
    && !!RE_SERVICE_COARSE_COMPATIBLE[lane]
    && (coarse === null || RE_SERVICE_COARSE_COMPATIBLE[lane].has(coarse))
  ));
  const evidence = reServiceLaneEvidence(haystack);
  const lane = resolveReServiceLane(candidates, evidence, effectiveLane, pickPlanLane);
  return (reServices || []).find((s) => lane && s.service_key === RE_SERVICE_KEYS[lane]) || null;
}

// The Assessment pick holds against keyword rules only when it is the call's
// one service pick: if matched_service / requested_service name a SPECIFIC
// catalog row (e.g. a recorded pre-adoption V1 pick), the views disagree and
// the pre-existing keyword precedence decides, as before.
function assessmentPickHolds(pick, extracted, services) {
  if (!isAssessmentCatalogRow(pick)) return false;
  return ![extracted.matched_service, extracted.requested_service]
    .map((value) => findServiceByName(services, value))
    .some((row) => row && !isGenericCallCatalogRow(row));
}

// Lane a replaceable pick pins the re-service override to: the customer's own
// recurring plan family, 'pest' for an unpriced plan-covered pest one-time row,
// or 'lawn' for an unpriced One-Time Lawn Care row. A one-time row with an
// agreed/quoted one-time visit price stays a paid booking even if callback
// wording appears.
function reServicePickLane(pick, haystack, extracted, v2Extraction) {
  const planLane = reServiceLaneForPlanRow(pick);
  if (planLane) return planLane;
  if (agreedOneTimeVisitPrice(extracted, v2Extraction) !== null) return null;
  if (isPlanCoveredPestRow(pick) && !mentionsGermanRoach(haystack)) return 'pest';
  if (isPlanCoveredLawnRow(pick)) return 'lawn';
  return null;
}

function matchingKeywordRows(haystack, services) {
  return KEYWORD_SERVICE_RULES
    .filter((rule) => haystack && rule.matches(haystack))
    .map((rule) => services.find((s) => s.service_key === rule.serviceKey))
    .filter(Boolean);
}

// transcription / reServices / reServiceLanes / coarseServiceLabel / v2Extraction
// may be absent: the haystack drops empty parts and reServiceOverrideRow treats
// missing lists and labels as none.
function guardEvidenceText({ extracted = {}, v2Extraction = null, transcription = '' } = {}) {
  return [
    v2Extraction?.meta?.call_summary,
    v2Extraction?.scheduling?.scheduling_notes_raw,
    extracted?.call_summary,
    extracted?.pain_points,
    extracted?.requested_service,
    transcription,
  ].filter(Boolean).join('\n');
}

const QUESTION_OR_CHECK_RE = /\?$|\b(?:does|do|did|will|would|is|are|can)\s+(?:the\s+)?(?:lender|bank|buyer|seller|realtor|agent|title|underwriter)\b/i;

function hasExplicitWdoRefusal({ extracted = {}, v2Extraction = null, transcription = '' } = {}) {
  const callerText = transcription ? callerOnlyText(transcription) : '';
  const combined = guardEvidenceText({ extracted, v2Extraction, transcription: callerText });
  if (!combined) return false;
  const clauses = combined.split(/(?<=\?)|[.!\n,;]+/).map((s) => s.trim()).filter(Boolean);
  let refused = false;
  for (const clause of clauses) {
    if (QUESTION_OR_CHECK_RE.test(clause)) continue;
    if (WDO_CLAUSE_REFUSAL_RE.test(clause)) refused = true;
    else if (refused && WDO_CLAUSE_AFFIRM_RE.test(clause)) refused = false;
  }
  return refused;
}

function hasExplicitOneTimeOnlyIntent({ extracted = {}, v2Extraction = null, transcription = '' } = {}) {
  const sr = v2Extraction?.service_request;
  if (sr?.service_intent === 'recurring_membership_inquiry' || sr?.billing_choice) return false;
  const callerText = transcription ? callerOnlyText(transcription) : '';
  const combined = guardEvidenceText({ extracted, v2Extraction, transcription: callerText });
  if (!combined || !ONE_TIME_ONLY_INTENT_RE.test(combined)) return false;
  return !recurringIntentEvidence(transcription || combined);
}

function followUpDateScheduled(extracted = {}, v2Extraction = null) {
  if (v2Extraction?.scheduling?.follow_up_start_at) return true;
  return Boolean(extracted?.follow_up_date_time && /^\d{4}-\d{2}-\d{2}/.test(String(extracted.follow_up_date_time).trim()));
}

function followUpExplicitlyDiscussed(extracted = {}, v2Extraction = null) {
  if (extracted?.follow_up_visit_mentioned === true) return true;
  if (v2Extraction?.scheduling?.follow_up_mentioned === true) return true;
  return followUpDateScheduled(extracted, v2Extraction);
}

function lastRegexMatchIndex(re, text) {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let lastIdx = -1;
  let m;
  while ((m = scan.exec(text))) {
    lastIdx = m.index;
    if (scan.lastIndex === m.index) scan.lastIndex += 1;
  }
  return lastIdx;
}

function resolvePackageVisitCountChoice(combined) {
  let finalChoice = null;
  for (const rawClause of String(combined || '').split(/(?<=\?)|[.!\n,;]+/)) {
    const clause = rawClause.trim();
    if (!clause || QUESTION_OR_CHECK_RE.test(clause)) continue;
    const withoutNegTwo = clause.replace(NEGATED_TWO_VISIT_RE, (m) => ' '.repeat(m.length));
    const twoIdx = lastRegexMatchIndex(TWO_VISIT_EXPLICIT_RE, withoutNegTwo);
    const singleIdx = NEGATED_SINGLE_TREATMENT_RE.test(clause)
      ? -1
      : Math.max(lastRegexMatchIndex(FOLLOWUP_OMITTED_RE, clause), lastRegexMatchIndex(SINGLE_TREATMENT_EXPLICIT_RE, clause));
    if (twoIdx > singleIdx) finalChoice = 'two';
    else if (singleIdx > twoIdx) finalChoice = 'single';
  }
  return finalChoice;
}

function isDiscountedSinglePackageTreatment({
  catalogRow, extracted = {}, v2Extraction = null, transcription = '', resolvedPrice = null,
} = {}) {
  const { isPackageFollowUpServiceKey } = require('./package-followup-booking');
  if (!isPackageFollowUpServiceKey(catalogRow?.service_key)) return false;
  if (followUpDateScheduled(extracted, v2Extraction)) return false;
  const callerText = transcription ? callerOnlyText(transcription) : '';
  const combined = guardEvidenceText({ extracted, v2Extraction, transcription: callerText });
  if (NEGATED_SINGLE_TREATMENT_RE.test(combined)) return false;
  const choice = resolvePackageVisitCountChoice(combined);
  if (choice !== 'single') return false;
  if (FOLLOWUP_OMITTED_RE.test(combined)) return true;
  if (followUpExplicitlyDiscussed(extracted, v2Extraction)) return false;
  const listPrice = Number(catalogRow?.base_price);
  const price = resolvedPrice != null ? Number(resolvedPrice) : agreedOneTimeVisitPrice(extracted, v2Extraction);
  return Number.isFinite(listPrice) && listPrice > 0 && Number.isFinite(price) && price > 0
    && price < listPrice * PACKAGE_DISCOUNT_SINGLE_RATIO;
}

function isWdoCatalogRow(row) {
  return Boolean(row && (row.service_key === 'wdo_inspection' || /\bwdo\b/i.test(String(row.name || ''))));
}

function resolveWdoDeclinedCatalogFallback({
  callBookingCatalogRow, bookableCallServices = [], extracted = {}, v2Extraction = null, v2ApprovedExtraction = null, v2CanonicalExtraction = null, transcription = '',
} = {}) {
  const effectiveV2 = v2Extraction || v2ApprovedExtraction || v2CanonicalExtraction;
  if (!isWdoCatalogRow(callBookingCatalogRow) || !hasExplicitWdoRefusal({ extracted, v2Extraction: effectiveV2, transcription })) {
    return callBookingCatalogRow;
  }
  return bookableCallServices.find(isAssessmentCatalogRow) || null;
}

const GENERAL_PEST_RECURRING_KEYS = new Set([
  'pest_general_monthly',
  'pest_general_bimonthly',
  'pest_general_quarterly',
  'pest_general_semiannual',
  'general_pest_control',
]);

function isGeneralLawnRecurringRow(selected) {
  const cat = String(selected?.category || '').trim().toLowerCase();
  const key = String(selected?.service_key || '').trim().toLowerCase();
  const name = String(selected?.name || '');
  const isLawnCategory = cat === 'lawn' || cat === 'lawn_care' || /^lawn_care_/i.test(key);
  return isLawnCategory
    && /\blawn\s+care\b/i.test(name)
    && !/\b(?:termite|rodent|bait|monitoring|mosquito|shrub|tree|irrigation)\b/i.test(name);
}

function isSupportedGeneralRecurringFamily(selected) {
  if (!selected) return false;
  if (GENERAL_PEST_RECURRING_KEYS.has(selected.service_key)) return true;
  if (/^(?:monthly|bi[- ]?monthly|quarterly|semi[- ]?annual)\s+pest\b/i.test(String(selected.name || ''))) return true;
  return isGeneralLawnRecurringRow(selected);
}

function downgradeRecurringToOneTime(selected, services) {
  if (!isSupportedGeneralRecurringFamily(selected)) return null;
  const cat = String(selected?.category || '').trim().toLowerCase();
  const key = String(selected?.service_key || '').trim().toLowerCase();
  const isLawn = cat === 'lawn' || cat === 'lawn_care' || /^lawn_care_/i.test(key) || /\blawn\b/i.test(String(selected.name || ''));
  const targetKey = isLawn ? 'lawn_care_one_time' : 'one_time_pest_control';
  return services.find((s) => s.service_key === targetKey) || null;
}

function hasSpecialtyOneTimeHold({ callBookingCatalogRow, bookableCallServices = [], extracted = {}, v2Extraction = null, transcription = '' } = {}) {
  if (callBookingCatalogRow) return false;
  const byModelPick = findServiceByName(bookableCallServices, extracted.specific_service_name)
    || findServiceByName(bookableCallServices, extracted.matched_service)
    || findServiceByName(bookableCallServices, extracted.requested_service);
  const modelPick = (byModelPick && !isGenericCallCatalogRow(byModelPick))
    ? byModelPick
    : (matchingKeywordRows(callBookingResolutionHaystack(extracted, transcription), bookableCallServices)[0] || byModelPick);
  if (!modelPick || modelPick.billing_type !== 'recurring') return false;
  if (isSupportedGeneralRecurringFamily(modelPick) && downgradeRecurringToOneTime(modelPick, bookableCallServices)) {
    return false;
  }
  return hasExplicitOneTimeOnlyIntent({ extracted, v2Extraction, transcription });
}

function hasWdoMissingAssessmentHold({ callBookingCatalogRow, bookableCallServices = [], extracted = {}, v2Extraction = null, transcription = '' } = {}) {
  if (callBookingCatalogRow || bookableCallServices.some(isAssessmentCatalogRow)) return false;
  const rawPick = findServiceByName(bookableCallServices, extracted.specific_service_name)
    || findServiceByName(bookableCallServices, extracted.matched_service)
    || findServiceByName(bookableCallServices, extracted.requested_service)
    || matchingKeywordRows(callBookingResolutionHaystack(extracted, transcription), bookableCallServices)[0]
    || null;
  const namedWdo = isWdoCatalogRow(rawPick)
    || /\bwdo\b/i.test(String(extracted.specific_service_name || extracted.matched_service || ''));
  return Boolean(namedWdo && hasExplicitWdoRefusal({ extracted, v2Extraction, transcription }));
}

function applyCatalogSelectionGuard({
  callBookingCatalogRow, bookableCallServices = [], extracted = {}, v2ApprovedExtraction = null, v2CanonicalExtraction = null, transcription = '', genericBookingUnbookable = false,
} = {}) {
  const effectiveV2 = v2ApprovedExtraction || v2CanonicalExtraction;
  const row = resolveWdoDeclinedCatalogFallback({
    callBookingCatalogRow, bookableCallServices, extracted, v2Extraction: effectiveV2, transcription,
  });
  const wdoReplacementMissing = (isWdoCatalogRow(callBookingCatalogRow) && !row)
    || hasWdoMissingAssessmentHold({ callBookingCatalogRow: row, bookableCallServices, extracted, v2Extraction: effectiveV2, transcription });
  const specialtyHold = hasSpecialtyOneTimeHold({
    callBookingCatalogRow: row, bookableCallServices, extracted, v2Extraction: effectiveV2, transcription,
  });
  return {
    callBookingCatalogRow: row,
    genericBookingUnbookable: Boolean(genericBookingUnbookable || specialtyHold || wdoReplacementMissing),
  };
}

function applyCallServiceSelectionGuards({ selected, extracted, transcription, services, v2Extraction }) {
  if (!selected) return null;
  if ((selected.service_key === 'wdo_inspection' || /\bwdo\b/i.test(String(selected.name || '')))
    && hasExplicitWdoRefusal({ extracted, v2Extraction, transcription })) {
    return services.find(isAssessmentCatalogRow) || null;
  }
  if (selected.billing_type === 'recurring' && hasExplicitOneTimeOnlyIntent({ extracted, v2Extraction, transcription })) {
    return downgradeRecurringToOneTime(selected, services);
  }
  if (selected.service_key === 'cockroach_control'
    && isDiscountedSinglePackageTreatment({ catalogRow: selected, extracted, v2Extraction, transcription })) {
    return services.find((s) => s.service_key === 'one_time_pest_control') || selected;
  }
  return selected;
}

function resolveCallBookingCatalogService({
  extracted = {}, transcription, services = [],
  reServices, reServiceLanes, coarseServiceLabel, v2Extraction = null,
} = {}) {
  if (!Array.isArray(services) || services.length === 0) return null;
  const finish = (selected) => applyCallServiceSelectionGuards({ selected, extracted, transcription, services, v2Extraction });

  const byModelPick = findServiceByName(services, extracted.specific_service_name)
    || findServiceByName(services, extracted.matched_service)
    || findServiceByName(services, extracted.requested_service);
  const haystack = callBookingResolutionHaystack(extracted, transcription);
  const pickPlanLane = reServicePickLane(byModelPick, haystack, extracted, v2Extraction);
  if (byModelPick && !isGenericCallCatalogRow(byModelPick) && !pickPlanLane) return finish(byModelPick);

  const keywordRows = matchingKeywordRows(haystack, services);
  const keywordRow = keywordRows[0] || null;

  const reServiceRow = keywordGatedReServiceRow({
    keywordRows, extracted, haystack, reServices, reServiceLanes, coarseServiceLabel, pickPlanLane, v2Extraction,
  });
  if (reServiceRow) return finish(reServiceRow);

  const keywordMayReplacePick = !assessmentPickHolds(byModelPick, extracted, services)
    && (!byModelPick || isGenericCallCatalogRow(byModelPick));
  return finish((keywordMayReplacePick && keywordRow) || byModelPick || null);
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
const STT_CLOCK_WORD_RE = /\b(?:am|pm|a\.m|p\.m|o['’]?clock|noon|morning|afternoon|evening)\b/i;

function parseRawSttSmallAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw || '').trim();
  if (!s) return null;
  const colonMatch = s.match(/^\$?\s*(\d{1,2}):([0-5]\d)\s*$/);
  if (colonMatch) return Number(`${colonMatch[1]}.${colonMatch[2]}`);
  const tokens = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  return tokens.length === 1 ? Number(tokens[0]) : null;
}

function hasExplicitCurrencyEvidence(rawSource, evidence) {
  const rawHasDollar = typeof rawSource === 'string' && /\$/.test(rawSource);
  return rawHasDollar || /\$|\b(?:dollars?|bucks)\b/i.test(evidence);
}

function withinCatalogHundredRange(scaled, catalogRow, evidence = '') {
  if (scaled < 100 || scaled > 1999) return false;
  const base = Number(catalogRow?.base_price);
  if (!Number.isFinite(base) || base < 100) return false;
  if (Math.abs(scaled - base) < 0.005) return true;
  return /\bhundred\b/i.test(String(evidence || '')) && Math.abs(scaled - base) <= base * 0.30;
}

function isFinalAcceptedStaffSttQuote(v2Extraction, entry) {
  const sr = v2Extraction?.service_request;
  if (!sr || sr.price_is_final !== true || sr.price_offered_by_staff !== true || sr.price_accepted_by_caller !== true) {
    return false;
  }
  if (sr.service_intent === 'recurring_membership_inquiry' || sr.billing_choice || sr.waveguard_tier_mentioned) {
    return false;
  }
  if (hasMultipleServicesOrProperties(v2Extraction)) return false;
  return Boolean(entry
    && entry.stated_by === 'agent'
    && entry.caller_response === 'accepted'
    && entry.amount_max_usd == null
    && entry.unit !== 'per_application'
    && !isPlanRateV2Price(entry));
}

function consistentSttSmallAmount(sr, quotedPrice, entry) {
  const parsed = [sr.quoted_price_usd, quotedPrice, entry.amount_usd]
    .filter((v) => v != null)
    .map(parseRawSttSmallAmount);
  if (parsed.length === 0 || parsed.some((n) => n == null || n <= 0.5 || n >= MIN_QUOTED_CALL_PRICE)) {
    return null;
  }
  const first = parsed[0];
  return parsed.every((n) => Math.abs(n - first) < 0.001) ? first : null;
}

function evidenceQuoteConfirmsRawAmount(evidence, raw, scaled) {
  if (!evidence) return false;
  const dollarMatches = [...String(evidence).matchAll(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
  const spokenMatches = [...String(evidence).matchAll(/\b(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:dollars?|bucks)\b/gi)];
  const matches = [...dollarMatches, ...spokenMatches];
  if (matches.length === 0) return false;
  return matches.every((m) => {
    const val = Number(String(m[1]).replace(/,/g, ''));
    return Math.abs(val - raw) < 0.01 || Math.abs(val - scaled) < 0.01;
  });
}

// Recover STT hundred-dollar decimal mishears ("$2.50" -> $250, "$3.50" -> $350)
// ONLY when scalar, structured entry, and evidence agree for ONE final accepted
// staff quote tied to a FIXED catalog row (exact catalog list match, or ±30%
// when spoken "hundred" wording confirms scale).
function recoverSttDecimalCallPrice({ quotedPrice, catalogRow, v2Extraction = null } = {}) {
  if (!catalogRow || catalogRow.billing_type !== 'one_time' || catalogRow.pricing_type !== 'fixed') return null;
  const sr = v2Extraction ? v2Extraction.service_request : null;
  const entries = v2StructuredPriceEntries(sr);
  const entry = entries.length === 1 ? entries[0] : null;
  if (!isFinalAcceptedStaffSttQuote(v2Extraction, entry) || !priceMatchesBookedCatalogRow(sr, catalogRow)) return null;

  const raw = consistentSttSmallAmount(sr, quotedPrice, entry);
  if (raw == null) return null;
  const rawSource = [sr.quoted_price_usd, quotedPrice, entry.amount_usd].find((v) => v != null);
  const evidence = entry.evidence_quote ? String(entry.evidence_quote) : '';
  if (STT_CLOCK_WORD_RE.test(`${evidence} ${String(rawSource)}`)) return null;
  if (!hasExplicitCurrencyEvidence(rawSource, evidence)) return null;
  const scaled = Math.round(raw * 100);
  if (!withinCatalogHundredRange(scaled, catalogRow, evidence)) return null;
  return evidenceQuoteConfirmsRawAmount(evidence, raw, scaled) ? scaled : null;
}

function resolveCallBookingPrice({ quotedPrice, catalogRow, v2Extraction = null } = {}) {
  if (isReServiceCatalogRow(catalogRow) || isAssessmentCatalogRow(catalogRow)) {
    return { price: null, source: null };
  }
  if (!catalogRow || catalogRow.billing_type !== 'one_time') {
    return { price: null, source: null };
  }
  const quoted = classifyOneTimeVisitPrice({ quoted_price: quotedPrice }, v2Extraction, catalogRow);
  if (quoted.status === 'agreed') return { price: quoted.amount, source: 'transcript' };
  if (quoted.status === 'disputed') return { price: null, source: null };
  const recovered = recoverSttDecimalCallPrice({ quotedPrice, catalogRow, v2Extraction });
  if (recovered !== null) return { price: recovered, source: 'transcript' };
  const base = Number(catalogRow.base_price);
  if (catalogRow.pricing_type === 'fixed' && Number.isFinite(base) && base > 0) {
    return { price: Math.round(base * 100) / 100, source: 'catalog' };
  }
  return { price: null, source: null };
}

/**
 * Whether a call booking can put `price` on `serviceName`: the name is a
 * bookable catalog row that takes a call price (a one_time row that is not a
 * re-service or an assessment), and the price is inside the booking's bounds.
 * The call booker's agreed-one-time-job hold asks this before it keeps a
 * one-time service. The name must be the row's own current name
 * (serviceNameKey): the lookup a booking starts with also bridges a short
 * name, a key and a renamed label, and the call booking check ties a price
 * to a visit by the name alone, so a bridged name is no hold.
 */
function callServiceBooksAtPrice(services, serviceName, price) {
  if (price == null || !Array.isArray(services)) return false;
  const { serviceNameKey } = require('./call-one-time-job');
  const row = findServiceByName(services, serviceName);
  if (!row || serviceNameKey(row.name) !== serviceNameKey(serviceName)) return false;
  // The quote itself must pass: a fixed row's list price that equals a rejected quote is not that price.
  const priced = resolveCallBookingPrice({ quotedPrice: price, catalogRow: row });
  return priced.source === 'transcript' && priced.price === price;
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
// Parent date + the service's catalog interval (default 14 days). parentDate
// is an ET wall-clock calendar date; the server runs UTC, so day math goes
// through the ET helpers (noon anchor clears DST seams). Null if unparseable.
function catalogIntervalFollowUpDate(parentDate, catalogRow) {
  const configured = Number(catalogRow?.follow_up_interval_days);
  const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FOLLOW_UP_INTERVAL_DAYS;
  const base = parseETDateTime(`${parentDate}T12:00`);
  return Number.isNaN(base.getTime()) ? null : etDateString(addETDays(base, days));
}

function followUpRowDisallowed(catalogRow, parentDate) {
  const serviceKey = catalogRow?.service_key;
  return !isValidCalendarDate(parentDate)
    || isAssessmentCatalogRow(catalogRow)
    || catalogRow?.billing_type === 'recurring'
    || /^rodent_/.test(serviceKey);
}

function parseStatedFollowUp(rawValue, parentDate) {
  const m = String(rawValue || '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m || !isValidCalendarDate(m[1])) return { futureDate: null, futureWindow: null, nonFutureDate: false };
  if (m[1] > parentDate) return { futureDate: m[1], futureWindow: m[2] || null, nonFutureDate: false };
  return { futureDate: null, futureWindow: null, nonFutureDate: true };
}

function followUpEligibility(extracted, catalogRow, stated, v2Extraction, transcription = '', resolvedPrice = null) {
  const isExistingServiceFollowUp = EXISTING_SERVICE_FOLLOWUP_INTENTS.has(
    String(v2Extraction?.service_request?.service_intent || ''),
  );
  const hasNewSalePrice = agreedOneTimeVisitPrice(extracted, v2Extraction) !== null;
  const suppressForExistingFollowUp = isExistingServiceFollowUp && !hasNewSalePrice;
  const { packageFollowupAutobookLive } = require('../config/feature-gates');
  const { isPackageFollowUpServiceKey } = require('./package-followup-booking');
  const discountedSingle = isDiscountedSinglePackageTreatment({
    catalogRow, extracted, v2Extraction, transcription, resolvedPrice,
  });
  const packageRow = !suppressForExistingFollowUp
    && !discountedSingle
    && packageFollowupAutobookLive()
    && isPackageFollowUpServiceKey(catalogRow?.service_key);
  const mentionCounts = extracted.follow_up_visit_mentioned === true
    && !suppressForExistingFollowUp
    && !(stated.nonFutureDate && catalogRow?.requires_follow_up !== true);
  return { discussed: mentionCounts || Boolean(stated.futureDate), packageRow };
}

function resolveCallFollowUpPlan({
  extracted = {}, catalogRow, parentDate, parentWindowStart, v2Extraction = null, transcription = '', resolvedPrice = null,
} = {}) {
  if (followUpRowDisallowed(catalogRow, parentDate)) return null;

  const stated = parseStatedFollowUp(extracted.follow_up_date_time, parentDate);
  const { discussed, packageRow } = followUpEligibility(
    extracted, catalogRow, stated, v2Extraction, transcription, resolvedPrice,
  );
  if (!discussed && !packageRow) return null;

  // Date from the transcript when a valid future date was stated, else the
  // catalog interval. Window: the stated time, else the parent's, else 09:00.
  const scheduledDate = stated.futureDate || catalogIntervalFollowUpDate(parentDate, catalogRow);
  if (!scheduledDate) return null;
  const statedWindow = stated.futureWindow;
  return {
    scheduledDate,
    windowStart: [statedWindow, parentWindowStart].find(isValidWindowTime) || '09:00',
    // The call set this hour; without it windowStart is a copy (visit 1's
    // hour, or 09:00) that may move to a free hour (plan-taken-hour.js
    // callFollowUpWindow).
    ...(isValidWindowTime(statedWindow) ? { hourStated: true } : {}),
    // The plan exists only because the service is a package — nobody on the
    // call discussed a second visit. The writer skips it while the primary
    // is still a pending office-review request (office confirm books it).
    ...(discussed ? {} : { packageOnly: true }),
  };
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
// Two child kinds ride a parent: the call pipeline's (pending until the
// office confirms the time) and the package auto-book's
// (package-followup-booking.js — booked CONFIRMED by owner ruling
// 2026-10-04, so its confirmed state still means "spaced from visit 1").
// Both stop following a parent MOVE once the customer confirmed (or
// re-picked) the date: that date is now the customer's own.
const PACKAGE_FOLLOWUP_SOURCE_ACTION = 'package_followup_auto';
const LINKED_FOLLOWUP_KIND_SQL = "((source_action = ? AND status = 'pending') OR (source_action = ? AND status IN ('pending', 'confirmed')))";
const applyCallFollowUpFilter = (q, parentServiceId) => q
  .where({ parent_service_id: parentServiceId, customer_confirmed: false })
  .whereRaw(LINKED_FOLLOWUP_KIND_SQL, ['ai_call_pipeline_followup', PACKAGE_FOLLOWUP_SOURCE_ACTION]);
const PACKAGE_CHILD_NOT_MOVED_SQL = '(source_action <> ? OR NOT EXISTS (SELECT 1 FROM reschedule_log rl WHERE rl.scheduled_service_id = scheduled_services.id))';
// A parent CANCEL is wider for the package child: it is a $0 included
// treatment of the cancelled package, so it goes with visit 1 even after
// the customer confirmed it (codex #5896 r1 P1). The call child keeps its
// pending + unconfirmed rule.
// 'rescheduled' counts: a customer reschedule request parks the child there
// until it is rebooked, and it must not be rebooked after its package was
// cancelled.
const LINKED_FOLLOWUP_CANCEL_SQL = "((source_action = ? AND status = 'pending' AND customer_confirmed = false) OR (source_action = ? AND status IN ('pending', 'confirmed', 'rescheduled')))";
const applyCallFollowUpCancelFilter = (q, parentServiceId) => q
  .where({ parent_service_id: parentServiceId })
  .whereRaw(LINKED_FOLLOWUP_CANCEL_SQL, ['ai_call_pipeline_followup', PACKAGE_FOLLOWUP_SOURCE_ACTION]);

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
  return applyCallFollowUpFilter(conn('scheduled_services'), parentServiceId)
    // A package visit 2 follows only until it is rescheduled on its own.
    // The customer can move it from the portal, and that move leaves
    // customer_confirmed false — a date or time the customer picked is
    // theirs, and a later parent move must not overwrite it. A
    // reschedule_log row of its own is the marker (every rebooker move
    // writes one, a same-day time change included; this hook's own shifts
    // write none). Booking-time evidence only: the catalog interval is
    // editable and says nothing about where this child was put.
    .whereRaw(PACKAGE_CHILD_NOT_MOVED_SQL, [PACKAGE_FOLLOWUP_SOURCE_ACTION])
    .select('id', 'technician_id', 'window_start', 'window_end', 'estimated_duration_minutes', 'recurring_dispatch_due_date',
      conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"),
      conn.raw("to_char(scheduled_date + (?::date - ?::date), 'YYYY-MM-DD') as new_day", [toStr, fromStr]));
}

// Why a follow-up kept its date when its parent moved (the admin card's words; no reason = its slot is booked).
const KEPT_DATE_WHY = { changed: 'changed meanwhile', added: 'added meanwhile', shift: "outside the technician's shift" };

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
// order); options.plan is then REQUIRED — the very rows the caller locked
// for (planCallFollowUpShift, pre-lock), so a child that changed since is
// judged against the locked set, never against a fresher unlocked read
// (codex r12 P1). Otherwise the shift plans and takes the locks itself at
// the start of its own transaction. options.report (optional out-param):
// { skipped: [{ id, day, newDay }] } — children whose destination slot is
// already booked; they keep their date (best-effort contract) instead of
// being written onto an occupied slot (AGENTS.md booking conflict-check
// rule; hook r20 P1). A caller that passes no report cannot surface those,
// so the helper rings the durable schedule_conflict admin card itself
// (codex r12 P2) — a follow-up that silently lost its spacing is an
// operator problem either way.
//
// options.shiftLive (GATE_TECH_SHIFT_HOURS; an automatic move passes it, the
// office's own move does not): a child keeps its hours and its technician and
// changes its day only, so the move does not place it. It is skipped like a
// booked slot (it keeps its date and is reported, reason 'shift') only when
// the change of day takes it out of its technician's shift
// (shiftLostByDayChange, the series mover's rule for a later stop): the shift
// held it on its day and does not hold it on the new one. A technician's set
// hours are the same every day and only today's follow a clock-in, so that is
// a child that leaves today or lands on it. A child the shift did not hold
// where it was is the office's placement and moves as before.
async function shiftCallFollowUpsForParentMove({ conn, parentServiceId, fromDate, toDate, occupancyHeld = false, plan = null, report = null, shiftLive = false, noticeActorId = null, suppressTechNotice = false }) {
  const fromStr = callBookingDateOnly(fromDate);
  const toStr = callBookingDateOnly(toDate);
  if (!parentServiceId || !fromStr || !toStr || fromStr === toStr) return 0;
  const noticeRows = [];
  // Tech-day membership fence + route_order clear (uncapped audit r26 P1):
  // a date shift moves the child between tech-days, so it must hold the
  // same 'slot-reserve' fence every other date/tech writer holds — an
  // unfenced shift can land a stop into a day AFTER the nightly reorder's
  // membership read, and its carried sequence number would interleave into
  // the new day's run. Every matched row changes day (delta is non-zero by
  // the guard above), so clearing route_order is correct for all of them.
  if (occupancyHeld && !Array.isArray(plan)) {
    throw new Error('shiftCallFollowUpsForParentMove: occupancyHeld requires the plan the caller locked for');
  }
  const run = async (trx) => {
    const kids = occupancyHeld ? plan : await planCallFollowUpShift({ conn: trx, parentServiceId, fromDate, toDate });
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
    // The pre-lock read only named the locks. Everything the probe and the
    // write key on — day, tech, window, duration — is re-read UNDER the
    // locks (hook r22 P1): a child whose tech or day changed meanwhile sits
    // in tech-days this transaction never fenced and is skipped (best-effort
    // contract: it stays where the newer writer put it); the probe uses the
    // locked values, and the write CASes on every one of them so a
    // concurrent window/tech edit between here and the UPDATE misses
    // instead of moving an unprobed block.
    const lockedById = new Map((await planCallFollowUpShift({ conn: trx, parentServiceId, fromDate, toDate })).map((k) => [String(k.id), k]));
    let shifted = 0;
    const skipped = [];
    const shiftedRows = [];
    // A child that appeared AFTER the plan (a call-recording reprocess
    // created a missing follow-up) is not in the locked set the caller
    // fenced for: not written — and reported, so the package's lost
    // spacing is never silent (codex r19 P2).
    if (occupancyHeld) {
      const plannedIds = new Set(kids.map((k) => String(k.id)));
      for (const [id, k] of lockedById) {
        if (!plannedIds.has(id)) skipped.push({ id: k.id, day: k.day, newDay: k.new_day, reason: 'added' });
      }
    }
    for (const planned of kids) {
      const k = lockedById.get(String(planned.id));
      if (!k || k.day !== planned.day || k.new_day !== planned.new_day || String(k.technician_id ?? '') !== String(planned.technician_id ?? '')) {
        // Plan drift (the child moved / was reassigned before the locked
        // read): not written — and REPORTED, like a booked slot, so the
        // caller's warning and the durable card say the package lost its
        // spacing (codex r17 P2).
        skipped.push({ id: planned.id, day: planned.day, newDay: planned.new_day, reason: 'changed' });
        continue;
      }
      if (shiftLive && await require('./technician-eligibility').shiftLostByDayChange(trx, k.technician_id, k, k.day, k.new_day)) {
        skipped.push({ id: k.id, day: k.day, newDay: k.new_day, reason: 'shift' });
        continue;
      }
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
            // Rows that do not occupy the slot (AGENTS.md occupancy rule).
            excludeStatuses: ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'],
            // The write below CASes on k.technician_id, so the child lands on
            // the destination day with exactly this technician; another
            // technician's overlapping stop is no clash (gate-dark,
            // occupancy.js header), an unassigned one still is.
            technicianId: k.technician_id || null,
          })
          : [{ unprobed: true }];
        if (clash.length) {
          skipped.push({ id: k.id, day: k.day, newDay: k.new_day });
          continue;
        }
      }
      const wrote = await applyCallFollowUpFilter(trx('scheduled_services').where({ id: k.id }), parentServiceId)
        // CAS on the locked read (knex object form renders null as IS NULL).
        .where({
          technician_id: k.technician_id ?? null,
          window_start: k.window_start ?? null,
          window_end: k.window_end ?? null,
          estimated_duration_minutes: k.estimated_duration_minutes ?? null,
        })
        .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [k.day])
        .update({
          scheduled_date: trx.raw('scheduled_date + (?::date - ?::date)', [toStr, fromStr]),
          ...recurringDispatchDuePatch({ ...k, scheduled_date: k.day }, { scheduled_date: k.new_day }),
          route_order: null,
          updated_at: trx.fn.now(),
        });
      if (Number(wrote) === 1) {
        shifted += 1;
        // The window the visit keeps, read once: for the caller's report and for its technician's notice.
        const keptWindow = { windowStart: k.window_start || null, windowEnd: k.window_end || null };
        shiftedRows.push({ id: k.id, previousDate: k.day, date: k.new_day, ...keptWindow });
        // The CAS pinned technician_id, so k.technician_id IS the committed holder.
        if (k.technician_id) noticeRows.push({ id: k.id, technicianId: k.technician_id, fromDay: k.day, toDay: k.new_day, ...keptWindow });
      } else {
        skipped.push({ id: k.id, day: k.day, newDay: k.new_day, reason: 'changed' }); // CAS miss = drift too
      }
    }
    // Shifted children (with their kept windows) — the caller's durable
    // reminder sync must cover them (codex r19 P1). previousDate/date are the
    // child's OWN source and destination days: a follow-up spaced out from
    // its parent sits on days neither parent date names, and a post-change
    // route refresh has to cover those too (codex #4295 r1 P2).
    // One guard for both lists: without a caller's report (an object) they go nowhere.
    const out = report && typeof report === 'object' ? report : {};
    if (shiftedRows.length) out.shifted = (out.shifted || []).concat(shiftedRows);
    if (skipped.length) {
      out.skipped = (out.skipped || []).concat(skipped);
      // The durable operator card rings for EVERY caller — a report only
      // adds the response warning. A caller that dies after its transaction
      // commits but before returning would otherwise be the only record of
      // the follow-up that kept its date (codex r14 P2). Best-effort, own
      // connection — a rolled-back caller trx leaves at worst a stale card.
      {
        try {
          const NotificationService = require('./notification-service');
          // A 'changed' entry's day is only the planned one (the row moved, vanished or lost the CAS): never a link target.
          const kept = skipped.filter((k) => k.reason !== 'changed' && k.id && /^\d{4}-\d{2}-\d{2}$/.test(String(k.day))).sort((a, b) => String(a.day).localeCompare(String(b.day)))[0];
          await NotificationService.notifyAdmin(
            'schedule_conflict',
            'Follow-up visit kept its date',
            `The primary visit moved, but ${skipped.length} linked follow-up visit(s) kept their date (${skipped.map((k) => `${k.day} → ${k.newDay} — ${KEPT_DATE_WHY[k.reason] || 'slot booked'}`).join(', ')}). Re-space them from dispatch.`,
            // The earliest follow-up proven to still sit on its day (slot booked or added meanwhile).
            { link: kept ? `/admin/dispatch?tab=schedule&date=${kept.day}&appointment=${encodeURIComponent(kept.id)}` : '/admin/dispatch?tab=schedule',
              metadata: { parentServiceId, skipped } },
          );
        } catch (err) {
          logger.error(`[call-booking] follow-up kept-date card failed for parent ${parentServiceId}: ${err.message}`);
        }
      }
    }
    return shifted;
  };
  const shiftedCount = await (conn.isTransaction ? run(conn) : conn.transaction(run));
  // Tech-facing move cards for the children that moved with the parent
  // (tech-visit-notifications.js): each shifted visit is its own card, to
  // its own holder. Waits for the caller's outermost commit when this ran
  // inside one; gate-dark, never awaited. A caller whose parent move may
  // still be compensated (suppressTechNotice) keeps these quiet too.
  if (!suppressTechNotice && noticeRows.length) {
    const techNotices = require('./tech-visit-notifications');
    for (const n of noticeRows) {
      void techNotices.notifyVisitRescheduled({
        visitId: n.id, technicianId: n.technicianId, actorId: noticeActorId,
        previous: { date: n.fromDay, windowStart: n.windowStart, windowEnd: n.windowEnd },
        snapshot: { date: n.toDay, windowStart: n.windowStart, windowEnd: n.windowEnd },
        trx: conn.isTransaction ? conn : null,
      });
    }
  }
  return shiftedCount;
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
// The re-check an approved linked visit passes under its own row lock before the parent's cancel takes it along.
async function assertApprovedChildUnchanged(trx, parentServiceId, childId, want) {
  const changed = (reason) => Object.assign(new Error(`linked follow-up ${childId} changed since the card: ${reason}`), { code: 'LINKED_CHILD_CHANGED', reason });
  const locked = await applyCallFollowUpCancelFilter(trx('scheduled_services'), parentServiceId)
    .where('id', childId).forUpdate().first('id', 'status', 'scheduled_date', 'service_type', 'technician_id', 'visit_id');
  if (!locked) throw changed('no_longer_linked');
  if (String(locked.status) !== String(want.status)) throw changed('status_changed');
  // The card refuses a grouped linked visit; one grouped since (package follow-ups group automatically) would run the
  // group hook (detach, window change, dissolve) on cancel, effects the card never showed.
  if (locked.visit_id) throw changed('grouped_changed');
  if (callBookingDateOnly(locked.scheduled_date) !== callBookingDateOnly(want.scheduled_date)) throw changed('date_changed');
  if ((locked.service_type || null) !== (want.service_type || null)) throw changed('service_changed');
  // The child's own tech cancel notice goes to whoever is assigned NOW: a reassigned child is not the one the card showed.
  if (Object.prototype.hasOwnProperty.call(want, 'technician_id') && (locked.technician_id || null) !== (want.technician_id || null)) throw changed('technician_changed');
  // The cancel recovery sweep pins each child's restoration count with the bundle (services/ib-cancel-effect-bundles.js). A child
  // the dead request had already cancelled and an operator then RESTORED matches its card again (same status, date, service) and
  // would be cancelled a second time; a higher count under the child's own lock says it was restored since. No times compared.
  if (want.restorations_seen !== undefined
    && (await require('./cancel-generation-fence').countRestorations(trx, childId)) !== Number(want.restorations_seen)) {
    throw changed('child_restored_since');
  }
  // The same money-rail checks the card ran on every linked visit (prepaid or coverage, estimate deposit or annual
  // prepay, card request or hold, inspection-credit offer, any invoice), repeated on this child's own transaction and
  // lock. A child that has money now is not cancelled by the bar's replay and never reaches the shared money seam.
  const money = await require('./appointment-cancel-impact').linkedChildMoneyReason(trx, [{ id: childId }]);
  if (money) throw changed(`money_added_${money}`);
}

// A typed refusal inside a child's transaction -> the reason the report carries; null = an unexpected failure.
// A child cancel that failed for a reason other than a deliberate refusal. Opt-in report: an approved linked visit that failed
// to cancel stays active, and the receipt must say so. Recovery sweep only (parentFence): it is also not a finished step.
function noteChildCancelFailure({ childId, approved, report, parentFence }) {
  if (parentFence) parentFence.hits.push('child_cancel_error');
  if (approved && report && Array.isArray(report.skipped)) report.skipped.push({ id: childId, reason: 'cancel_failed' });
}

function childRefusalReason(err) {
  if (err && err.code === 'LINKED_CHILD_CHANGED') return err.reason;
  if (err && err.code === 'CANCEL_FENCE') return `parent_${err.fenceReason}`;
  return null;
}

// actorId: the staff row cancelling the parent (a technicians.id, or null)
// — rides into each child's history + the child's tech cancel card, so a
// technician cancelling their own booking hears nothing about its follow-up
// (codex #3887 r10 P2). Labels never come here: job_status_history's
// transitioned_by is a uuid column.
// packageOnly: the skipped / no-show cascade (job-status.js) — a package
// visit 2 is treatment 2 of a visit 1 that never happened, so it goes; a
// call-booked child keeps its office-owned lifecycle there, as before.
// approvedChildren (opt-in, the Intelligence Bar cancel card): [{ id, status, scheduled_date, service_type, technician_id }], the
// linked visits the operator approved. Only those are cancelled, each one only after it is re-read under its OWN row
// lock and still matches the card (still a live linked follow-up, same status, date and service, no invoice of its
// own); any other child, and any approved child that changed, is NOT cancelled and is listed in report.skipped
// ({ id, reason }). Without approvedChildren every caller behaves exactly as before.
// parentFence (opt-in, the Intelligence Bar cancel recovery sweep, services/cancel-generation-fence.js): inside each child's
// transaction the PARENT must still be the cancelled visit the card approved (FOR SHARE NOWAIT, so a restore in flight
// skips the child instead of waiting); a child that fails it is NOT cancelled and is listed in report.skipped.
async function cancelCallFollowUpsForParentCancel({ conn, parentServiceId, actorId = null, packageOnly = false, approvedChildren = null, report = null, parentFence = null }) {
  if (!parentServiceId) return 0;
  const { transitionJobStatus } = require('./job-status');
  const now = new Date();
  const childQuery = applyCallFollowUpCancelFilter(conn('scheduled_services'), parentServiceId);
  if (packageOnly) childQuery.where({ source_action: PACKAGE_FOLLOWUP_SOURCE_ACTION });
  const children = await childQuery.select('id', 'status', 'source_action', 'scheduled_date', 'service_type');
  const approved = Array.isArray(approvedChildren) ? new Map(approvedChildren.map((c) => [String(c.id), c])) : null;
  const skip = (id, reason) => {
    logger.warn(`[call-booking] linked follow-up ${id} of ${parentServiceId} NOT cancelled with the parent: ${reason}`);
    if (report && Array.isArray(report.skipped)) report.skipped.push({ id, reason });
  };
  if (approved) {
    const present = new Set(children.map((c) => String(c.id)));
    for (const id of approved.keys()) if (!present.has(id)) skip(id, 'no_longer_linked');
  }
  let cancelled = 0;
  for (const child of children) {
    if (approved && !approved.has(String(child.id))) { skip(child.id, 'not_on_card'); continue; }
    try {
      await conn.transaction(async (trx) => {
        if (approved) await assertApprovedChildUnchanged(trx, parentServiceId, child.id, approved.get(String(child.id)));
        if (parentFence) await require('./cancel-generation-fence').assertCancelGeneration(trx, parentFence);
        await transitionJobStatus({
          jobId: child.id,
          fromStatus: child.status,
          toStatus: 'cancelled',
          transitionedBy: actorId || null,
          notes: `Cancelled with parent call booking ${parentServiceId}`,
          // A package visit 2 arms reminders, so its own cancel could text the
          // customer; the parent's cancellation owns that choice (an operator
          // may have chosen no text), so the child never sends its own.
          // An approved cascade (the Intelligence Bar cancel card, which promises no text for a linked visit) texts
          // no child either, call-booked or package.
          ...(child.source_action === PACKAGE_FOLLOWUP_SOURCE_ACTION || approved ? { notifyCustomer: false } : {}),
          // An approved child was checked money-free under its own lock, and the card promised nothing about its money.
          // An invoice or inspection credit that lands between that check and the post-commit hook must not reach the
          // ordinary unpinned void/reversal seam (it never appeared on the card or in moneyReport); it is left for office review.
          ...(approved ? { moneySeam: 'caller' } : {}),
          // The card promised no text for a linked visit. notifyCustomer false makes the writer write a terminal
          // 'suppressed' marker, but only behind GATE_CANCEL_NOTICE_HOOK; cancelNoticeApproved writes it in this
          // transaction whatever the gate says, so no pod can late-claim the child's reminder row and text it.
          // (A claim an older notice already holds aborts this child's cancel: it stays active and is reported.)
          ...(approved ? { cancelNoticeApproved: true } : {}),
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
      logger.info(`[call-booking] cancelled linked follow-up ${child.id} with parent ${parentServiceId}`);
    } catch (childErr) {
      const refusal = childRefusalReason(childErr);
      if (refusal) { skip(child.id, refusal); continue; }
      logger.error(`[call-booking] call follow-up cancel cascade failed for child ${child.id} of ${parentServiceId}: ${childErr.message}`);
      noteChildCancelFailure({ childId: child.id, approved, report, parentFence });
    }
  }
  return cancelled;
}

module.exports = {
  loadBookableCallServices,
  findServiceByName,
  isGenericCallCatalogRow,
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
  followUpProbeEnd,
  sanitizeQuotedCallPrice,
  implicitConfirmedAgentPrice,
  recoverSttDecimalCallPrice,
  resolveWdoDeclinedCatalogFallback,
  applyCatalogSelectionGuard,
  hasSpecialtyOneTimeHold,
  hasMultipleServicesOrProperties,
  hasExplicitWdoRefusal,
  hasExplicitOneTimeOnlyIntent,
  isDiscountedSinglePackageTreatment,
  v2StructuredPriceEntries,
  isPlanRateV2Price,
  callServiceBooksAtPrice,
  shiftCallFollowUpsForParentMove,
  planCallFollowUpShift,
  cancelCallFollowUpsForParentCancel,
  applyCallFollowUpFilter,
  applyCallFollowUpCancelFilter,
  DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
};
