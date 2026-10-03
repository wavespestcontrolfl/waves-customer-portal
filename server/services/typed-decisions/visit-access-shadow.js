/**
 * Visit access and safety flags, shadow leg (visit_access.v1; dark behind
 * GATE_VISIT_ACCESS_FLAGS=shadow, honoured only while GATE_TYPED_DECISIONS is
 * live).
 *
 * For each of today's and tomorrow's open visits the sweep builds one small
 * state (the visit's service line, how many visits came before it, a few
 * structured facts, the notes a technician already sees, the customer's own
 * recent texts, the last technician's note), puts the package's six yes/no
 * questions to each live provider and records every answer in
 * decision_reviews (subject_type 'scheduled_services').
 *
 * SHADOW ONLY: nothing here is shown to a technician, written to a visit, a
 * brief or a customer record, belled or sent. The rows are evidence for the
 * later card flags.
 *
 * What leaves, exactly. The saved codes never do: the state says only
 * WHETHER codes are on file (`structured.has_codes`). The two fields whose
 * purpose is how to get in (access notes, side gate) always leave as a
 * closed-vocabulary marker. Every other note and customer text passes
 * redactForState: one that mentions access is replaced whole by that marker
 * (which access points; whether a problem is reported), a customer text that
 * follows one, or follows a Waves text about access, is withheld with it, and
 * in the rest digit-bearing and code-shaped tokens are masked. Known limit: a
 * customer text holding a bare word with no access context at all is sent as
 * written, as every inbound customer text already is by the SMS shadow
 * (sms-shadow.js; owner ruling 2026-10-01, texts may go to these providers).
 *
 * property_preferences, the texts and the visit history are keyed on the
 * customer, so only an account proven to have one premises is judged
 * (singlePremises); a multi-property account is left out.
 *
 * The state is a function of the visit and of facts dated before it, never of
 * "now" (texts stop at the visit's own start), so a repeat pass over an
 * unchanged visit builds the same digest and asks nobody; a visit whose state
 * did change (a new text, an edited note) is asked again and its unreviewed
 * rows are replaced. Each state asked about is stored, already redacted, in
 * visit_access_states: the review route shows and labels against that stored
 * state, so a later edit to the inputs never strands a row.
 */
const crypto = require('crypto');
const logger = require('../logger');
const { visitAccessShadowLive, typedDecisionsClefLive } = require('../../config/feature-gates');

const PACKAGE_ID = 'visit_access.v1';
const SUBJECT_TYPE = 'scheduled_services';
const STATES_TABLE = 'visit_access_states';
// Visits asked per pass; the rest wait for the next hourly pass. Visits whose
// state is already answered cost reads only and never count against it.
const MAX_ASKED_VISITS = 80;
// A visit that already has its first provider's answer and only retries
// another provider's failed leg draws on its own budget, so a provider that
// is down never keeps later visits from their first answer.
const MAX_RETRY_VISITS = 40;
const PRIMARY_PROVIDER = 'typesafe';
// The daily review item reads rows created in its last 14 days.
const REVIEW_AGE_MS = 13 * 24 * 60 * 60 * 1000;
const WORKERS = 2;
const MAX_TEXTS = 8;
const TEXT_CHARS = 260;
// Per note line; the lines together are bounded by their count.
const NOTE_CHARS = 400;
// The comms window's recurring cap (completion-comms-context RECURRING_CAP_DAYS).
const WINDOW_CAP_DAYS = 120;
const DEFAULT_START = '08:00';

const compact = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Redaction rules (redactForState below):
//  1. A text that names ANY access point or credential noun (ACCESS_NOUNS), or
//     holds a sentence completion-comms-context's isAccessSentence reads as
//     being about getting in, never leaves as written. A credential can be any
//     word in any notation ("use BLUE at the keypad", "Garage:sesame", "four
//     five four five"), so no token rule is safe there. It becomes a marker
//     built from two closed vocabularies only: the access nouns it mentioned
//     and whether it reports a problem. None of the writer's words survive.
//  2. In every other text, a token holding a digit is masked unless it is a
//     one- or two-digit number, an ordinal, a clock time or a day/month date
//     (house numbers, phone numbers and years go too), and so is a
//     capitalised code-shaped token ("BLUE") unless the line is shouted.
const ACCESS_NOUNS = [
  ['code', /\b(?:codes?|pins?|pass(?:code|word|phrase)s?|combos?|combinations?)\b/i],
  ['key', /\bkeys?\b/i],
  ['keypad', /\bkeypads?\b/i],
  ['lockbox', /\block\s*box(?:es)?\b/i],
  ['gate', /\bgates?\b/i],
  ['garage', /\bgarages?\b/i],
  ['door', /\bdoors?\b/i],
  ['lock', /\b(?:locks?|deadbolts?|padlocks?)\b/i],
  ['alarm', /\balarms?\b/i],
  ['remote', /\b(?:fobs?|remotes?|openers?)\b/i],
];
const ACCESS_PROBLEM_RE = /\b(?:locked|stuck|jammed|blocked|broken|closed|no\s+access|not?\s+(?:get|reach|access|open|enter)|(?:could|can|did|would|was|were)(?:\s+not|n['’]?t)\s+(?:get|reach|access|open|enter|able)|unable|nobody\s+(?:was\s+)?home|no\s+one\s+(?:was\s+)?home)\b/i;
// An instruction verb a credential rides on with no access noun beside it
// ("use sesame", "punch in blue"): such a text is withheld as well.
const ACCESS_VERB_RE = /\b(?:use|using|type|typing|punch(?:ing)?|press(?:ing)?|enter(?:ing)?|dial(?:ing)?|key\s+in|say|tell\s+(?:them|him|her))\b/i;
const PLAIN_NUMBER_RE = /^(?:\d{1,2}|\d+(?:st|nd|rd|th)|\d{1,2}(?::\d{2})?(?:am|pm)?|\d{1,2}\/\d{1,2})$/i;
const CAPS_CODE_RE = /^[A-Z][A-Z#*-]{2,}$/;
function shouted(sentence) {
  const words = sentence.match(/[A-Za-z]{2,}/g) || [];
  return words.length >= 3 && words.filter((word) => word === word.toUpperCase()).length / words.length >= 0.6;
}
// Whether a text names an access point or credential anywhere in it.
function mentionsAccess(text) {
  const { isAccessSentence } = require('../completion-comms-context');
  const whole = String(text || '');
  return ACCESS_NOUNS.some(([, re]) => re.test(whole)) || ACCESS_VERB_RE.test(whole)
    || whole.split(/(?<=[.!?])\s+|\n+/).some((sentence) => isAccessSentence(sentence));
}

// The closed-vocabulary marker for a withheld text: which access points it
// named and whether it reports a problem. Never any of its words.
function accessMarker(raw) {
  const nouns = ACCESS_NOUNS.filter(([, re]) => re.test(raw)).map(([name]) => name);
  const parts = [];
  if (nouns.length) parts.push(`mentions ${nouns.join(', ')}`);
  if (ACCESS_PROBLEM_RE.test(raw)) parts.push('reports a problem getting in');
  return parts.length ? `[access detail withheld: ${parts.join('; ')}]` : '[access detail withheld]';
}

// The unit is the WHOLE text (one note field, one customer text), never a
// sentence or a line: a credential can sit on the line after its access point
// ("Garage:\nsesame"), so a text that mentions access anywhere leaves only as
// the marker (pre-push P0, 2026-10-03).
function redactForState(text) {
  // redactAccessCodes ends with the sensitive-identifier pass (SSN, card, CVV).
  const { redactAccessCodes } = require('../context-aggregator');
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (mentionsAccess(raw)) return accessMarker(raw);
  return redactAccessCodes(raw).split(/\n+/).map((line) => {
    const loud = shouted(line);
    return line.replace(/\S+/g, (word) => {
      const [, lead, token, trail] = /^([("'“‘]*)(.*?)([.,!?;:)"'”’]*)$/.exec(word);
      const masked = /\d/.test(token) ? !PLAIN_NUMBER_RE.test(token) : (!loud && CAPS_CODE_RE.test(token));
      return masked ? `${lead}[redacted]${trail}` : word;
    });
  }).join(' ');
}

// A customer can split a credential over two texts ("my gate code is" / an
// hour later "bluebird"), and a reply to a Waves text that asked about access
// can come much later: every customer text within this long after an
// access-bearing text, either direction, is withheld with it.
const ACCESS_FOLLOW_UP_MS = 24 * 60 * 60 * 1000;
const ACCESS_REPLY_MS = ACCESS_FOLLOW_UP_MS;
const FOLLOW_UP_MARKER = '[follow-up to an access detail withheld]';

function dayString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const { etCalendarDayOf } = require('../../utils/datetime-et');
    return etCalendarDayOf(value);
  }
  return String(value).slice(0, 10);
}

// The instant the visit starts (its window start, else 08:00 Eastern on its
// date). Texts after it are never part of the state.
function stateCutoff(svc) {
  const { parseETDateTime } = require('../../utils/datetime-et');
  const day = dayString(svc.scheduled_date);
  const start = /^\d{2}:\d{2}/.test(String(svc.window_start || '')) ? String(svc.window_start).slice(0, 5) : DEFAULT_START;
  return parseETDateTime(`${day}T${start}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function visitAccessSubjectHash(state) {
  return crypto.createHash('sha256').update(canonical(state)).digest('hex');
}

function labelled(label, value, max) {
  const text = compact(redactForState(value), max);
  return text ? `${label}: ${text}` : null;
}

// A field whose whole purpose is how to get in (access notes, the side gate
// field): any word in it can be the credential ("sesame"), so it never leaves
// as written, whatever it says. Only its marker does.
function labelledAccessField(label, value) {
  return String(value || '').trim() ? `${label}: ${accessMarker(String(value))}` : null;
}

// property_preferences, the customer's texts and the visit history are all
// keyed on the customer, not the property. So a visit is judged only when the
// account is PROVEN to have one premises, the primary one
// (visit-property-scope.js customerHasOnlyPrimaryPremises, unresolved links
// failing the proof): then every saved fact, text and past visit is about the
// property this visit is at. A multi-property account is left out.
async function singlePremises(svc, dbh) {
  const linkage = require('../estimate-property-linkage');
  const { customerHasOnlyPrimaryPremises } = require('../service-report/visit-property-scope');
  const primary = linkage.normalizedStampedStreet(svc.customer_address_line1, svc.customer_address_line2, svc.customer_city, svc.customer_zip);
  if (!primary || linkage.scopeKeyLacksLocality(primary)) return false;
  return customerHasOnlyPrimaryPremises(dbh, svc.customer_id, { has_multi_home: svc.has_multi_home }, primary, { unresolvedFails: true });
}

// What is saved for the property: the structured facts, the two baselines
// production holds, and the note lines. The lines are in priority order and
// each is capped, so together they always fit: nothing is cut off the end.
async function loadSavedFacts(svc, dbh, day) {
  const prefs = await dbh('property_preferences').where({ customer_id: svc.customer_id }).first(
    'pet_count', 'pet_details', 'pets_secured_plan', 'contact_preference', 'away_mode_until', 'side_gate_access',
    'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
    'access_notes', 'parking_notes', 'special_instructions', 'chemical_sensitivities', 'chemical_sensitivity_details',
  ) || {};
  // The neighborhood gate directory (GATE_NEIGHBORHOOD_ACCESS) shows a
  // technician a shared gate entry for a customer with no code of their own:
  // the same reader the day feed uses says WHETHER one applies. Never its code.
  const neighborhoodGate = require('../../config/feature-gates').neighborhoodAccessLive()
    && (await require('../neighborhood-access').neighborhoodGateEntriesForVisits(dbh, [svc])).has(svc.id);
  const hasCodes = Boolean(prefs.neighborhood_gate_code || prefs.property_gate_code || prefs.garage_code || prefs.lockbox_code || neighborhoodGate);
  const petCount = Number.isInteger(prefs.pet_count) ? prefs.pet_count : 0;
  const notes = [
    // Scheduler audit segments are not property notes (utils/visit-notes.js).
    labelled('Visit note', require('../../utils/visit-notes').stripSchedulerAuditText(svc.notes), NOTE_CHARS),
    // What the customer told Waves about THIS visit when it was booked.
    labelled('Customer request for this visit', svc.customer_request, NOTE_CHARS),
    prefs.chemical_sensitivities ? labelled('Chemical sensitivity', prefs.chemical_sensitivity_details || 'yes', NOTE_CHARS) : null,
    labelledAccessField('Access notes', prefs.access_notes),
    labelledAccessField('Side gate', prefs.side_gate_access),
    labelled('Special instructions', prefs.special_instructions, NOTE_CHARS),
    labelled('Pets', prefs.pet_details, NOTE_CHARS),
    labelled('Pets secured plan', prefs.pets_secured_plan, NOTE_CHARS),
    labelled('Parking', prefs.parking_notes, NOTE_CHARS),
  ].filter(Boolean).join('\n');
  return {
    structured: {
      pet_count: petCount,
      has_codes: hasCodes,
      contact_preference: prefs.contact_preference || null,
      away_mode: Boolean(prefs.away_mode_until && dayString(prefs.away_mode_until) >= day),
      side_gate: Boolean(String(prefs.side_gate_access || '').trim()),
      chemical_sensitivity: Boolean(prefs.chemical_sensitivities),
      neighborhood_gate: Boolean(neighborhoodGate),
    },
    notes: notes || null,
    baselines: { dog_on_property: { rules: petCount > 0 }, needs_code_key_or_person: { rules: hasCodes } },
  };
}

// Completed visits on days BEFORE this one. scheduled_services is the history
// (a completed recurring visit can have no service_records row, as
// completion-comms-context reads it): the count, and where the texts' window
// starts: the newest same-line visit's COMPLETION time (so a one-visit
// instruction sent before or during that visit does not carry into this one;
// a legacy row without completed_at falls back to Eastern midnight of its
// day). The last technician note comes from the shared same-line history
// walk (utils/last-line-service.js), which pages until it finds the line.
async function loadHistory(svc, dbh, day, serviceLine) {
  const { detectServiceLine } = require('../service-report/service-line-configs');
  const { parseETDateTime } = require('../../utils/datetime-et');
  const { loadRecentLineServices } = require('../../utils/last-line-service');
  const earlier = () => dbh('scheduled_services')
    .where({ customer_id: svc.customer_id, status: 'completed' })
    .whereNot({ id: svc.id })
    .where('scheduled_date', '<', day);
  // Counted in the database, never from a capped read.
  const [{ count }] = await earlier().count('* as count');
  // The window's anchor can only lie inside the cap, so every completion in
  // that span is read (bounded by the cap, not by a row limit) and the line is
  // matched in memory: no newer visit of another line can push it out.
  const capDay = new Date(new Date(`${day}T12:00:00Z`).getTime() - (WINDOW_CAP_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = await earlier().where('scheduled_date', '>=', capDay)
    .orderBy('scheduled_date', 'desc').orderBy('id', 'desc')
    .select('service_type', 'scheduled_date', 'completed_at');
  const last = recent.find((r) => detectServiceLine(r.service_type) === serviceLine);
  const { lineRecords: [lastRecord] } = await loadRecentLineServices(dbh, svc.customer_id, svc.service_type, { limit: 1, before: day });
  return {
    count: Number(count) || 0,
    textsFrom: last ? (last.completed_at ? new Date(last.completed_at) : parseETDateTime(`${dayString(last.scheduled_date)}T00:00`)) : null,
    lastNote: lastRecord ? (compact(redactForState(lastRecord.technician_notes), NOTE_CHARS) || null) : null,
  };
}

// The customer's own texts between `floor` and `cutoff`, newest first, each
// through the withholding rules. Both directions are read, from a
// reply-window before the floor, but only the customer's texts inside the
// window enter the state: the rest is there solely so a reply to an access
// question ("What is your gate password?" / "sesame") is withheld with it.
const TEXT_READ_LIMIT = 120;
const TEXT_READ_PAGES = 10;
async function loadCustomerTexts(svc, dbh, floor, cutoff) {
  const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
  const { isSmsReaction } = require('../sms-intent');
  const { excludeRecruitingSmsLog } = require('../../utils/recruiting-thread-scope');
  const reaction = (row) => row.message_type === 'sms_reaction' || isSmsReaction(row.message_body);
  // Newest first, page by page, until the window holds enough of the
  // customer's own texts: Waves texts, tapbacks and reply-context rows before
  // the floor never use up the read. Recruiting texts (an applicant who is
  // also a customer) are owner-only and never read
  // (utils/recruiting-thread-scope.js).
  const texts = [];
  let truncated = false;
  for (let page = 0; page < TEXT_READ_PAGES; page += 1) {
    const rows = await excludeUnresolvedSendReservations(excludeRecruitingSmsLog(dbh('sms_log').where({ customer_id: svc.customer_id })))
      .whereIn('direction', ['inbound', 'outbound'])
      .where('created_at', '>=', new Date(floor.getTime() - ACCESS_REPLY_MS))
      .where('created_at', '<', cutoff)
      .orderBy('created_at', 'desc').orderBy('id', 'desc')
      .offset(page * TEXT_READ_LIMIT)
      .limit(TEXT_READ_LIMIT)
      .select('created_at', 'direction', 'message_body', 'message_type', 'status');
    texts.push(...rows);
    truncated = rows.length >= TEXT_READ_LIMIT;
    const own = texts.filter((row) => row.direction === 'inbound' && !reaction(row) && new Date(row.created_at) >= floor).length;
    if (!truncated || own >= MAX_TEXTS) break;
  }
  // A truncated read hides what came before its oldest row: fail closed and
  // withhold a full reply-window from there.
  let withholdUntil = truncated ? new Date(texts[texts.length - 1].created_at).getTime() + ACCESS_REPLY_MS : 0;
  // Oldest first, so a text that follows an access-bearing one is seen as such.
  const lines = texts
    .filter((row) => !reaction(row))
    .reverse()
    .map((row) => {
      const at = new Date(row.created_at).getTime();
      const access = mentionsAccess(row.message_body);
      if (row.direction !== 'inbound') {
        // Only a Waves text the customer received opens a reply window
        // (sms-shadow readLastOutboundBody's rule): not a failed or cancelled
        // send, not an internal alert.
        const received = ['queued', 'sent', 'delivered'].includes(row.status) && row.message_type !== 'internal_alert';
        if (access && received) withholdUntil = Math.max(withholdUntil, at + ACCESS_REPLY_MS);
        return null;
      }
      const held = access || at <= withholdUntil;
      // Only an access-bearing text opens or extends the window; a withheld
      // follow-up does not, or one chatty day would withhold everything after.
      if (access) withholdUntil = Math.max(withholdUntil, at + ACCESS_FOLLOW_UP_MS);
      if (at < floor.getTime()) return null;
      if (access) return redactForState(row.message_body);
      return held ? FOLLOW_UP_MARKER : compact(redactForState(row.message_body), TEXT_CHARS);
    })
    .filter(Boolean)
    .reverse()
    .slice(0, MAX_TEXTS);
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : null;
}

/**
 * The state one visit is judged on, with the two baselines production holds.
 * Returns null when the visit, its customer or its date cannot be read, or
 * the account is not proven single-premises. Throws on a database error
 * (callers count it as a failed visit).
 *
 * @returns {Promise<null | { state: object, baselines: object, subjectHash: string }>}
 */
async function buildVisitAccessState(svc, dbh) {
  const day = dayString(svc && svc.scheduled_date);
  if (!svc || !svc.id || !svc.customer_id || !day) return null;
  if (!(await singlePremises(svc, dbh))) return null;
  const { detectServiceLine } = require('../service-report/service-line-configs');
  const serviceLine = detectServiceLine(svc.service_type) || null;
  const cutoff = stateCutoff(svc);
  const saved = await loadSavedFacts(svc, dbh, day);
  const history = await loadHistory(svc, dbh, day, serviceLine);
  // The texts' window: from the last same-line visit's completion, capped,
  // up to this visit's start.
  const capFloor = new Date(cutoff.getTime() - WINDOW_CAP_DAYS * 24 * 60 * 60 * 1000);
  const floor = history.textsFrom && history.textsFrom > capFloor ? history.textsFrom : capFloor;
  const state = {
    service_line: serviceLine,
    visit_count: history.count,
    structured: saved.structured,
    notes_text: saved.notes,
    recent_texts: await loadCustomerTexts(svc, dbh, floor, cutoff),
    last_tech_notes: history.lastNote,
  };
  return { state, baselines: saved.baselines, subjectHash: visitAccessSubjectHash(state) };
}

const VISIT_COLUMNS = [
  's.id', 's.customer_id', 's.service_type', 's.scheduled_date', 's.window_start', 's.notes', 's.customer_request',
  // What the neighborhood gate reader keys on.
  's.property_id', 's.service_address_line1', 's.service_address_zip',
  // The primary address and the multi-home flag singlePremises reads.
  'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2', 'c.zip as customer_zip', 'c.city as customer_city',
  'c.has_multi_home',
];

// One visit: ask every live provider that has not already answered THIS
// state, then record each answer with the others' answers beside it.
async function shadowVisit(svc, { dbh, providers, out, now }) {
  const { askPackage } = require('./jev');
  const { recordDecisions, TABLE } = require('./shadow-recorder');
  const { packageFor } = require('./packages');
  const pkg = packageFor(PACKAGE_ID);
  // The evidence is what was known BEFORE the visit. Once it has started (its
  // window start; a visit can sit en_route or on_site long after), nothing is
  // re-read: a note or preference edited after arrival must not be judged.
  if (now >= stateCutoff(svc)) { out.skipped += 1; return; }
  const built = await buildVisitAccessState(svc, dbh);
  if (!built) { out.skipped += 1; return; }

  // A provider is done with this state once it holds a row for every
  // question under the current digest (a labeled or held-out row counts: it
  // is never re-answered).
  const existing = await dbh(TABLE)
    .where({ package_id: pkg.id, subject_type: SUBJECT_TYPE, subject_id: svc.id })
    .select('provider', 'question_id', 'subject_hash', 'label_status', 'sampled_for', 'jev_answer');
  const questionIds = Object.keys(pkg.questions);
  const settled = (row) => row.subject_hash === built.subjectHash || row.label_status !== 'unreviewed' || row.sampled_for === 'heldout';
  const done = (provider) => questionIds.every((id) => existing.some((row) => row.provider === provider && row.question_id === id && settled(row)));
  const due = providers.filter((provider) => !done(provider));
  if (!due.length) {
    out.unchanged += 1;
    // The refresh is idempotent and runs on unchanged passes too, so one
    // that failed after its rows were written is made good an hour later.
    await settleCohorts({ dbh, pkg, svc, built });
    return;
  }
  const retryOnly = !due.includes(PRIMARY_PROVIDER);
  const budget = retryOnly ? 'retryVisits' : 'askedVisits';
  if (out[budget] >= (retryOnly ? MAX_RETRY_VISITS : MAX_ASKED_VISITS)) { out.deferred += 1; return; }
  out[budget] += 1;
  // The state is kept before anyone is asked, so every stored answer has the
  // exact text it was judged on, whatever is edited later.
  await dbh(STATES_TABLE).insert({ scheduled_service_id: svc.id, subject_hash: built.subjectHash, state: JSON.stringify(built.state) })
    .onConflict(['scheduled_service_id', 'subject_hash']).ignore();

  const legs = (await Promise.all(due.map(async (provider) => {
    out.asked += 1;
    try {
      const result = provider === 'typesafe' ? await askPackage(PACKAGE_ID, built.state) : await askPackage(PACKAGE_ID, built.state, { provider });
      if (!result || !result.ok) { out.failed += 1; return null; }
      return { provider, answers: result.answers, result };
    } catch (err) {
      out.failed += 1;
      logger.warn(`[typed-decisions] visit access (${provider}) failed: ${err.message}`);
      return null;
    }
  }))).filter(Boolean);

  // Any provider's rows for this exact state are siblings: one that answered
  // on an earlier pass, or one since switched off. Rows for an OLDER state
  // (a switched-off provider's, once the state moved) are not: their answers
  // are about text that no longer stands.
  const asked = new Set(legs.map((leg) => leg.provider));
  const stored = [...new Set(existing.filter((row) => row.subject_hash === built.subjectHash && !asked.has(row.provider)).map((row) => row.provider))]
    .map((provider) => ({
      provider,
      answers: Object.fromEntries(existing
        .filter((row) => row.provider === provider && row.subject_hash === built.subjectHash)
        .map((row) => [row.question_id, typeof row.jev_answer === 'string' ? JSON.parse(row.jev_answer) : row.jev_answer])),
    }));

  for (const leg of legs) {
    try {
      const others = [...legs, ...stored].filter((other) => other.provider !== leg.provider);
      const siblingAnswers = {};
      for (const id of questionIds) {
        const list = others.map((other) => other.answers[id]).filter(Boolean);
        if (list.length) siblingAnswers[id] = list;
      }
      const recorded = await recordDecisions({
        capability: pkg.capability, pkg, provider: leg.provider, subjectType: SUBJECT_TYPE, subjectId: svc.id,
        result: leg.result, baselines: built.baselines, siblingAnswers, subjectHash: built.subjectHash, conn: dbh,
      });
      if (recorded.recorded > 0) out.recorded += 1; else out.failed += 1;
    } catch (err) {
      out.failed += 1;
      logger.warn(`[typed-decisions] visit access (${leg.provider}) record failed: ${err.message}`);
    }
  }

  await settleCohorts({ dbh, pkg, svc, built });
}

// The cohort of every row for THIS state, settled from the answers actually
// stored for it, with the recorder's own rule and draw and no model call. It
// covers what the recorder's lone-write rule cannot see: a stored sibling
// whose pair arrived on a later pass, a new answer that would otherwise copy
// the cohort of a switched-off provider's row for an older state, and a fresh
// answer the recorder refused to store (a labeled or held-out row keeps its
// older state and is not read here). Unreviewed rows that are not held out
// only. A queued row for an upcoming visit that is older than the daily review
// item's window (the visit was answered, moved out and came back) restarts its
// age. Idempotent: the same rows give the same result on every pass.
async function settleCohorts({ dbh, pkg, svc, built }) {
  const { sampleFor, stableDraw, TABLE } = require('./shadow-recorder');
  try {
    const persisted = await dbh(TABLE)
      .where({ package_id: pkg.id, subject_type: SUBJECT_TYPE, subject_id: svc.id, subject_hash: built.subjectHash })
      .select('id', 'capability', 'package_id', 'provider', 'subject_type', 'subject_id', 'question_id', 'jev_answer', 'label_status', 'sampled_for', 'created_at');
    const parsed = (row) => (typeof row.jev_answer === 'string' ? JSON.parse(row.jev_answer) : row.jev_answer);
    for (const row of persisted) {
      if (row.label_status !== 'unreviewed' || row.sampled_for === 'heldout') continue;
      const others = persisted.filter((other) => other.question_id === row.question_id && other.provider !== row.provider).map(parsed);
      const cohort = sampleFor(parsed(row), built.baselines[row.question_id], () => stableDraw(row), others);
      const aged = cohort !== null && Date.now() - new Date(row.created_at).getTime() > REVIEW_AGE_MS;
      if (cohort === row.sampled_for && !aged) continue;
      await dbh(TABLE).where({ id: row.id, subject_hash: built.subjectHash, label_status: 'unreviewed' })
        .whereRaw(`sampled_for IS DISTINCT FROM 'heldout'`)
        .update({ sampled_for: cohort, ...(aged ? { created_at: dbh.fn.now() } : {}) });
    }
  } catch (err) {
    logger.warn(`[typed-decisions] visit access cohort refresh failed for ${svc.id}: ${err.message}`);
  }
}

/**
 * Today's and tomorrow's open visits (Eastern), each asked once per state.
 * Gate off returns before any read. Never throws.
 *
 * `deferred` counts visits left for the next pass once MAX_ASKED_VISITS were asked.
 *
 * @returns {Promise<{considered:number, asked:number, recorded:number, unchanged:number, skipped:number, failed:number, deferred:number, skippedReason?:string}>}
 */
async function runVisitAccessSweep({ dbh = null, now = new Date() } = {}) {
  const out = { considered: 0, asked: 0, recorded: 0, unchanged: 0, skipped: 0, failed: 0, deferred: 0, askedVisits: 0, retryVisits: 0 };
  if (!visitAccessShadowLive()) return { ...out, skippedReason: 'gate_off' };
  try {
    const conn = dbh || require('../../models/db');
    const { etDateString, addETDays } = require('../../utils/datetime-et');
    const { isInternalTestCustomerId } = require('../internal-test-customers');
    const { UPCOMING_SERVICE_STATUSES } = require('../visit-context/statuses');
    const days = [etDateString(now), etDateString(addETDays(now, 1))];
    const visits = (await conn('scheduled_services as s')
      .join('customers as c', 's.customer_id', 'c.id')
      .whereNull('c.deleted_at')
      .whereIn('s.scheduled_date', days)
      .whereIn('s.status', UPCOMING_SERVICE_STATUSES)
      .orderBy('s.scheduled_date', 'asc').orderBy('s.id', 'asc')
      .select(VISIT_COLUMNS))
      .filter((svc) => !isInternalTestCustomerId(svc.customer_id));
    out.considered = visits.length;
    const providers = typedDecisionsClefLive() ? ['typesafe', 'cloudflare'] : ['typesafe'];
    const queue = [...visits];
    const worker = async () => {
      for (let svc = queue.shift(); svc; svc = queue.shift()) {
        try {
          await shadowVisit(svc, { dbh: conn, providers, out, now });
        } catch (err) {
          out.failed += 1;
          logger.warn(`[typed-decisions] visit access failed for ${svc.id}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));
  } catch (err) {
    logger.error(`[typed-decisions] visit access sweep failed: ${err.message}`);
    return { ...out, skippedReason: 'error' };
  }
  return out;
}

// The state as the reviewer reads it (already redacted): what the models saw.
function renderVisitAccessState(state) {
  const s = state.structured || {};
  return [
    `Service line: ${state.service_line || 'unknown'}. Completed visits before this one: ${state.visit_count}.`,
    `On file: pets ${s.pet_count}; codes ${s.has_codes ? 'yes' : 'no'}; contact preference ${s.contact_preference || 'none'}; away mode ${s.away_mode ? 'yes' : 'no'}; side gate noted ${s.side_gate ? 'yes' : 'no'}; neighborhood gate entry ${s.neighborhood_gate ? 'yes' : 'no'}; chemical sensitivity ${s.chemical_sensitivity ? 'yes' : 'no'}.`,
    `Notes:\n${state.notes_text || '(none)'}`,
    `Customer texts since the last visit on this line:\n${state.recent_texts || '(none)'}`,
    `Last technician note:\n${state.last_tech_notes || '(none)'}`,
  ].join('\n\n');
}

// What the review route shows and labels against: the stored state a row was
// judged on (visit_access_states), never a rebuild from data that may have
// been edited since. One read for a whole page of rows. Keyed
// `<visit id>:<digest>`; a row whose state was never stored has no entry.
async function storedVisitAccess(pairs, dbh) {
  const out = new Map();
  const ids = [...new Set(pairs.map((pair) => pair.subjectId))];
  if (!ids.length) return out;
  const hashes = new Set(pairs.map((pair) => `${pair.subjectId}:${pair.subjectHash}`));
  const rows = await dbh(`${STATES_TABLE} as v`)
    .leftJoin('scheduled_services as s', 's.id', 'v.scheduled_service_id')
    .whereIn('v.scheduled_service_id', ids)
    .select('v.scheduled_service_id', 'v.subject_hash', 'v.state', 's.scheduled_date');
  for (const row of rows) {
    const key = `${row.scheduled_service_id}:${row.subject_hash}`;
    if (!hashes.has(key)) continue;
    const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
    out.set(key, { text: renderVisitAccessState(state), at: dayString(row.scheduled_date), hash: row.subject_hash });
  }
  return out;
}

// States older than this are dropped by the sweep: the daily review item
// reads 14 days and a label is rarely given later than a few weeks.
const STATE_RETENTION_DAYS = 180;

// Retention is NOT gated: the stored states hold customer words, so they are
// dropped on schedule even after the shadow is switched off. Never throws.
async function pruneVisitAccessStates({ dbh = null, now = new Date() } = {}) {
  try {
    const conn = dbh || require('../../models/db');
    return await conn(STATES_TABLE).where('created_at', '<', new Date(now.getTime() - STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000)).del();
  } catch (err) {
    logger.warn(`[typed-decisions] visit access state prune failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  runVisitAccessSweep, pruneVisitAccessStates, buildVisitAccessState, storedVisitAccess, renderVisitAccessState, visitAccessSubjectHash,
  redactForState, stateCutoff, PACKAGE_ID, SUBJECT_TYPE,
};
