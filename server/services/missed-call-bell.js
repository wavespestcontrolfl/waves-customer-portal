/**
 * "Customer called and we missed it" bell (owner ruling 2026-08-28: the
 * bell/push/badge are for customer communication — a missed call is one).
 *
 * Runs 5 minutes after the call's terminal status (post-call hook + the
 * 2-minute sweep), so a voicemail has had time to land: a call WITH a recording is the voicemail
 * lane's (customer_voicemail_callback) and never rings here. Rings at most
 * once per call, only for an inbound call from a customer on file that no
 * human or AI agent answered. Delivery state lives in call_log.metadata:
 *   missed_call_notified_at — a LEASE (fence token; reclaimable once stale,
 *                             so a crash mid-delivery never loses the alert)
 *   missed_call_settled_at  — terminal: delivered (or superseded)
 */
const db = require('../models/db');
const logger = require('./logger');
const { isSentinelPhone, PHONE_SENTINELS } = require('./external-phone');
const { whereNotBlockedCall, phoneKeySql } = require('../middleware/spam-block');
const { whereNotSandboxCall, isInternalCallSource } = require('./voice-agent/relay-protocol');

const UNANSWERED = new Set(['missed', 'voicemail', 'unknown']);
// A row with NO answered_by (the Studio-flow status_callback fallback in
// twilio-voice-webhook.js inserts terminal calls without an outcome) counts
// as missed only when Twilio's own status says nobody picked up. A
// `completed` call with no outcome may have been handled by the flow — it
// never rings (codex r4).
const UNANSWERED_STATUSES = new Set(['no-answer', 'busy', 'canceled']);
// Lease length: covers customer lookup + delivery with margin; a stale lease
// is reclaimed by the 2-minute sweep.
const LEASE_MS = 10 * 60 * 1000;
// Time after a call's terminal update before "no recording" means "no
// voicemail": ~120s recording window + Twilio's recording callback.
const VOICEMAIL_GRACE_MS = 5 * 60 * 1000;

function outcomeUnanswered(row) {
  if (row.answered_by) return UNANSWERED.has(row.answered_by);
  return UNANSWERED_STATUSES.has(row.status);
}

// An unknown number that hung up inside the first seconds (a misdial, a
// robodialer probing the line) is not a lead. Owner ruling 2026-10-05
// (replaces the 2026-09-24 25-second rule): an unknown caller who waited 15
// seconds or more and left no message counts as a missed call someone should
// return. Customers on file ring regardless of duration, as before. In the 7
// days to 2026-10-05, nine unknown callers hung up between 20 and 24 s with
// no recording and got neither the alert nor the text-back. The missed-call
// text-back lane reads this same constant, so one value sets both.
const UNKNOWN_CALLER_MIN_SECONDS = 15;

// Unknown prospects share the missed-call lease; withheld IDs, quick
// hang-ups and Nomorobo spam stay silent.
function unknownCallerAllowed(row, opts) {
  if (!opts?.unknownCallers) return false;
  if (!(Number(row.duration_seconds) >= UNKNOWN_CALLER_MIN_SECONDS)) return false;
  // Withheld caller ID ("anonymous") is not a number anyone can call back.
  if (isSentinelPhone(row.from_phone) || String(row.from_phone || '').replace(/\D/g, '').length < 10) return false;
  if (isInternalCallSource(row.source)) return false;
  const meta = parseMeta(row.metadata);
  try {
    const nomo = meta.addons?.results?.nomorobo_spamscore;
    if (nomo?.status === 'successful' && Number(nomo.result?.score) === 1) return false;
  } catch (_e) { /* fail open — an unparseable envelope is not a spam verdict */ }
  return true;
}

// A robodialer wave (owner 2026-10-20 "yes", after the call audit): from
// 2026-09-30, 18 different 941-236-xxxx numbers called only the Google Business
// Profile lines, each hanging up near 24 s with no voicemail, and rang 11
// missed-call bells. A wave = an unknown caller on a GBP tracking line, under
// WAVE_MAX_SECONDS, whose 6-digit number block (area code + exchange) sent
// WAVE_MIN_NUMBERS or more different unknown numbers in WAVE_DAYS. A number
// on any customer phone slot is never a wave. Customers on file never reach this.
const WAVE_MAX_SECONDS = 30;
const WAVE_MIN_NUMBERS = 3;
const WAVE_DAYS = 14;
// The canonical known-caller slots (secondary_phone included; Codex #6379 r1).
const { KNOWN_CALLER_PHONE_COLS: CUSTOMER_PHONE_COLS } = require('../utils/known-caller-phone');
// North American numbers only: a 10-digit block means nothing across countries.
// A '+'-prefixed value must be +1 (Codex #6379 r6: '+4922123456' has ten digits too).
const NANP_DIGITS_SQL = (column) => `(CASE WHEN LEFT(BTRIM(COALESCE(${column}, '')), 1) = '+' THEN regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$' ELSE regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') ~ '^1{0,1}[2-9][0-9]{9}$' END)`; // {0,1}, never ?: knex reads ? as a binding
const LAST10_SQL = (column) => `right(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

// An unlinked call from a number on any customer phone slot is no robodialer.
// Full-country keys (Codex #6379 r3): +44 9415550303 on a slot is not +1 941-555-0303.
const NOT_ON_CUSTOMER_SLOT_SQL = `NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.deleted_at IS NULL AND ${phoneKeySql('call_log.from_phone')} IN (${CUSTOMER_PHONE_COLS.map((c) => phoneKeySql(`cu.${c}`)).join(', ')}))`;

// The last 10 digits of every Google Business Profile tracking line.
function gbpLines() {
  const lines = require('../config/twilio-numbers').gbpTracking || {};
  return Object.values(lines).map((l) => String(l.number || '').replace(/\D/g, '').slice(-10)).filter((d) => d.length === 10);
}

async function isRobodialerWave(row) {
  if (!row || row.customer_id) return false;
  if (!(Number(row.duration_seconds) < WAVE_MAX_SECONDS)) return false;
  const line = require('../config/twilio-numbers').findByNumber(row.to_phone);
  if (line?.type !== 'gbp_tracking') return false;
  // North American callers only (Codex #6379 r1): +44 9415550303 is not in the 941-555 block.
  const raw = String(row.from_phone || '').replace(/\D/g, '');
  const plus = String(row.from_phone || '').trim().startsWith('+');
  if (!(plus ? /^1[2-9]\d{9}$/ : /^1?[2-9]\d{9}$/).test(raw)) return false;
  const digits = raw.slice(-10);
  const at = new Date(row.created_at || Date.now());
  const found = await db('call_log')
    .modify((qb) => whereNotSandboxCall(qb))
    .where('direction', 'inbound')
    .whereNull('customer_id')
    .where('created_at', '>=', new Date(at.getTime() - WAVE_DAYS * 86400 * 1000))
    // The call itself always counts: a JS Date drops the microseconds of its
    // stored created_at, so it is matched by id rather than by time.
    .where((qb) => qb.where('created_at', '<', at).orWhere('id', row.id))
    .whereRaw(NANP_DIGITS_SQL('from_phone'))
    .whereRaw(`substr(${LAST10_SQL('from_phone')}, 1, 6) = ?`, [digits.slice(0, 6)])
    // Only wave-like calls count (Codex #6379 r3): a GBP line, under
    // WAVE_MAX_SECONDS, no recording, nobody answered. An answered, long or
    // voicemail call from the same block is a real caller, never a wave member.
    .whereRaw(`${LAST10_SQL('to_phone')} IN (${gbpLines().map(() => '?').join(', ')})`, gbpLines())
    .where('duration_seconds', '<', WAVE_MAX_SECONDS)
    .whereNull('recording_sid').whereNull('recording_url')
    // The same "unanswered" rule as the current call (outcomeUnanswered +
    // the AI-handled exclusion; Codex #6379 r4): a completed row with no
    // outcome may have been handled by the flow, so it is no wave member.
    .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    // A member whose caller later got through is a real caller (Codex #6379 r6):
    // the bell's own answered-proof called-back check, per historical row.
    .whereRaw(calledBackSql({ retire: true }))
    .whereRaw(NOT_ON_CUSTOMER_SLOT_SQL)
    .select(db.raw(`COUNT(DISTINCT ${LAST10_SQL('from_phone')}) AS n`), db.raw('COALESCE(bool_or(call_log.id = ?), false) AS self', [row.id]))
    .first();
  // The call must itself be a member (no recording, unanswered, not AI-handled,
  // not called back), not merely sit beside three members: an empty-voicemail
  // caller in a qualifying block is not a wave call.
  if (!found?.self || Number(found?.n || 0) < WAVE_MIN_NUMBERS) return false;
  // Live customers only, as findKnownCallerCustomer reads them (Codex #6379 r2).
  const customer = await db('customers')
    .whereNull('deleted_at')
    .whereRaw(`? IN (${CUSTOMER_PHONE_COLS.map((c) => phoneKeySql(c)).join(', ')})`, [`1${digits}`])
    .first('id');
  return !customer;
}

// A robodialer burst (owner 2026-10-20 "ALL"): the second robodialer pattern,
// rotating prefixes, so no 6-digit block repeats. On 2026-10-16 five different
// numbers called one GBP line, each hanging up at 53-54 s with no voicemail,
// and none ever called again. A burst member = an unknown caller (no customer
// on the call, the number on no live customer slot) on a North American number
// that never called before, unanswered by the bell's own rule, no recording,
// not handled by Sandy, and on the line for BURST_MIN_SECONDS or more. A call
// is a BURST when, on the same to_phone line in the previous 24 h (the call
// itself included), BURST_MIN_NUMBERS or more DIFFERENT numbers are members
// whose length is within BURST_DURATION_SLACK seconds of this call's, and none
// of those callers got through later. Any line type.
const BURST_MIN_SECONDS = 15;
const BURST_MIN_NUMBERS = 3;
const BURST_HOURS = 24;
const BURST_DURATION_SLACK = 1;

async function isRobodialerBurst(row) {
  if (!row || row.customer_id) return false;
  const seconds = Number(row.duration_seconds);
  if (!(seconds >= BURST_MIN_SECONDS)) return false;
  const raw = String(row.from_phone || '').replace(/\D/g, '');
  const plus = String(row.from_phone || '').trim().startsWith('+');
  if (!(plus ? /^1[2-9]\d{9}$/ : /^1?[2-9]\d{9}$/).test(raw)) return false;
  const line = String(row.to_phone || '').replace(/\D/g, '').slice(-10);
  if (line.length !== 10) return false;
  const at = new Date(row.created_at || Date.now());
  const found = await db('call_log')
    .modify((qb) => whereNotSandboxCall(qb))
    .where('direction', 'inbound')
    .whereNull('customer_id')
    .where('created_at', '>=', new Date(at.getTime() - BURST_HOURS * 3600 * 1000))
    // The call itself always counts, matched by id (see isRobodialerWave).
    .where((qb) => qb.where('created_at', '<', at).orWhere('id', row.id))
    .whereRaw(`${LAST10_SQL('to_phone')} = ?`, [line])
    .whereRaw(NANP_DIGITS_SQL('from_phone'))
    .whereBetween('duration_seconds', [Math.max(BURST_MIN_SECONDS, seconds - BURST_DURATION_SLACK), seconds + BURST_DURATION_SLACK])
    .whereNull('recording_sid').whereNull('recording_url')
    .whereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES])
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    .whereRaw(calledBackSql({ retire: true }))
    .whereRaw(NOT_ON_CUSTOMER_SLOT_SQL)
    // First call ever from that number (full-country key; any earlier row counts).
    .whereRaw(`NOT EXISTS (SELECT 1 FROM call_log prior WHERE prior.id <> call_log.id AND prior.created_at < call_log.created_at AND ${phoneKeySql('prior.from_phone')} = ${CALLER_KEY})`)
    .select(db.raw(`COUNT(DISTINCT ${LAST10_SQL('from_phone')}) AS n`), db.raw('COALESCE(bool_or(call_log.id = ?), false) AS self', [row.id]))
    .first();
  // The call must itself be a member, not merely sit beside three members.
  return Boolean(found?.self) && Number(found?.n || 0) >= BURST_MIN_NUMBERS;
}

// Both robodialer classifiers for one call. Each fails open on its own error
// (Codex #6379 r4): a classifier that cannot answer never costs a bell or a text.
async function classifySpamWave(row) {
  const attempt = (check, name) => check(row).catch((err) => {
    logger.warn(`[missed-call-bell] ${name} check failed, treating as not spam: ${err.message}`);
    return false;
  });
  const [block, burst] = await Promise.all([attempt(isRobodialerWave, 'wave'), attempt(isRobodialerBurst, 'burst')]);
  return { block, burst };
}

// The press-1 screen's exchange trigger (owner 2026-11-16 "build", after the
// spam-call audit): robodialers moved from STIR attestation B to A, so the
// B-only screen stopped 86% of silent hang-ups in the week of Aug 10 and 8% in
// the week of Nov 9. A caller is a candidate when EXCHANGE_MIN_NUMBERS or more
// OTHER unknown numbers from its 6-digit block (area code + exchange) hung up
// on us in the last EXCHANGE_DAYS: nobody answered (or the caller failed the
// screen) and no message was left. "No message" is proven, never assumed
// (Codex #7893 r1): no recording once the call ended and VOICEMAIL_GRACE_MS
// passed (the bell's own rule), or a recording whose length is known and is
// MAX_SILENT_RECORDING_SECONDS or less. A failed screen's recorder captures a
// few silent seconds, so it counts up to FAILED_SCREEN_SILENT_SECONDS: in the
// 110 days to 2026-11-16, 64 of its recordings ran 4-8 s and the 3 real
// messages 58-94 s. Without failed screens the rule would stop counting the
// very calls it screens. A recording still waiting for its length never
// counts. A member whose number got
// through later, is on a customer phone slot or is on a live lead is a real
// caller and does not count. The caller itself must be on no live lead (the
// webhook checks the customer slots). Any line. Read on the ring path, so
// bounded by a statement timeout; the webhook fails open on any error.
const EXCHANGE_MIN_NUMBERS = 2;
const EXCHANGE_DAYS = 14;
const EXCHANGE_TIMEOUT_MS = 1500;
const MAX_SILENT_RECORDING_SECONDS = 3;
const FAILED_SCREEN_SILENT_SECONDS = 10;
const FAILED_SCREEN_SQL = "metadata->>'preconnect_screen' = 'failed'";
const NOT_ON_LIVE_LEAD_SQL = `NOT EXISTS (SELECT 1 FROM leads ld WHERE ld.deleted_at IS NULL AND ${phoneKeySql('ld.phone')} = ${phoneKeySql('call_log.from_phone')})`;

// The silent hang-ups of the `days` before `at` that the exchange trigger and
// the repeat-caller rule count: an unknown North American caller nobody
// answered (or who failed the screen), no message proven as described above,
// never got through later, on no customer slot and no live lead. The voicemail
// grace runs to `checkedAt`, the time of the check, not to `at`: a redial a
// minute after a hang-up is judged minutes later, when the first call's
// recording would have landed. Both callers sit in front of a delivery (the
// ring or the bell), so the read is bounded and its caller fails open.
// The conditions apply to a read of call_log with no alias, so an inner read
// names its own row (the repeat rule's record conditions run it as one).
function whereSilentHangupBefore(qb, at, days, checkedAt) {
  return qb
    .modify((q) => whereNotSandboxCall(q))
    .where('direction', 'inbound')
    .whereNull('customer_id')
    .where('created_at', '>=', new Date(at.getTime() - days * 86400 * 1000))
    .where('created_at', '<', at)
    .whereRaw(NANP_DIGITS_SQL('from_phone'))
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    .where((outcome) => outcome
      .whereRaw(FAILED_SCREEN_SQL)
      .orWhereRaw('(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?)))', [...UNANSWERED, ...UNANSWERED_STATUSES]))
    .where((noMessage) => noMessage
      .where((none) => none
        .whereNull('recording_sid').whereNull('recording_url')
        .whereIn('status', TERMINAL_STATUSES)
        .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(checkedAt.getTime() - VOICEMAIL_GRACE_MS)]))
      .orWhere('recording_duration_seconds', '<=', MAX_SILENT_RECORDING_SECONDS)
      .orWhere((screened) => screened.whereRaw(FAILED_SCREEN_SQL).where('recording_duration_seconds', '<=', FAILED_SCREEN_SILENT_SECONDS)))
    .whereRaw(calledBackSql({ retire: true }))
    .whereRaw(NOT_ON_CUSTOMER_SLOT_SQL)
    .whereRaw(NOT_ON_LIVE_LEAD_SQL);
}

function silentHangupsBefore(at, days, checkedAt = new Date()) {
  return db('call_log').modify((qb) => whereSilentHangupBefore(qb, at, days, checkedAt))
    .timeout(EXCHANGE_TIMEOUT_MS, { cancel: true });
}

async function exchangeHangupScreenHit(fromPhone, at = new Date()) {
  const raw = String(fromPhone || '').replace(/\D/g, '');
  const plus = String(fromPhone || '').trim().startsWith('+');
  if (!(plus ? /^1[2-9]\d{9}$/ : /^1?[2-9]\d{9}$/).test(raw)) return false;
  const digits = raw.slice(-10);
  const found = await silentHangupsBefore(at, EXCHANGE_DAYS, at)
    .whereRaw(`substr(${LAST10_SQL('from_phone')}, 1, 6) = ?`, [digits.slice(0, 6)])
    .whereRaw(`${LAST10_SQL('from_phone')} <> ?`, [digits])
    .select(db.raw(`COUNT(DISTINCT ${LAST10_SQL('from_phone')}) AS n`))
    .first();
  if (Number(found?.n || 0) < EXCHANGE_MIN_NUMBERS) return false;
  const lead = await db('leads')
    .whereNull('deleted_at')
    .whereRaw(`${phoneKeySql('phone')} = ?`, [`1${digits}`])
    .timeout(EXCHANGE_TIMEOUT_MS, { cancel: true })
    .first('id');
  return !lead;
}

// A repeat silent caller (owner 2026-11-19 "YES BUILD", after the missed-call
// spam check): from 2026-11-02 two numbers in one 941 exchange called the
// Parrish, Sarasota and Venice Google Business Profile lines 10 times, about
// 24 s each with no message, and pushed 8 bells in 14 days. Two numbers are too
// few for the block wave (3), the burst (3) or the exchange trigger (2 OTHER
// numbers). This rule reads only the caller's own history, so nobody can prime
// it without calling from that very number. A repeat = an unknown caller on a
// GBP line whose same number made a silent hang-up (silentHangupsBefore) on a
// DIFFERENT GBP line, or REPEAT_MIN_PRIOR silent hang-ups on any line, in the
// last REPEAT_DAYS. The first call from a number never matches. Only history
// the carrier fully attested (STIR/SHAKEN 'TN-Validation-Passed-A', stored as
// metadata.stir_verstat by the voice webhook) counts (pre-push audit): a
// spoofed earlier call that borrowed a real person's number must never silence
// that person's own first missed call. And the number's whole record in the
// window must be silent: every other call from or to it a settled silent
// hang-up (an unattested one counts for nothing either way), the judged call
// carrying nothing more than a silent call does, and no text from it.
// Production replay of this rule, read-only, 90 days to 2026-11-19: 12 bells
// from 7 numbers match, 10 of them pushed (2 were already quiet under another
// rule); both 941-541 numbers match (7 bells); 0 real callers (no message on a
// matched call, no text from the number, no later call that got through, no
// lead, no customer).
const REPEAT_DAYS = 14;
const REPEAT_MIN_PRIOR = 2;
const FULL_ATTESTATION = 'TN-Validation-Passed-A';

// Pre-push audit rounds 2 to 8 each found one more sign of a person that the
// rule still counted: a spoofed number, a press-1 pass, a short recording, a
// pass whose stamp failed, a recording parked in metadata, a staff callback, a
// customer link, a staff acceptance whose completion write failed. A list of
// signs of a person does not end. So the rule lists what a silent hang-up
// carries instead: the columns and metadata keys set on production's 257
// silent unknown-caller calls of the 90 days to 2026-11-19 (call setup, plus
// our own bookkeeping), and nothing else. A call that carries anything more
// (a recording, a transcript, a link, a bridge, a note, a screen result, a
// staff acceptance, Sandy, or a key no silent call has) is no silent hang-up.
const SILENT_COLUMNS = [
  'id', 'direction', 'from_phone', 'to_phone', 'twilio_call_sid', 'status', 'duration_seconds',
  'answered_by', 'call_outcome', 'metadata', 'created_at', 'updated_at', 'call_recording_consent_disclaimer_played',
];
// Counters whose database default is 0; a silent call leaves them at 0.
const ZERO_COUNTER_COLUMNS = ['extraction_attempts', 'retranscribe_attempts', 'processing_generation'];
const SILENT_METADATA_KEYS = [
  // Call setup, on every inbound call.
  'addons', 'domain', 'location', 'numberType', 'screen_caller_name', 'stir_verstat', 'promise_chaser_eligible', 'ended_at',
  // This bell, its push retry, and the text-back.
  'missed_call_notified_at', 'missed_call_settled_at', 'missed_call_push_retries', 'missed_call_push_first_subs',
  'missed_call_text_leased_at', 'missed_call_text_settled_at', 'missed_call_text_outcome', 'missed_call_text_body',
  // The quiet rules' own stamps.
  'missed_call_spam_wave', 'missed_call_spam_wave_shadow', 'missed_call_spam_burst_shadow', 'missed_call_spam_repeat_shadow',
  'missed_call_screen_quiet_shadow', 'missed_call_text_spam_shadow',
  // The staff repeat-caller alert, which counts calls only.
  'repeat_caller_claim', 'repeat_caller_alerted_at', 'repeat_caller_delivery_id',
];
// The text-back's outcome, by value: only the values production's silent
// calls carry (unset, sent, or skipped for a line that cannot take a text or
// for an earlier text-back of ours). Any other value is refused. Most point at
// a person (a staff number, an existing customer, a number already contacted,
// the voicemail lane's text, an opt-out, a wrong number, a do-not-call hold);
// a failed press-1 screen comes with the screen's own key, which the shape
// refuses already (pre-push audit r11).
const SILENT_TEXT_BACK_OUTCOMES = ['sent', 'skipped:NON_MOBILE_SMS_RECIPIENT', 'skipped:SUPPRESSED_NON_MOBILE', 'skipped:already_sent_to_phone'];
const sqlNames = (names) => names.map((name) => {
  if (!/^[A-Za-z_:]+$/.test(name)) throw new Error(`not a plain name: ${name}`);
  return `'${name}'`;
}).join(', ');
// The metadata of a silent call: an object or none, only SILENT_METADATA_KEYS
// (and `extraKeys`), and those keys' values as a silent call holds them. The
// text-back outcome is unset or one of SILENT_TEXT_BACK_OUTCOMES (pre-push
// audit r11). The caller name the voice webhook saves for the press-1
// announcement (spokenCallerName) is set only when the call matched a
// customer as it came in, so a name is a known caller even after the call's
// customer link is gone; on production's unlinked inbound calls of the 90
// days to 2026-11-19 the key is JSON null on 531 and set on 5 (pre-push audit
// r18). The voice sync copies a call's metadata onto its unified-inbox
// mirror, so a mirror's metadata takes the same test (pre-push audit r19).
// Names `<table>.metadata`.
const SILENT_METADATA_SQL = (table, extraKeys = []) => `COALESCE(jsonb_typeof(${table}.metadata), 'null') IN ('null', 'object')`
  + ` AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(${table}.metadata) = 'object' THEN ${table}.metadata ELSE '{}'::jsonb END) mk`
  + ` WHERE mk NOT IN (${sqlNames([...SILENT_METADATA_KEYS, ...extraKeys])}))`
  + ` AND COALESCE(${table}.metadata->>'screen_caller_name', '') = ''`
  + ` AND COALESCE(${table}.metadata->>'missed_call_text_outcome', 'sent') IN (${sqlNames(SILENT_TEXT_BACK_OUTCOMES)})`;
// Every other column NULL, and the counters 0: a recorded length of 0 is a
// value too, from a recording callback (pre-push audit r9). Production's
// silent calls hold no other value, not even '' or false; a column added
// later with a non-NULL default makes every call non-silent (the rule then
// fails toward the push) until it is listed here. Metadata an object, or
// none, with no other key. Names call_log itself: only for a read of call_log
// with no alias.
const SILENT_SHAPE_SQL = `(NOT EXISTS (SELECT 1 FROM jsonb_each(to_jsonb(call_log) - ARRAY[${sqlNames([...SILENT_COLUMNS, ...ZERO_COUNTER_COLUMNS])}]::text[]) col`
  + " WHERE col.value <> 'null'::jsonb)"
  + ZERO_COUNTER_COLUMNS.map((column) => ` AND COALESCE(call_log.${column}, 0) = 0`).join('')
  + ` AND ${SILENT_METADATA_SQL('call_log')})`;

// A silent call: inbound, over, with the silent shape, and who answered and
// the outcome both the voicemail or not yet written: the only values on
// production's silent calls. Any other answer ('unknown' included) or outcome
// (an AI one, or a human-contact one such as 'info_given') is no silent call
// (pre-push audit r11). Built per call: the status lists are defined further
// down this file.
function silentCallSql() {
  const marks = (list) => [...list].map(() => '?').join(', ');
  return [
    "(call_log.direction = 'inbound'"
      + ` AND (call_log.answered_by = 'voicemail' OR (call_log.answered_by IS NULL AND call_log.status IN (${marks(UNANSWERED_STATUSES)})))`
      + " AND COALESCE(call_log.call_outcome, 'voicemail') = 'voicemail'"
      + ` AND call_log.status IN (${marks(TERMINAL_STATUSES)})`
      + ` AND ${SILENT_SHAPE_SQL})`,
    [...UNANSWERED_STATUSES, ...TERMINAL_STATUSES],
  ];
}

// A settled silent hang-up: a silent call past the voicemail grace at check
// time (a recording may still land before then).
function settledSilentSql(checkedAt) {
  const [sql, bindings] = silentCallSql();
  return [`(${sql} AND COALESCE(call_log.updated_at, call_log.created_at) < ?)`, [...bindings, new Date(checkedAt.getTime() - VOICEMAIL_GRACE_MS)]];
}

// The judged call's qualifying history, on a read of call_log with no alias:
// the number's settled silent hang-ups before the call in the last
// REPEAT_DAYS, the carrier fully attested. The history read and the record
// conditions the stamp applies share it (pre-push audit r17).
function wherePriorSilentHangup(qb, row, key, at, checkedAt) {
  const [settledSql, settledBindings] = settledSilentSql(checkedAt);
  return qb.modify((q) => whereSilentHangupBefore(q, at, REPEAT_DAYS, checkedAt))
    .whereNot('call_log.id', row.id)
    .whereRaw(`${CALLER_KEY} = ?`, [key])
    .whereRaw("call_log.metadata->>'stir_verstat' = ?", [FULL_ATTESTATION])
    .whereRaw(settledSql, settledBindings);
}

// A history call on a GBP line other than the judged call's: [sql, bindings].
function otherGbpLineSql(row) {
  const lines = gbpLines().filter((d) => d !== String(row.to_phone || '').replace(/\D/g, '').slice(-10));
  return lines.length ? [`${LAST10_SQL('call_log.to_phone')} IN (${lines.map(() => '?').join(', ')})`, lines] : ['false', []];
}

// The number's whole record, as conditions on the judged call's own row. The
// check's read and the repeat quiet stamp's update both apply them, so nothing
// the check read can change before the stamp: a change that lands in between
// leaves the stamp matching no row, and the push goes (pre-push audit r13,
// r14). Bounded like the history read (14 days). The conditions:
//  - the history that qualified the call still holds: a prior settled silent
//    hang-up on another GBP line, or REPEAT_MIN_PRIOR of them on any line
//    (wherePriorSilentHangup; pre-push audit r17);
//  - the judged call is still a silent call (a late write can mark it
//    answered after the bell read it; pre-push audit r10), with no grace test:
//    the bell itself rings 5 minutes after the terminal status;
//  - no staff row (technician or admin, any status) has the number's phone,
//    read from the table itself: the cached staff-sender list answers "not
//    staff" when its gate is off or its read failed (pre-push audit r12);
//  - every other call from or to the number, from the window start on, is a
//    settled silent hang-up (IS NOT TRUE: a NULL blocks too). From the window
//    start on, not to the judged call: a staff callback can come between the
//    call and its bell (pre-push audit r9);
//  - no text from or to it but our own text-back in the text log
//    (message_type as in missed-call-text-back.js; as the text-back's
//    contactState reads contact; pre-push audit r11), in any status: a staff
//    reply still sending (its reservation, the only row while the provider's
//    outcome is unknown) or scheduled is contact too, so no reservation filter
//    applies (pre-push audit r18);
//  - in the unified inbox, which the SMS webhook writes first and the text log
//    only as best effort (pre-push audit r14), nothing in the window but
//    mirrors of silent calls and our text-back, on threads linked to no
//    customer. A message is the number's by its own SMS address, else its
//    thread's phone; a call's mirror is found from the number's calls by the
//    call's sid, since a voice mirror carries no phone and promoting an
//    unknown thread to a customer clears the thread's (pre-push audit r16).
//    Both reads stay in the window and start from indexed columns where one
//    exists: the calls by created_at, their mirrors by twilio_sid (pre-push
//    audit r17). A mirror of a silent call holds only the columns
//    the matched numbers' mirrors of the 90 days to 2026-11-19 hold
//    (SILENT_MIRROR_COLUMNS; body, recording and the rest NULL), no media,
//    the voicemail or no answer, a customer author, and a silent call's
//    metadata (SILENT_METADATA_SQL, keys and values): a transcript in the body
//    or audio in the media is a message (pre-push audit r15). A mirror is the
//    voice sync's copy of a call, so it counts only when the call with its
//    sid still exists and is a silent call, a length only as that call's own
//    (on production all 267 mirrors of unlinked calls that hold a length are
//    of recorded calls, and every mirror has its call; pre-push audit r19).
//    And no thread with the number's phone is linked to a customer, at any
//    time;
//  - the number is on no customer slot and no live lead, as in the history
//    read: staff can save the caller between the check and the stamp
//    (pre-push audit r15).
// The inner reads name call_log without an alias: inside them it is the inner
// table, and the judged call is excluded by its id.
const SILENT_MIRROR_COLUMNS = ['id', 'conversation_id', 'channel', 'direction', 'author_type', 'twilio_sid', 'answered_by',
  'delivery_status', 'metadata', 'media', 'is_read', 'read_at', 'read_by_admin_user_id', 'created_at', 'updated_at', 'duration_seconds'];
// A mirror of a silent call, or our text-back, as one condition on a
// unified-inbox message (alias m): [sql, bindings]. Built per call, like
// silentCallSql, which it uses.
function inboxSilentSql() {
  const [silentCall, bindings] = silentCallSql();
  return ["((m.channel = 'voice' AND m.direction = 'inbound'"
    + ` AND NOT EXISTS (SELECT 1 FROM jsonb_each(to_jsonb(m) - ARRAY[${sqlNames(SILENT_MIRROR_COLUMNS)}]::text[]) col WHERE col.value <> 'null'::jsonb)`
    + " AND COALESCE(m.author_type, 'customer') = 'customer'"
    + " AND COALESCE(m.answered_by, 'voicemail') = 'voicemail'"
    + " AND COALESCE(m.media, '[]'::jsonb) = '[]'::jsonb"
    + ` AND ${SILENT_METADATA_SQL('m', ['source'])}`
    + " AND COALESCE(m.metadata->>'source', 'voice_message_sync') = 'voice_message_sync'"
    // A voice mirror is the voice sync's copy of a call (its transcript,
    // recording, length, answer, status, media and metadata), so it counts
    // only as the mirror of a call that still exists and is a silent call,
    // and holds no more than that copy: a length only as the call's own (the
    // sync copies it, or the recording's when the call has none). A mirror
    // whose call is gone is contact (pre-push audit r19).
    + ' AND EXISTS (SELECT 1 FROM call_log WHERE call_log.twilio_call_sid = m.twilio_sid'
    + ` AND ${silentCall} AND (m.duration_seconds IS NULL OR m.duration_seconds = call_log.duration_seconds)))`
    + " OR (m.channel = 'sms' AND m.direction = 'outbound' AND m.message_type = 'missed_call_text_back'"
    + " AND COALESCE(m.author_type, 'system') = 'system'))", bindings];
}
// The phone a unified-inbox message (alias m, its thread c) is with: its own SMS
// address first, then its thread's, as admin-alert-contact-witnesses.js and
// sms-response-policy.js read it.
const MESSAGE_PEER_SQL = phoneKeySql("COALESCE(NULLIF(m.metadata->>'sms_contact_phone', ''), NULLIF(c.contact_phone, ''))");
function silentRecordClauses(row, key, at, checkedAt) {
  const since = new Date(at.getTime() - REPEAT_DAYS * 86400 * 1000);
  const [settledSql, settledBindings] = settledSilentSql(checkedAt);
  const [otherLineSql, otherLines] = otherGbpLineSql(row);
  const [inboxSilent, inboxBindings] = inboxSilentSql();
  const priorSilent = (qb) => wherePriorSilentHangup(qb.select(1).from('call_log'), row, key, at, checkedAt);
  return (qb) => qb
    .whereRaw(...silentCallSql())
    // EXISTS with an OFFSET: at least REPEAT_MIN_PRIOR rows.
    .where((qualified) => qualified
      .whereExists(function crossLine() { priorSilent(this).whereRaw(otherLineSql, otherLines); })
      .orWhereExists(function enough() { priorSilent(this).offset(REPEAT_MIN_PRIOR - 1); }))
    .whereNotExists(function staffPhone() {
      this.select(1).from('technicians').whereRaw(`${phoneKeySql('technicians.phone')} = ?`, [key]);
    })
    .whereNotExists(function otherCall() {
      this.select(1).from('call_log')
        .modify((inner) => whereNotSandboxCall(inner))
        .whereNot('call_log.id', row.id)
        .where('call_log.created_at', '>=', since)
        .where((number) => number
          .whereRaw(`${CALLER_KEY} = ?`, [key])
          .orWhereRaw(`${phoneKeySql('call_log.to_phone')} = ?`, [key]))
        .whereRaw(`${settledSql} IS NOT TRUE`, settledBindings);
    })
    .whereNotExists(function loggedText() {
      this.select(1).from('sms_log as s')
        .where('s.created_at', '>=', since)
        .where((number) => number
          .whereRaw(`${phoneKeySql('s.from_phone')} = ?`, [key])
          .orWhereRaw(`${phoneKeySql('s.to_phone')} = ?`, [key]))
        .whereRaw("(s.direction = 'outbound' AND s.message_type = 'missed_call_text_back') IS NOT TRUE");
    })
    .whereNotExists(function inboxMessage() {
      this.select(1).from('messages as m').join('conversations as c', 'c.id', 'm.conversation_id')
        .where('m.created_at', '>=', since)
        .whereRaw(`${MESSAGE_PEER_SQL} = ?`, [key])
        .whereRaw(`(${inboxSilent} AND c.customer_id IS NULL) IS NOT TRUE`, inboxBindings);
    })
    .whereNotExists(function callMirror() {
      this.select(1).from('call_log as vc')
        .join('messages as m', 'm.twilio_sid', 'vc.twilio_call_sid')
        .join('conversations as c', 'c.id', 'm.conversation_id')
        .where('vc.created_at', '>=', since)
        .where((number) => number
          .whereRaw(`${phoneKeySql('vc.from_phone')} = ?`, [key])
          .orWhereRaw(`${phoneKeySql('vc.to_phone')} = ?`, [key]))
        .whereRaw(`(${inboxSilent} AND c.customer_id IS NULL) IS NOT TRUE`, inboxBindings);
    })
    .whereNotExists(function linkedConversation() {
      this.select(1).from('conversations as c')
        .whereNotNull('c.customer_id')
        .whereRaw(`${phoneKeySql('c.contact_phone')} = ?`, [key]);
    })
    .whereRaw(NOT_ON_CUSTOMER_SLOT_SQL)
    .whereRaw(NOT_ON_LIVE_LEAD_SQL);
}

// Read only once the history matched. Returns the record conditions for the
// stamp, or null. One of our own lines or a staff forward (config, not the
// database; pre-push audit r11) is never a robocaller.
async function recordIsSilent(row, key, at, checkedAt) {
  if (require('../config/twilio-numbers').isInternalNumber(`+${key}`)) return null;
  const clauses = silentRecordClauses(row, key, at, checkedAt);
  const judged = await db('call_log').where('id', row.id).modify(clauses)
    .timeout(EXCHANGE_TIMEOUT_MS, { cancel: true }).first('id');
  return judged ? clauses : null;
}

// The repeat check: null, or the record conditions the quiet stamp applies.
async function repeatSilentCaller(row) {
  if (!row || row.customer_id) return null;
  const line = require('../config/twilio-numbers').findByNumber(row.to_phone);
  if (line?.type !== 'gbp_tracking') return null;
  const raw = String(row.from_phone || '').replace(/\D/g, '');
  const plus = String(row.from_phone || '').trim().startsWith('+');
  if (!(plus ? /^1[2-9]\d{9}$/ : /^1?[2-9]\d{9}$/).test(raw)) return null;
  const key = `1${raw.slice(-10)}`;
  const at = new Date(row.created_at || Date.now());
  const checkedAt = new Date();
  // The shared read also admits a short recording (0 s included, with no
  // grace) and a failed screen; the settled silent test admits neither.
  const [otherLineSql, otherLines] = otherGbpLineSql(row);
  const found = await db('call_log').modify((qb) => wherePriorSilentHangup(qb, row, key, at, checkedAt))
    .select(db.raw('COUNT(*) AS n'), db.raw(`COALESCE(bool_or(${otherLineSql}), false) AS other_line`, otherLines))
    .timeout(EXCHANGE_TIMEOUT_MS, { cancel: true })
    .first();
  if (!(found?.other_line || Number(found?.n || 0) >= REPEAT_MIN_PRIOR)) return null;
  return recordIsSilent(row, key, at, checkedAt);
}

async function isRepeatSilentCaller(row) {
  return Boolean(await repeatSilentCaller(row));
}

const spamGateOn = (name) => require('../config/feature-gates').isEnabled(name);

// What the recording processor writes when a recording holds no speech: the
// rejected-transcription sentinel (call-recording-processor.js
// TRANSCRIPTION_REJECTED_SENTINEL) or the transcriber's own dead-air markers.
const NO_SPEECH_MARKER_RE = /\[(?:VOICEMAIL|NO SPEECH)\]|\[Recording had no usable speech;[^\]]*\]/gi;

/**
 * Pure: did the caller reach the voicemail greeting, wait, and hang up
 * without saying anything? True only when a recording exists AND the
 * processor has FINISHED with it and found no speech: transcription_status
 * 'rejected' (an implausible transcript thrown out) with no real text left,
 * or a 'completed' transcript that is nothing but the no-speech markers.
 * A recording still awaiting transcription is NOT empty — its voicemail may
 * yet hold a message — so it stays the voicemail lane's.
 */
function isEmptyVoicemailRecording(row) {
  if (!row || !(row.recording_sid || row.recording_url)) return false;
  const status = String(row.transcription_status || '').toLowerCase();
  const text = typeof row.transcription === 'string' ? row.transcription : '';
  const residue = text.replace(NO_SPEECH_MARKER_RE, '').replace(/[^\p{L}\p{N}]/gu, '');
  if (status === 'rejected') return residue === '';
  if (status === 'completed') return text.search(NO_SPEECH_MARKER_RE) !== -1 && residue === '';
  return false;
}

// Missed-call bell gaps (owner 2026-10-20). Both are admitted only through the
// opts the bell passes under its own gates, so the text-back lane, which shares
// missedCallShapeEligible, never sees them.
//   customerEmptyVoicemail (GATE_MISSED_CALL_EMPTY_VM_CUSTOMER): a customer on
//     file whose recording held no speech counts as "no message left".
//   noOutcomeCustomer (GATE_MISSED_CALL_NO_OUTCOME_CUSTOMER): a customer's
//     `completed` call with no answered_by and no recording counts as unanswered.
function emptyRecordingAdmitted(row, opts) {
  if (!isEmptyVoicemailRecording(row)) return false;
  return Boolean(opts?.emptyVoicemail || (opts?.customerEmptyVoicemail && row.customer_id));
}

const AI_OUTCOMES = new Set(['ai_handled', 'ai_transferred']);
function noOutcomeCustomerCall(row) {
  return Boolean(row.customer_id) && !row.answered_by && row.status === 'completed'
    && !(row.recording_sid || row.recording_url) && !AI_OUTCOMES.has(row.call_outcome);
}
// outcomeUnanswered stays one-argument: repeat-caller-bell passes it to Array.filter.
function outcomeUnansweredFor(row, opts) {
  return outcomeUnanswered(row) || Boolean(opts?.noOutcomeCustomer && noOutcomeCustomerCall(row));
}

// The gap options, read per call so a flip needs no restart.
function gapOptions() {
  const { isEnabled } = require('../config/feature-gates');
  return {
    customerEmptyVoicemail: isEnabled('missedCallEmptyVmCustomer'),
    noOutcomeCustomer: isEnabled('missedCallNoOutcomeCustomer'),
  };
}

// The SQL twin of outcomeUnansweredFor, shared by the claim and the sweep.
// Gate off (or B off) it is the original clause, byte for byte.
const UNANSWERED_SQL_HEAD = '(answered_by IN (?, ?, ?) OR (answered_by IS NULL AND status IN (?, ?, ?))';
function unansweredClause(gaps) {
  const sql = gaps?.noOutcomeCustomer
    ? `${UNANSWERED_SQL_HEAD} OR (answered_by IS NULL AND status = 'completed' AND customer_id IS NOT NULL AND recording_sid IS NULL AND recording_url IS NULL))`
    : `${UNANSWERED_SQL_HEAD})`;
  return [sql, [...UNANSWERED, ...UNANSWERED_STATUSES]];
}

// "No voicemail yet" in SQL. Gate A on and the call is a customer's empty
// voicemail: the claim pins the very recording and transcription state that
// was read as empty, so a newer recording or a re-transcription loses the race.
function emptyVmCustomerAdmitted(row, gaps) {
  return Boolean(gaps?.customerEmptyVoicemail && row?.customer_id && isEmptyVoicemailRecording(row));
}
function recordingFilter(row, admitted) {
  return (qb) => {
    if (!admitted) return qb.whereNull('recording_sid').whereNull('recording_url');
    return qb.whereNotNull('customer_id')
      .whereRaw('recording_sid IS NOT DISTINCT FROM ?::text', [row.recording_sid])
      .whereRaw('recording_url IS NOT DISTINCT FROM ?::text', [row.recording_url])
      .whereRaw('transcription_status IS NOT DISTINCT FROM ?::text', [row.transcription_status])
      // The text too: a markers-only transcript replaced by real speech on the
      // same recording and status is a voicemail, not an empty one.
      .whereRaw('transcription IS NOT DISTINCT FROM ?::text', [row.transcription]);
  };
}
// The sweep cannot know a row yet: with gate A on it also lists a customer's
// recording the processor finished with as rejected or as markers only; the
// JS shape check decides. Gate off it is the original two whereNull calls.
function sweepRecordingFilter(gaps) {
  return (qb) => {
    if (!gaps?.customerEmptyVoicemail) return qb.whereNull('recording_sid').whereNull('recording_url');
    return qb.where((g) => g
      .where((none) => none.whereNull('recording_sid').whereNull('recording_url'))
      .orWhere((vm) => vm.whereNotNull('customer_id')
        .where((t) => t.where('transcription_status', 'rejected')
          .orWhere((c) => c.where('transcription_status', 'completed').whereRaw("transcription LIKE '%[%'")))));
  };
}

/**
 * Pure: is this an inbound call nobody answered that no other lane owns?
 * The call's own shape only — never the bell's delivery state, so
 * missed-call-text-back.js (its own lease/settle keys) can share the rule
 * without the bell's settled alert hiding the call from it.
 *
 * `opts.emptyVoicemail` (text-back lane only, behind its own gate): a
 * recording that held no speech counts as "no message left". The bell never
 * passes it, so the bell's behavior is unchanged.
 */
function missedCallShapeEligible(row, opts = {}) {
  if (!row || row.direction !== 'inbound') return false;
  if (!row.customer_id && !unknownCallerAllowed(row, opts)) return false;
  if ((row.recording_sid || row.recording_url) && !emptyRecordingAdmitted(row, opts)) return false; // voicemail lane owns it
  if (row.voicemail_callback_alerted_at) return false;                // voicemail lane already rang
  if (row.call_outcome === 'ai_handled' || row.call_outcome === 'ai_transferred') return false; // Sandy handled it / handed it to a person
  if (!outcomeUnansweredFor(row, opts)) return false;                 // human / ai_agent / unknown-outcome
  return true;
}

/** Pure eligibility — exported for tests. */
function missedCallEligible(row, now = Date.now(), opts = {}) {
  if (!missedCallShapeEligible(row, opts)) return false;
  const meta = parseMeta(row.metadata);
  if (meta.missed_call_settled_at) return false;                      // delivered / superseded
  if (meta.missed_call_notified_at && !leaseStale(meta.missed_call_notified_at, now)) return false; // live lease
  return true;
}

// The caller already got through on a later call: a person or Sandy
// answered it, the voicemail lane rang for it, or we called back and their
// leg was dialed (bridged_at). A redial seconds later is the common case
// (2026-10-03 and 10-05: the redial was answered, the first attempt still
// rang). A recording alone is not proof: a dead-air voicemail rings nothing.
// Excluded in both the claim and the sweep, so such a call is never offered.
const LATER_KEY = phoneKeySql('later.from_phone');
const CALLER_KEY = phoneKeySql('call_log.from_phone');
const buildCalledBackSql = (outboundProof) => 'NOT EXISTS (SELECT 1 FROM call_log later'
  + ' WHERE later.id <> call_log.id AND later.created_at >= call_log.created_at'
  + " AND COALESCE(later.source, '') <> 'voice_relay_sandbox'"
  + ` AND ((later.direction = 'outbound' AND later.bridged_at IS NOT NULL${outboundProof} AND ${phoneKeySql('later.to_phone')} = ${CALLER_KEY})`
  + ` OR (later.direction = 'inbound' AND ${LATER_KEY} = ${CALLER_KEY}`
  + " AND (later.answered_by IN ('human', 'ai_agent') OR later.call_outcome IN ('ai_handled', 'ai_transferred')"
  + ' OR later.voicemail_callback_alerted_at IS NOT NULL))))';
const CALLED_BACK_SQL = buildCalledBackSql('');

// GATE_CALLBACK_NEEDS_ANSWER (owner 2026-10-20): bridged_at is stamped when the
// STAFF leg presses 1, before the customer leg is dialed, so a callback that
// rang out counted as "called back". With the gate on an outbound call counts
// only with proof the customer answered:
//  - the customer leg the <Dial action> recorded completed with seconds > 0
//    (metadata.customer_leg; call-commitments.js reads the same shape); or
//  - no customer_leg (it is written on a minority of bridged calls) and a
//    recording of the call: the bridge records from answer
//    (record-from-answer-dual), so a recording exists only once the customer
//    leg picked up. The parent-leg duration_seconds proves nothing: it holds
//    the 8 s press-1 prompt plus the whole 30 s ring, so a callback that rang
//    out lasts longer than any sensible "answered" threshold; or
//  - (claim, sweep and push re-read only, never retire) no customer_leg and the
//    bridged call is still in flight (status stays 'bridged' until the status
//    callback ends it): it may be live now, and the sweep looks again in 2
//    minutes. Capped at 15 minutes from the bridge.
// No literal question mark: knex reads one as a binding.
const CUSTOMER_LEG_SECONDS_SQL = "CASE WHEN later.metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$' THEN (later.metadata->'customer_leg'->>'duration_seconds')::numeric > 0 ELSE FALSE END";
const CALLED_BACK_ANSWERED_SQL = buildCalledBackSql(
  " AND ((later.metadata->'customer_leg'->>'status' = 'completed' AND " + CUSTOMER_LEG_SECONDS_SQL + ')'
  + " OR (later.metadata->'customer_leg' IS NULL AND later.recording_duration_seconds > 0 AND (later.recording_sid IS NOT NULL OR later.recording_url IS NOT NULL)))");
// The same proof plus a bridged call still in flight. For the claim, the sweep
// and the re-read before the push ONLY (do not ring during a live callback;
// the sweep looks again in 2 minutes). Never for retiring a bell: a callback
// still ringing may go unanswered, and a retired bell does not come back.
const CALLED_BACK_DEFER_SQL = buildCalledBackSql(
  " AND ((later.metadata->'customer_leg'->>'status' = 'completed' AND " + CUSTOMER_LEG_SECONDS_SQL + ')'
  + " OR (later.metadata->'customer_leg' IS NULL AND later.recording_duration_seconds > 0 AND (later.recording_sid IS NOT NULL OR later.recording_url IS NOT NULL))"
  + " OR (later.metadata->'customer_leg' IS NULL AND later.status = 'bridged' AND later.bridged_at > now() - interval '15 minutes'))");
// Read at call time, so the claim, the sweep, the re-read before the push and
// the retire pass all follow one gate. `retire` asks for proof of an answered leg.
function calledBackSql({ retire = false } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callbackNeedsAnswer')) return CALLED_BACK_SQL;
  return retire ? CALLED_BACK_ANSWERED_SQL : CALLED_BACK_DEFER_SQL;
}

// GATE_MISSED_CALL_VISIT_UNDERWAY (owner 2026-10-21): a customer on file called
// at 1:05 PM and nobody answered; the tech went en route 1:46, arrived 1:59 and
// the invoice was paid 2:32. That bell should not have rung. The call's customer
// has a visit that moved (en route, arrived or completed) or an invoice that was
// paid AFTER the call, on the same ET day. True = the visit is underway, so the
// bell is retired / never rings / is never re-pushed. Written against the
// unaliased `call_log` row, like calledBackSql. No literal question mark here
// (knex reads one as a binding). "Paid" is the codebase's own: invoices.paid_at.
const ET_DAY = (col) => `(${col} AT TIME ZONE 'America/New_York')::date`;
const VISIT_UNDERWAY_SQL = '(call_log.customer_id IS NOT NULL AND ('
  + 'EXISTS (SELECT 1 FROM scheduled_services vss WHERE vss.customer_id = call_log.customer_id'
  + ` AND ((vss.en_route_at > call_log.created_at AND ${ET_DAY('vss.en_route_at')} = ${ET_DAY('call_log.created_at')})`
  + ` OR (vss.arrived_at > call_log.created_at AND ${ET_DAY('vss.arrived_at')} = ${ET_DAY('call_log.created_at')})`
  + ` OR (vss.completed_at > call_log.created_at AND ${ET_DAY('vss.completed_at')} = ${ET_DAY('call_log.created_at')})))`
  + ' OR EXISTS (SELECT 1 FROM invoices vinv WHERE vinv.customer_id = call_log.customer_id'
  + ` AND vinv.paid_at > call_log.created_at AND ${ET_DAY('vinv.paid_at')} = ${ET_DAY('call_log.created_at')})))`;
const visitUnderwayOn = () => require('../config/feature-gates').isEnabled('missedCallVisitUnderway');
// Gate off = null: callers add nothing, so the SQL is byte-identical to before.
function visitUnderwaySql() {
  return visitUnderwayOn() ? VISIT_UNDERWAY_SQL : null;
}
// knex .modify() helper: keep only calls whose customer's visit has not moved.
function whereNoVisitUnderway(qb) {
  const sql = visitUnderwaySql();
  if (sql) qb.whereRaw(`NOT ${sql}`);
}

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

function leaseStale(token, now = Date.now()) {
  const t = new Date(token).getTime();
  return !Number.isFinite(t) || now - t > LEASE_MS;
}

// What a robodialer call does to the bell: it QUIETS the push and keeps the bell
// row; no spam rule ever removes delivery evidence (Codex #6392 r1 and r2: a
// caller can prime a number block or a line and length with fresh numbers so a
// genuine first-time prospect matches, and real people who hang up at the beep
// cluster on one length). Returns true when the push must be skipped.
//  - Block wave with GATE_MISSED_CALL_SPAM_WAVE on: stamped missed_call_spam_wave: 'block_quiet'.
//  - Burst with GATE_MISSED_CALL_SPAM_BURST on: stamped 'burst_quiet'.
//  - A repeat silent caller with GATE_MISSED_CALL_SPAM_REPEAT on: stamped 'repeat_quiet'.
//  - An unknown caller who failed the press-1 screen (no key; owner 2026-11-16
//    "build") with GATE_CALL_SCREEN_EXCHANGE_HISTORY on: stamped 'screen_quiet'.
//    Since October 12 of 16 such calls pushed; the screen kept them off the
//    staff phones but not off the admin app.
//  - A flagged call whose gate is off rings as before, stamped with the rule's
//    shadow key below.
// The row settles normally after delivery. `fenced` is the caller's lease-fenced update.
// One row per rule, in precedence order: the flag, its gate, the quiet stamp, the shadow stamp.
const QUIET_RULES = [
  { flag: 'block', gate: 'missedCallSpamWave', quiet: 'block_quiet', shadow: 'missed_call_spam_wave_shadow' },
  { flag: 'burst', gate: 'missedCallSpamBurst', quiet: 'burst_quiet', shadow: 'missed_call_spam_burst_shadow' },
  { flag: 'repeat', gate: 'missedCallSpamRepeat', quiet: 'repeat_quiet', shadow: 'missed_call_spam_repeat_shadow' },
  { flag: 'screen', gate: 'callScreenExchangeHistory', quiet: 'screen_quiet', shadow: 'missed_call_screen_quiet_shadow' },
];

async function quietRobodialerPush(row, fenced) {
  const flags = {
    ...(await classifySpamWave(row)), // fails open inside
    repeat: await repeatSilentCaller(row).catch((err) => {
      // A code only: a Knex error echoes the bound values, here the caller's number.
      logger.warn(`[missed-call-bell] repeat check failed, treating as not spam: ${err?.code || err?.name || 'error'}`);
      return null;
    }),
    screen: !row.customer_id && parseMeta(row.metadata).preconnect_screen === 'failed',
  };
  const stamps = {};
  let quietAs = null;
  for (const rule of QUIET_RULES.filter((r) => flags[r.flag])) {
    if (!spamGateOn(rule.gate)) stamps[rule.shadow] = true;
    else quietAs = quietAs || rule.quiet;
  }
  if (quietAs) stamps.missed_call_spam_wave = quietAs;
  // This pass's decision replaces one an earlier pass of the call left (its
  // delivery failed, or it died before its bell), so the call's marker is the
  // latest decision (pre-push audit r16). The re-push reads each bell's own
  // decision (payload.pushQuieted), so a failed clear changes no push (r17).
  await fenced().whereRaw("metadata->>'missed_call_spam_wave' IS NOT NULL")
    .update({ metadata: db.raw("metadata - 'missed_call_spam_wave'") }).catch(() => 0);
  if (!Object.keys(stamps).length) return false;
  // Quiet only when the marker is durable: the re-push recognises a quiet call by
  // it. A failed or empty stamp write fails open (the push goes as usual). A
  // repeat quiet is written only while the number's whole record still holds
  // (silentRecordClauses, the check's own conditions, in the same statement):
  // a customer link, a note, an answer, a staff call or text, or a reply that
  // lands after the check read the record matches no row, and the push goes
  // (pre-push audit r13, r14). It has the reads' time limit.
  const write = quietAs === 'repeat_quiet'
    ? fenced().modify(flags.repeat).timeout(EXCHANGE_TIMEOUT_MS, { cancel: true })
    : fenced();
  const stamped = await write.update({ metadata: db.raw('metadata || ?::jsonb', [JSON.stringify(stamps)]) }).catch(() => 0);
  return Boolean(quietAs) && stamped === 1;
}

// A quiet call writes its bell row but never pushes; every other call keeps the
// supersession check. The push is stopped only once THIS pass wrote the bell row
// (`bellWritten`, from the trigger's onBell, which fires before the push): with no
// durable row the push is the only channel, so it goes (fail open). `false` stops the push.
const pushGuard = (quiet, stillMissed, bellWritten) => (quiet ? async (arg) => (bellWritten() ? false : stillMissed(arg)) : stillMissed);

// Shadow for gates A and B while they are off: stamp
// metadata.missed_call_gap_shadow on a call the gate WOULD have rung, once, so
// the owner can read how many a flip changes before making it. No bell, no
// settle, no updated_at change (the sweep's voicemail grace reads updated_at).
const SHADOW_KEY = 'missed_call_gap_shadow';
const SHADOW_LIMIT = 50;
async function stampGapShadows(gaps, now) {
  try {
    if (!gaps.customerEmptyVoicemail) {
      await stampShadow('empty_vm_customer', { customerEmptyVoicemail: true }, now, (q) => q
        .where((r) => r.whereNotNull('recording_sid').orWhereNotNull('recording_url'))
        .whereIn('transcription_status', ['rejected', 'completed']));
    }
    if (!gaps.noOutcomeCustomer) {
      await stampShadow('no_outcome_customer', { noOutcomeCustomer: true }, now, (q) => q
        .whereNull('answered_by').where('status', 'completed').whereNull('recording_sid').whereNull('recording_url'));
    }
  } catch (err) {
    logger.warn(`[missed-call-bell] gap shadow failed: ${err.message}`);
  }
}

async function stampShadow(kind, shapeOpts, now, narrow) {
  const rows = await db('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .modify(whereNotBlockedCall)
    .where({ direction: 'inbound' })
    .whereNotNull('customer_id')
    .whereIn('status', TERMINAL_STATUSES)
    .whereNull('voicemail_callback_alerted_at')
    .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
    .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
    .whereRaw(`COALESCE(metadata->>'${SHADOW_KEY}','') = ''`)
    .whereRaw(calledBackSql())
    .where('created_at', '>', new Date(now - 24 * 60 * 60 * 1000))
    .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
    .modify(narrow)
    .orderBy('created_at', 'desc')
    .limit(SHADOW_LIMIT);
  const ids = rows.filter((r) => missedCallEligible(r, now, shapeOpts)).map((r) => r.id);
  if (!ids.length) return 0;
  return db('call_log').whereIn('id', ids).modify((q) => whereNotSandboxCall(q))
    .whereRaw(`COALESCE(metadata->>'${SHADOW_KEY}','') = ''`)
    .update({ metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${SHADOW_KEY}', ?::text)`, [kind]) });
}

// GATE_MISSED_CALL_PUSH_CHECK (owner 2026-10-20): the bell used to settle as
// soon as its row was written, even when the push reached no phone. Pass 1
// that finds the push dead (a subscription existed, none was sent, none was
// merely skipped) releases the lease and records missed_call_push_retries, so
// the 2-minute sweep offers the call once more, push only. Pass 2 settles
// whatever happens and, when the push is dead again, raises one admin alert
// per ET day.
// firstPassSubs: on the retry pass, how many subscriptions pass 1 found. Expired
// ones are deactivated by the push service, so the retry can find none left;
// that still means the push reached no phone either time.
function pushReachedNoPhone(stats, firstPassSubs = 0) {
  const push = stats?.push;
  return Boolean(push) && (Number(push.subscriptions || 0) > 0 || firstPassSubs > 0)
    && Number(push.sent || 0) === 0 && Number(push.skipped || 0) === 0;
}

async function raisePushDeadAlert(row) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { etDateString } = require('../utils/datetime-et');
  return raiseAdminAlert('alert', {
    area: 'System',
    action: 'Missed-call push reached no phone',
    why: 'A missed-call alert rang the bell, but no phone received the push after two tries.',
    severity: 'needs-you',
    link: `/admin/communications#tab=calls&call=${encodeURIComponent(row.id)}`,
    subject: { type: 'check', id: 'missed_call_push' },
    doneWhen: 'push_reaches_a_phone',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: `missed-call-push-no-phone:${etDateString()}`,
    metadata: { callLogId: row.id },
  });
}

// The push-retry state a claim won: whether pass 1 left a retry pending and how
// many subscriptions it found.
function pushRetryState(metadata) {
  const meta = parseMeta(metadata);
  return {
    pushRetry: Number(meta.missed_call_push_retries || 0) >= 1,
    firstPassSubs: Number(meta.missed_call_push_first_subs || 0),
  };
}

async function holdForPushRetry({ row, stats, fenced, pushRetry, firstPassSubs }) {
  if (pushRetry) {
    if (pushReachedNoPhone(stats, firstPassSubs)) await raisePushDeadAlert(row).catch((err) => logger.warn(`[missed-call-bell] push alert failed: ${err.message}`));
    return false;
  }
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('missedCallPushCheck') || !stats?.bellWritten || !pushReachedNoPhone(stats)) return false;
  await fenced().update({ metadata: db.raw("(metadata - 'missed_call_notified_at') || jsonb_build_object('missed_call_push_retries', 1, 'missed_call_push_first_subs', ?::int)", [Number(stats.push.subscriptions)]) });
  return true;
}

// True when the bell write was suppressed only because a callback is in flight
// (GATE_CALLBACK_NEEDS_ANSWER defer arm): the call is still missed by the
// answered-proof test. If that callback rings out, nothing rang, so the call
// must not settle; the sweep retries after the callback ends. Gate off, both
// tests are the same SQL and this is always false.
const deferredOnlyCheck = (stillMissed, stillMissedFinal) => async () => !(await stillMissed()) && Boolean(await stillMissedFinal());

// The end of one delivery pass: settle it, release the lease for the next
// sweep, or (gate D) hold the call for the push retry.
async function finishDelivery({ row, stats, fenced, settle, pushRetry, firstPassSubs, deferredOnly }) {
  const deferred = !pushRetry && Boolean(stats?.suppressed) && !stats.bellWritten
    && await deferredOnly().catch(() => false);
  const delivered = !deferred && (pushRetry || Boolean(stats && !stats.error
    && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced)));
  if (!delivered) {
    await fenced().update({ metadata: db.raw("metadata - 'missed_call_notified_at'") }).catch(() => {});
    return;
  }
  const held = await holdForPushRetry({ row, stats, fenced, pushRetry, firstPassSubs }).catch(() => false);
  if (!held) await settle().catch(() => {});
}

// Wording the retire sweep and the post-delivery check give a bell closed because the customer's visit moved.
const VISIT_UNDERWAY_RESOLUTION = "The customer's visit went ahead after the call";

// Post-check after a bell was delivered: close it when the call stopped being
// the missed-call lane's. With GATE_MISSED_CALL_VISIT_UNDERWAY on, a call that
// stays missed on every other test and was closed only by the visit gets the
// visit wording; every other close keeps the default wording.
async function retireAfterDelivery(callLogId, stillMissedFinal, stillMissedIgnoringVisit) {
  if (await stillMissedFinal().catch(() => true)) return;
  const visitOnly = visitUnderwaySql() ? await stillMissedIgnoringVisit().catch(() => false) : false;
  const NotificationService = require('./notification-service');
  await NotificationService.supersedeMissedCallAdmin({
    callLogId,
    ...(visitOnly ? { resolution: VISIT_UNDERWAY_RESOLUTION } : {}),
  }).catch(() => {});
}

async function ringMissedCallIfUnanswered(callSid) {
  if (!callSid) return false;
  try {
    const row = await db('call_log').where('twilio_call_sid', callSid).modify(whereNotBlockedCall).first();
    const { isEnabled } = require('../config/feature-gates');
    const gaps = gapOptions();
    if (!missedCallEligible(row, Date.now(), { unknownCallers: isEnabled('missedCallUnknownCallers'), ...gaps })) return false;
    const recording = recordingFilter(row, emptyVmCustomerAdmitted(row, gaps));
    const calledBack = calledBackSql();
    // Atomic claim: first writer wins across retries / pods. The mutable
    // eligibility predicates are re-checked IN the claim so a voicemail
    // recording or an answered outcome that landed between the read above
    // and this write loses the race (codex r4).
    const token = new Date().toISOString();
    const reclaimed = Boolean(parseMeta(row.metadata).missed_call_notified_at);
    const [claimed] = await db('call_log')
      .where({ id: row.id })
      .modify(whereNotBlockedCall)
      .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
      .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
      .modify(recording)
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome,'') NOT IN ('ai_handled', 'ai_transferred')")
      .whereRaw(...unansweredClause(gaps))
      .whereRaw(calledBack)
      .modify(whereNoVisitUnderway)
      // RETURNING: the push-retry state below is read from the row this very
      // claim won, never from the snapshot read before it (a concurrent pass
      // may have released its lease with a retry recorded in between).
      .update({ metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('missed_call_notified_at', ?::text)", [token]) }, ['metadata']);
    if (!claimed) return false;
    // Every later write is fenced on the token: a stale owner waking up
    // late can't settle or release a lease someone else now holds.
    const fenced = () => db('call_log').where({ id: row.id }).whereRaw("metadata->>'missed_call_notified_at' = ?", [token]);
    const settle = () => fenced().update({ metadata: db.raw("metadata || jsonb_build_object('missed_call_settled_at', ?::text)", [new Date().toISOString()]) });
    // Reclaimed a stale lease: the previous owner may have died after the
    // bell was written. A bell row for this call means it delivered. A
    // push-only delivery leaves no row; a re-send is coalesced by the
    // per-call push tag (browser replaces same-tag notifications), whereas
    // settling before dispatch would make the crash a permanent loss.
    // A push-only retry (GATE_MISSED_CALL_PUSH_CHECK, pass 2): the bell row from
    // pass 1 stands. Keyed on the stored counter, not the gate, so a gate flipped
    // off between the passes can never write a second bell.
    const { pushRetry, firstPassSubs } = pushRetryState(claimed.metadata);
    // A pending push retry skips the shortcut: its bell row is expected, and a
    // pass 2 that crashed before dispatch must still send the push.
    if (reclaimed && !pushRetry) {
      const prior = await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' })
        .whereRaw("metadata->>'triggerKey' = 'customer_missed_call'")
        .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(row.id)]).first('id');
      if (prior) { await settle(); return false; }
    }
    // A push retry re-sends the first pass's push. That pass judged the call and
    // did not quiet it (a quieted push reports skipped, never held for a retry),
    // and this pass writes no bell, so a quiet decision here could not stop the
    // push: it would only title the retry likely robocall and mark an ordinary
    // bell quiet for the re-push. The retry keeps the first pass's decision
    // (pre-push audit r16).
    const quiet = pushRetry ? false : await quietRobodialerPush(row, fenced);
    const customer = row.customer_id
      ? await db('customers').where('id', row.customer_id).first('first_name', 'last_name', 'phone')
      : null;
    const lineLabel = row.customer_id ? null : (parseMeta(row.metadata).location || null);
    const { triggerNotification } = require('./notification-triggers');
    // Is this call still the missed-call lane's? False once a recording
    // persisted or the voicemail lane claimed it.
    // False too once a later call got through (calledBackSql).
    const stillMissedWith = (calledBackClause, visitCheck = whereNoVisitUnderway) => async () => Boolean(await db('call_log').where({ id: row.id }).modify(whereNotBlockedCall)
      .modify(recording).whereNull('voicemail_callback_alerted_at')
      .whereRaw(calledBackClause)
      .modify(visitCheck)
      .first('id'));
    const stillMissed = stillMissedWith(calledBack);
    // The post-check below retires the bell for good, so it needs proof of an
    // answered callback, not a callback that may still be ringing.
    const stillMissedFinal = stillMissedWith(calledBackSql({ retire: true }));
    // The same check without the visit clause: tells the post-check below whether the visit is the only reason.
    const stillMissedIgnoringVisit = stillMissedWith(calledBackSql({ retire: true }), () => {});
    const deferredOnly = deferredOnlyCheck(stillMissed, stillMissedFinal);
    let stats = null;
    let rowWritten = false; // set by the trigger before the push
    try {
      stats = await triggerNotification('customer_missed_call', {
        customerId: row.customer_id || null,
        // A quieted call matched a robodialer rule: its bell row says so, so the
        // list tells it apart from a real missed call (owner 2026-11-19 "YES BUILD").
        name: row.customer_id
          ? ([customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer')
          : `${quiet ? 'likely robocall' : 'unknown caller'}${lineLabel ? ` (${lineLabel})` : ''}`,
        phone: row.from_phone,
        callLogId: row.id,
        at: row.created_at,
        // This bell's own quiet decision. The re-push reads it from the bell row,
        // so a marker an earlier pass left on the call never decides for this
        // bell (pre-push audit r17).
        pushQuieted: Boolean(quiet),
        // GATE_MISSED_CALL_ALERT_DETAIL: line, call length, next visit; {} with the gate off.
        ...(await require('./missed-call-alert-detail').detailPayload(row)),
      }, {
        // Re-read right before the push (same supersession pattern as the
        // SMS bell): a recording that landed while the badge was computing
        // must not produce a contradictory missed-call push (hook P1).
        beforePush: pushGuard(quiet, stillMissed, () => rowWritten),
        onBell: (written) => { rowWritten = Boolean(written); },
        // And right before the bell row is written: a redial answered while
        // preferences loaded must not leave a missed-call bell.
        shouldContinue: stillMissed,
        ...(pushRetry ? { pushOnly: true } : {}),
      });
    } finally {
      await finishDelivery({ row, stats, fenced, settle, pushRetry, firstPassSubs, deferredOnly });
    }
    // Post-check (hook P1): a recording that persisted between the claim
    // and here makes this call the voicemail lane's — retire the bell just
    // written. The voicemail path runs the same supersede when IT claims, so
    // both orderings converge on one alert per call.
    await retireAfterDelivery(row.id, stillMissedFinal, stillMissedIgnoringVisit);
    return true;
  } catch (err) {
    logger.warn(`[missed-call-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

const TERMINAL_STATUSES = ['completed', 'no-answer', 'busy', 'canceled', 'failed'];

/**
 * Durable retry (runs on the 2-minute scheduler): re-offer unanswered,
 * unsettled (unclaimed or stale-leased) customer calls from the last 24h
 * whose terminal update is ≥5 minutes old (so the voicemail recording has
 * had its chance to land). Idempotent — the
 * atomic claim inside ringMissedCallIfUnanswered makes a re-offer a no-op.
 */
async function sweepMissedCalls({ limit = 50 } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  const unknownCallers = isEnabled('missedCallUnknownCallers');
  const gaps = gapOptions();
  const calledBack = calledBackSql();
  const now = Date.now();
  await stampGapShadows(gaps, now);
  let rung = 0;
  let offered = 0;
  let cursor = null;
  // Page past permanently ineligible rows using the same eligibility rule
  // as delivery, so spam/withheld IDs cannot monopolize the oldest batch.
  while (offered < limit) {
    const rows = await db('call_log')
      .where({ direction: 'inbound' })
      .modify(whereNotBlockedCall)
      .modify((q) => {
        if (!unknownCallers) q.whereNotNull('customer_id');
        else {
          whereNotSandboxCall(q);
          q.where(group => group.whereNotNull('customer_id').orWhere(unknown => unknown
            .where('duration_seconds', '>=', UNKNOWN_CALLER_MIN_SECONDS)
            .whereRaw("LENGTH(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g')) >= 10")
            .whereRaw("NOT (regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g') = ANY(?))", [[...PHONE_SENTINELS].flatMap(value => [value, `1${value}`])])
            .whereRaw("NOT COALESCE(jsonb_path_exists(COALESCE(metadata, '{}'::jsonb), ?::jsonpath, '{}'::jsonb, true), false)",
              ['strict $.addons.results.nomorobo_spamscore ? (@.status == "successful" && (@.result.score == true || @.result.score.double() == 1))'])));
        }
      })
      .whereIn('status', TERMINAL_STATUSES)
      .modify(sweepRecordingFilter(gaps))
      .whereNull('voicemail_callback_alerted_at')
      .whereRaw("COALESCE(call_outcome, '') NOT IN ('ai_handled', 'ai_transferred')")
      .whereRaw(...unansweredClause(gaps))
      .whereRaw("COALESCE(metadata->>'missed_call_settled_at','') = ''")
      .whereRaw(calledBack)
      .modify(whereNoVisitUnderway)
      // Unclaimed, or a lease that went stale (crash mid-delivery) — hook P1.
      .whereRaw("(COALESCE(metadata->>'missed_call_notified_at','') = '' OR (metadata->>'missed_call_notified_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
      .where('created_at', '>', new Date(now - 24 * 60 * 60 * 1000))
      // Grace runs from the TERMINAL update, not call creation: the no-answer
      // status lands before the caller records up to 120s of voicemail and
      // the recording callback persists it (codex r6).
      .whereRaw('COALESCE(updated_at, created_at) < ?', [new Date(now - VOICEMAIL_GRACE_MS)])
      .modify(q => {
        if (cursor) q.whereRaw('(created_at, id) > (?, ?)', [cursor.sweep_created_at, cursor.id]);
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      // A text cursor preserves PostgreSQL microseconds across tied dates.
      .select('*', db.raw('created_at::text AS sweep_created_at'));
    for (const r of rows) {
      if (!r.twilio_call_sid || !missedCallEligible(r, now, { unknownCallers, ...gaps })) continue;
      offered += 1;
      if (await ringMissedCallIfUnanswered(r.twilio_call_sid)) rung += 1;
      if (offered === limit) return rung;
    }
    if (rows.length < limit) break;
    cursor = rows[rows.length - 1];
  }
  return rung;
}

// How far back an open missed-call bell is still retired when the caller
// gets through later. Older bells are the office's to close by hand.
const RETIRE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Retire open missed-call bells whose caller got through AFTER the bell rang
 * (owner 2026-10-05): a later answered call, an alerted voicemail, or our
 * dialed callback — the same called-back SQL (calledBackSql) that keeps a bell from ringing.
 * Runs on the 2-minute call-alert cron; idempotent (a done bell is not
 * selected again). Never re-opens: a retired bell stays done.
 * This module is the ONE owner of missed-call bells (the relevance sweep has no
 * missed-call class). closeContactedMissedCalls adds the contact clauses below.
 */
async function retireCalledBackMissedCalls({ limit = 100 } = {}) {
  let retired = await retireOpenMissedCalls({
    clause: `NOT ${calledBackSql({ retire: true })}`,
    resolution: 'The caller got through on a later call',
    limit,
  });
  // Visit underway (GATE_MISSED_CALL_VISIT_UNDERWAY): a separate reason, so the
  // office can see why the bell closed. Off: this block does nothing.
  const underway = visitUnderwaySql();
  if (underway) {
    retired += await retireOpenMissedCalls({
      clause: underway,
      resolution: VISIT_UNDERWAY_RESOLUTION,
      limit,
    });
  }
  return retired + await closeContactedMissedCalls();
}

// Open customer_missed_call bells, joined to their call (bell age inside the
// retire window). The one base query for every retirement here.
function openMissedCallBells() {
  return db('notifications')
    .join('call_log', db.raw("call_log.id::text = notifications.metadata->'payload'->>'callLogId'"))
    .where({ 'notifications.recipient_type': 'admin', 'notifications.category': 'missed_call' })
    .whereRaw("notifications.metadata->>'triggerKey' = 'customer_missed_call'")
    .whereNull('notifications.done_at')
    .where('notifications.created_at', '>', new Date(Date.now() - RETIRE_WINDOW_MS));
}

async function retireOpenMissedCalls({ clause, resolution, limit }) {
  const rows = await openMissedCallBells()
    .whereRaw(clause)
    .distinct('call_log.id')
    .limit(limit);
  return supersedeCalls(rows.map((r) => r.id), resolution);
}

async function supersedeCalls(callLogIds, resolution) {
  const NotificationService = require('./notification-service');
  let retired = 0;
  for (const id of [...new Set(callLogIds)]) {
    retired += Number(await NotificationService.supersedeMissedCallAdmin({
      callLogId: id,
      resolution,
    })) || 0;
  }
  return retired;
}

// Contact clauses (owner 2026-10-24: customer-contact bells "should close
// automatically"; approved 2026-10-26). Beside the called-back proof above
// (calledBackSql, kept as it is), a missed-call bell closes once, AFTER the call
// began (callStartedAtSql, the SQL form of call-timeline.js callStartedAt: a row
// inserted after the call was over is backed out to its real start):
//  - a person's text reached the caller (operatorReplySql + smsDeliveredSql,
//    minus a proactive draft), by the call's customer, or by the caller's phone
//    only when the text or the call carries no customer id (people can share a
//    phone: a text to another customer on this number is not contact);
//  - a visit was booked for the call's customer (the new-lead class's live
//    top-level booking predicate, whereLiveBooking);
//  - a quote was handed off to the call's customer (handedOffWithin +
//    whereEstimateCustomerOwnership, never sent_at).
// Retired through supersedeMissedCallAdmin like the clauses above.
// read_at is never evidence. Sends nothing to anyone.
const CONTACT_CLAUSES = [
  {
    resolution: 'A person texted the caller after the call',
    clause: (q) => {
      const { callStartedAtSql } = require('./sms-pending-conversations');
      const { phoneIdentitySql } = require('./sms-response-policy');
      const { operatorReplySql, smsDeliveredSql } = require('./staff-contact');
      const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
      const { withoutProactiveDraft } = require('./call-commitments');
      const callerKey = phoneIdentitySql('call_log.from_phone');
      return q.whereExists(function personTextAfterCall() {
        excludeUnresolvedSendReservations(this.select(1).from('sms_log as os').where('os.direction', 'outbound'), 'os')
          .whereRaw(operatorReplySql('os')).whereRaw(smsDeliveredSql('os'))
          .modify(withoutProactiveDraft)
          .whereRaw(`os.created_at > ${callStartedAtSql('call_log')}`)
          .where((w) => w.whereRaw('os.customer_id = call_log.customer_id')
            .orWhereRaw(`${callerKey} <> '' AND ${phoneIdentitySql('os.to_phone')} = ${callerKey}
              AND (os.customer_id IS NULL OR call_log.customer_id IS NULL)`));
      });
    },
  },
  {
    resolution: 'A visit was booked after the call',
    clause: (q) => {
      const { callStartedAtSql } = require('./sms-pending-conversations');
      const { whereLiveBooking } = require('./admin-alert-relevance');
      return q.whereExists(function visitBookedAfterCall() {
        whereLiveBooking(this.select(1).from('scheduled_services')
          .whereRaw('scheduled_services.customer_id = call_log.customer_id')
          .whereRaw(`scheduled_services.created_at > ${callStartedAtSql('call_log')}`));
      });
    },
  },
  {
    resolution: 'An estimate was sent after the call',
    // handedOffWithin takes a boundary value, not a column: candidates are paged
    // with the call's start, then each page is asked the promise lane's own question.
    clause: (q) => q.whereRaw('call_log.customer_id IS NOT NULL'),
    narrow: async (rows) => {
      const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
      const kept = [];
      for (const row of rows) {
        const started = new Date(row.started_at);
        if (Number.isNaN(started.getTime())) continue;
        if (await whereEstimateCustomerOwnership(handedOffWithin(db('estimates'), started), row.customer_id).first('estimates.id')) kept.push(row);
      }
      return kept;
    },
  },
];
// The candidate set is bounded by RETIRE_WINDOW_MS (7 days of open bells), so each
// run walks ALL of it, clause by clause, in keyset pages ordered by bell id: a page
// of rows that match nothing (a quote candidate with no hand-off)
// can never hide the rows after it. The ceiling is only a safety
// valve against a runaway table; hitting it is logged.
const CONTACT_PAGE_SIZE = 200;
const CONTACT_RUN_CEILING = 5000;

async function closeContactedMissedCalls() {
  const { callStartedAtSql } = require('./sms-pending-conversations');
  let closed = 0;
  for (const { clause, resolution, narrow } of CONTACT_CLAUSES) {
    try {
      let cursor = null;
      let seen = 0;
      for (;;) {
        const page = await openMissedCallBells().modify(clause)
          .modify((q) => { if (cursor) q.where('notifications.id', '>', cursor); })
          .select('notifications.id as notification_id', 'call_log.id as call_id', 'call_log.customer_id', db.raw(`${callStartedAtSql('call_log')} as started_at`))
          .orderBy('notifications.id', 'asc')
          .limit(CONTACT_PAGE_SIZE);
        if (!page.length) break;
        cursor = page[page.length - 1].notification_id;
        seen += page.length;
        const matched = narrow ? await narrow(page) : page;
        if (matched.length) closed += await supersedeCalls(matched.map((r) => r.call_id), resolution);
        if (page.length < CONTACT_PAGE_SIZE) break;
        if (seen >= CONTACT_RUN_CEILING) {
          logger.warn(`[missed-call-bell] contact close stopped at ${seen} candidates (${resolution}); the rest wait for the next run`);
          break;
        }
      }
    } catch (err) {
      logger.warn(`[missed-call-bell] contact close skipped (${resolution}): ${require('./notification-service').safeErrorSummary(err)}`);
    }
  }
  return closed;
}

module.exports = {
  retireCalledBackMissedCalls,
  closeContactedMissedCalls,
  missedCallEligible,
  missedCallShapeEligible,
  isEmptyVoicemailRecording,
  ringMissedCallIfUnanswered,
  isRobodialerWave,
  isRobodialerBurst,
  isRepeatSilentCaller,
  quietRobodialerPush,
  classifySpamWave,
  exchangeHangupScreenHit,
  sweepMissedCalls,
  outcomeUnanswered,
  calledBackSql,
  visitUnderwaySql,
  VISIT_UNDERWAY_RESOLUTION,
  CALLED_BACK_SQL,
  UNKNOWN_CALLER_MIN_SECONDS,
  // Exported so missed-call-text-back.js shares the exact same "what counts
  // as a missed call" shape in its SQL pre-filter instead of re-deriving it.
  UNANSWERED,
  UNANSWERED_STATUSES,
  TERMINAL_STATUSES,
  VOICEMAIL_GRACE_MS,
};
