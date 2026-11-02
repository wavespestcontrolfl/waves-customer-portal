/**
 * Daily review list for typed decisions (dark behind GATE_TYPED_DECISIONS).
 *
 * 8:05 AM ET (scheduler.js): raise ONE admin row listing the
 * still-unreviewed shadow cases of the last 14 days: up to 8 where the
 * answers differ (a test AI against a live answer, or the two test AIs
 * against each other) and up to 2 random spot checks, newest first.
 * Nothing waiting = the standing row is closed instead.
 *
 * Owner 2026-11-02 ("yes" to plain words and no needs-you item): the row is
 * an FYI that admin-alert-routing.js sends to Claude's queue (Agents →
 * Activity), never the owner's bell; the Claude labeler grades these rows
 * each night. One line per case, in plain words: the question, each test
 * AI's answer and how sure it was, and the live answers (yes/no only, never
 * message text). Labeling is the only thing that moves a row; nothing acts
 * on a test AI's answer.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { typedDecisionsLive } = require('../../config/feature-gates');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { providerLabel, PACKAGES, DECISION_PROVIDERS } = require('./packages');
const { DRAW_KEY } = require('./shadow-recorder');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const CATEGORY = 'typed_decisions';
const KEY_PREFIX = 'typed-decisions-review:';
const SAMPLED = ['disagreement', 'random_audit'];
// The Typed tab of the Agents hub (client/src/pages/admin/TypedDecisionsReviewPage.jsx).
const LINK = '/admin/agents?tab=typed';
const MAX_DISAGREEMENTS = 8;
const MAX_SPOT_CHECKS = 2;
const KIND_LABELS = { disagreement: 'Answers differ', random_audit: 'Random check' };
// In the order a line names them: the live system first.
const LIVE_LABELS = { production: 'live system', rules: 'live rules', deep_judge: "Claude's check" };
const LIVE_ORDER = Object.keys(LIVE_LABELS);
const REVIEW_COLUMNS = ['id', 'capability', 'package_id', 'subject_type', 'subject_id', 'provider', 'question_id', 'jev_answer', 'baseline_answers', 'created_at'];

// Each package question in a few plain words (packages.js holds the full wording the models get).
// A question missing here reads as its ids.
const PLAIN_QUESTIONS = {
  call_judge: {
    is_lead: 'Was the call a sales lead?',
    is_spam: 'Was the call spam, a robocall or a sales pitch?',
    is_voicemail: 'Was the call a voicemail?',
    appointment_agreed: 'Did the call set a firm appointment?',
    quote_promised: 'Did staff promise to send a quote?',
    complaint: 'Did the caller complain about our service?',
  },
  sms_courtesy: { is_courtesy_only: 'Was the text only a thank-you or an OK?' },
  sms_reschedule: { wants_visit_change: 'Did the text ask to move, skip or cancel a visit?' },
  call_gate_checks: {
    service_unclear: 'Did the caller want service but not say which one?',
    reschedule_committed: 'Did staff move a booked visit to a new day and time?',
    promise_open: 'Did staff promise a callback, a quote or a visit time?',
  },
  sms_solicitation: { is_solicitation: 'Was the text a business pitching something to Waves?' },
  voicemail: {
    callback_requested: 'Did the caller ask for a call or text back?',
    needs_attention_today: 'Did the voicemail need a person the same day?',
    is_vendor_or_spam: 'Was the voicemail spam or a sales pitch?',
  },
  visit_access: {
    dog_on_property: 'Is there a dog or other loose animal at the property?',
    needs_code_key_or_person: 'Does the technician need a code, a key or a person to get in?',
    contact_before_arrival: 'Did the customer ask us to call, text or knock first?',
    person_home_needs_notice: 'Does someone at the home need notice or care first?',
    past_access_problem: 'Did a past visit have an access problem?',
    access_fact_not_on_file: 'Did the customer text a code, gate, key or pet that is not on file?',
  },
  photo_privacy: {
    shows_face: 'Does the photo show a face?',
    shows_person: 'Does the photo show a person?',
    shows_address_text: 'Does the photo show a house number or street sign?',
    shows_license_plate: 'Does the photo show a license plate?',
    shows_child: 'Does the photo show a child?',
    shows_pet: 'Does the photo show a pet?',
  },
  ask_waves_safety: {
    safety_claim: 'Did the chat reply call a treatment safe?',
    access_timing: 'Did the chat reply say when people or pets can go back?',
  },
  lawn_result_timing: { states_result_timing: 'Does the lawn report line say when results will show?' },
};

const parse = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const word = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const plain = (text) => String(text).replace(/_/g, ' ');
// One case = one question about one subject; each test AI writes its own row for it (shadow-recorder DRAW_KEY).
const caseKey = (row) => DRAW_KEY.map((k) => String(row[k])).join('|');
const rank = (list, item) => (list.includes(item) ? list.indexOf(item) : list.length);

// "yes (84% sure)": how sure the model is of the answer it gave (p is its chance of yes).
function describeAnswer(answer) {
  if (!answer) return 'gave no answer';
  if (typeof answer.yes === 'boolean') {
    const said = answer.yes ? 'yes' : 'no';
    const p = answer.p === null || answer.p === undefined ? NaN : Number(answer.p);
    return Number.isFinite(p) ? `${said} (${Math.round((answer.yes ? p : 1 - p) * 100)}% sure)` : said;
  }
  if (typeof answer.choice === 'string') return plain(answer.choice);
  if (answer.score !== undefined) return `score ${answer.score}`;
  return 'gave an unreadable answer';
}

const describeLive = (value) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : plain(value));

// One case in plain words. `answers` maps each test AI to its answer to this case, labeled or not, so a
// case listed because the test AIs differ says so even when this row's answer matches the live one.
// The provider's own name (Jev, Clef): a row is never attributed to a model that did not answer it.
function describeCase(row, answers = new Map()) {
  const byProvider = new Map(answers);
  if (!byProvider.has(row.provider)) byProvider.set(row.provider, parse(row.jev_answer));
  const ai = [...byProvider.keys()].sort((a, b) => rank(DECISION_PROVIDERS, a) - rank(DECISION_PROVIDERS, b))
    .map((provider) => `${providerLabel(provider)} ${describeAnswer(byProvider.get(provider))}`);
  const live = Object.entries(parse(row.baseline_answers) || {})
    .filter(([, value]) => value !== null && value !== undefined)
    .sort(([a], [b]) => rank(LIVE_ORDER, a) - rank(LIVE_ORDER, b))
    .map(([name, value]) => `${LIVE_LABELS[name] || plain(name)} ${describeLive(value)}`).join(', ');
  const question = PLAIN_QUESTIONS[row.capability]?.[row.question_id] || `${plain(row.capability)}: ${plain(row.question_id)}?`;
  return `${question} ${ai.join(', ')}. ${live ? `${live.charAt(0).toUpperCase()}${live.slice(1)}.` : 'No live answer.'}`;
}

// The row lists what is STILL waiting, not one calendar day: rows stay in
// it until labeled, so a day whose alert failed to persist is picked up the
// next morning, and a row that a later nightly re-record turned into a
// disagreement (it keeps its first created_at) still reaches the list.
const REVIEW_WINDOW_DAYS = 14;
function windowStart(now) {
  return parseETDateTime(`${etDateString(addETDays(now, -REVIEW_WINDOW_DAYS))}T00:00:00`);
}

// Close standing review rows (docs/admin-notifications.md: the emitter clears
// completed work). `keep` is today's key when a fresh row was just raised.
async function closeReviewItems(conn, now, reason, keep = null) {
  const episodes = require('../admin-alert-episodes');
  const keys = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((k) => k !== keep);
  if (!keys.length) return 0;
  return Number(await episodes.closeAdminAlertKeys(conn, keys, reason, { now, resolution: reason === 'reviews_labeled' ? 'Every case from the AI test is graded' : 'Replaced by a newer list' })) || 0;
}

// After a label: when nothing sampled is still waiting in the review window,
// the standing row is done (doneWhen reviews_labeled).
async function closeIfQueueEmpty({ now = new Date(), conn = db } = {}) {
  const waiting = await conn('decision_reviews')
    .where({ label_status: 'unreviewed' }).whereIn('sampled_for', SAMPLED)
    .where('created_at', '>=', windowStart(now)).first('id');
  if (waiting) return 0;
  return closeReviewItems(conn, now, 'reviews_labeled');
}

// The newest rows of one capability, one per case: each test AI's row of a case shares its cohort
// (shadow-recorder.sampleFor), so a case is listed once, by its newest row.
function newestCases(rows, capability, limit) {
  const seen = new Set();
  const cases = [];
  for (const row of rows) {
    if (row.capability !== capability || seen.has(caseKey(row))) continue;
    seen.add(caseKey(row));
    cases.push(row);
    if (cases.length === limit) break;
  }
  return cases;
}

// The newest cases of each capability, then one from each in turn (the
// capability with the newest case first), so a lane that queues many rows a
// day (visit_access: about a hundred) never takes every slot from the
// others. With one capability waiting this is the plain newest-first pick.
async function pickCases(conn, start, sampledFor, limit) {
  const capabilities = [...new Set(Object.values(PACKAGES).map((pkg) => pkg.capability))];
  const lists = (await Promise.all(capabilities.map(async (capability) => newestCases(await conn('decision_reviews')
    .where({ label_status: 'unreviewed', sampled_for: sampledFor, capability })
    .where('created_at', '>=', start)
    .orderBy('created_at', 'desc').limit(limit * DECISION_PROVIDERS.length)
    .select(...REVIEW_COLUMNS), capability, limit))))
    .filter((rows) => rows.length)
    .sort((x, y) => new Date(y[0].created_at) - new Date(x[0].created_at));
  const picked = [];
  for (let turn = 0; picked.length < limit && lists.some((rows) => rows[turn]); turn += 1) {
    for (const rows of lists) if (rows[turn] && picked.length < limit) picked.push(rows[turn]);
  }
  return picked;
}

// Every test AI's answer to the listed cases, labeled or not, keyed by case.
async function caseAnswers(conn, rows) {
  const found = await conn('decision_reviews')
    .where((q) => { for (const row of rows) q.orWhere(Object.fromEntries(DRAW_KEY.map((k) => [k, row[k]]))); })
    .select(...DRAW_KEY, 'provider', 'jev_answer');
  const byCase = new Map();
  for (const row of found || []) {
    const key = caseKey(row);
    if (!byCase.has(key)) byCase.set(key, new Map());
    byCase.get(key).set(row.provider, parse(row.jev_answer));
  }
  return byCase;
}

async function runDailyReviewItem({ now = new Date(), conn = db } = {}) {
  if (!typedDecisionsLive()) return { raised: false, reason: 'gate_off' };
  const start = windowStart(now);
  const disagreements = await pickCases(conn, start, 'disagreement', MAX_DISAGREEMENTS);
  const spotChecks = await pickCases(conn, start, 'random_audit', MAX_SPOT_CHECKS);
  const total = disagreements.length + spotChecks.length;
  if (!total) {
    await closeReviewItems(conn, now, 'reviews_labeled').catch((err) => logger.warn(`[typed-decisions] review item close failed: ${err.message}`));
    return { raised: false, reason: 'no_rows' };
  }

  const answers = await caseAnswers(conn, [...disagreements, ...spotChecks]);
  const lines = (rows, kind) => rows.map((row) => `${KIND_LABELS[kind]}: ${describeCase(row, answers.get(caseKey(row)))}`);
  const day = etDateString(now);
  const detail = [
    `${DECISION_PROVIDERS.map(providerLabel).join(' and ')} are test AIs. They answer yes/no questions next to the live system, and nothing acts on their answers.`,
    `These cases from the last ${REVIEW_WINDOW_DAYS} days have no grade yet. Nobody has to act: the Claude labeler grades cases each night, and a case it cannot settle stays on this list.`,
    ...lines(disagreements, 'disagreement'),
    ...lines(spotChecks, 'random_audit'),
  ].join('\n');
  const why = [disagreements.length && `${disagreements.length} with different answers`, spotChecks.length && word(spotChecks.length, 'random check', 'random checks')]
    .filter(Boolean).join(' and ');

  const alert = await raiseAdminAlert(CATEGORY, {
    area: 'System',
    action: `check ${word(total, 'case', 'cases')} from the AI test`,
    why: `${why}; nothing acts on the test answers.`,
    severity: 'fyi',
    link: LINK,
    subject: { type: 'check', id: 'typed-decisions-review' },
    doneWhen: 'reviews_labeled',
    who: 'claude',
  }, {
    // The owner ruled this FYI keeps a row (2026-11-02); admin-alert-routing.js puts it in Claude's queue.
    fyiRow: true,
    detail,
    dedupeKey: `${KEY_PREFIX}${day}`,
    refreshOnDedupe: true,
    // An FYI never rings: a same-day re-run rewrites the list quietly.
    ringOnRefresh: () => false,
    metadata: { lane: 'typed_decisions', disagreements: disagreements.length, spotChecks: spotChecks.length },
  });
  // raiseAdminAlert resolves null when the notification row could not be
  // written: that is a failed run (the rows stay unreviewed, so tomorrow's run
  // raises them again).
  if (!alert) {
    logger.warn('[typed-decisions] daily review item was not persisted; the rows stay queued for the next run');
    return { raised: false, reason: 'alert_not_persisted', disagreements: disagreements.length, spotChecks: spotChecks.length };
  }
  // Today's row lists everything still waiting; earlier days' rows are done.
  await closeReviewItems(conn, now, 'superseded', `${KEY_PREFIX}${day}`).catch((err) => logger.warn(`[typed-decisions] review item close failed: ${err.message}`));
  return { raised: true, disagreements: disagreements.length, spotChecks: spotChecks.length, dedupeKey: `${KEY_PREFIX}${day}`, alert };
}

module.exports = { runDailyReviewItem, closeIfQueueEmpty, describeCase, CATEGORY, LINK, REVIEW_WINDOW_DAYS, KEY_PREFIX };
