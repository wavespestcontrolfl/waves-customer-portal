/**
 * MOVE-CHECK-DOWN NOTICE — owner audit 2026-10-22, finding 1.
 *
 * Oct 15-19 the AI move check (proofreader/nightly.js) failed on every call:
 * Claude refused them all (the monthly spend limit). The check never lets a
 * move through that it could not ask about, so the tool moved nothing for
 * five nights, double-booking fixes included. No notice named it: job health
 * turned red, and one general digest went unread.
 *
 * At each run's end (index.js), from the run's check tally:
 *   - down: the check was asked and NO answer could be used (every ask broke:
 *     a provider error, an unreadable answer, a failed read) → ONE notice that
 *     names the cause. It rings once per outage: while it stands, a later
 *     broken run only rewrites it, and a person's done stays done.
 *   - up: at least one usable answer → the notice closes itself; a later
 *     outage rings again.
 *   - nothing asked: no change.
 * One ring per outage, counted in the shared auto-dispatch allowance
 * (audit.js BUDGET_LANE_KEYS) but never held back by it: a stopped tool is
 * the notice that must reach a person.
 *
 * Behind GATE_AUTO_DISPATCH_CHECK_DOWN_NOTICE, read at call time. Off, or the
 * check itself off: a standing notice closes, so a rollback leaves none.
 */
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');

const GATE = 'GATE_AUTO_DISPATCH_CHECK_DOWN_NOTICE';
const KEY = 'auto-dispatch-check-down';
const LINK = '/admin/agents?tab=dispatch';

// Plain words for why a check broke: a failed call's reason (llm/call.js:
// no_key | <provider>_<status> | <provider>_timeout | empty_json | error) or
// the check's own why (bad_answer, check_failed).
function causeText(code) {
  const c = String(code || 'error');
  if (c === 'no_key') return 'no API key is set for the model';
  if (c === 'bad_answer' || c === 'empty_json') return 'the model answered in a shape the check cannot read';
  if (c === 'check_failed') return 'a database read failed during the check';
  if (/_timeout$/.test(c)) return 'the model did not answer in time';
  const status = Number((c.match(/_(\d{3})$/) || [])[1]);
  if (status === 400) return 'the provider refused the call (on Oct 15 this was the monthly spend limit)';
  if (status === 401 || status === 403) return 'the provider rejected the API key';
  if (status === 429) return 'the provider is limiting how often we call';
  if (status >= 500) return 'the provider is down or overloaded';
  return 'the call failed';
}

// The same cause in a few words for the why line, which allows no code
// words (admin-alert-compose.js FORBIDDEN: snake_case, env names); the code
// itself rides the detail.
function shortCause(code) {
  const c = String(code || 'error');
  if (c === 'no_key') return 'no API key is set';
  if (c === 'bad_answer' || c === 'empty_json') return 'its answers could not be read';
  if (c === 'check_failed') return 'a database read failed';
  if (/_timeout$/.test(c)) return 'the model timed out';
  const status = Number((c.match(/_(\d{3})$/) || [])[1]);
  if (status === 400) return 'the provider refused the call';
  if (status === 401 || status === 403) return 'the API key was rejected';
  if (status === 429) return 'calls were rate limited';
  if (status >= 500) return 'the provider was down';
  return 'the call failed';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function closeNotice(episodes, db, nowDate, reason, resolution) {
  return episodes.closeAdminAlertKeys(db, [KEY], reason, { now: nowDate, resolution });
}

async function raiseNotice(state, { db, episodes, raiseAdminAlert, nowDate }) {
  const { cutAtWord, MAX_WHY_CHARS } = require('../admin-alert-compose');
  const cause = String(state.brokeCause || 'error');
  const broke = Number(state.broke) || 0;
  // Standing = raised and not closed by a working night: rewritten quietly.
  // Absent or closed: this call carries a new version, so it rings (again).
  const standing = (await episodes.openAdminAlertKeys(db, KEY)).includes(KEY);
  return raiseAdminAlert('system', {
    area: 'System',
    action: 'restore the auto-dispatch move check',
    why: cutAtWord(`${plural(broke, 'planned move')} stayed put: every move check failed (${shortCause(cause)}).`, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: 'auto-dispatch-move-check' },
    doneWhen: 'check_answers',
    who: 'person',
  }, {
    dedupeKey: KEY,
    refreshOnDedupe: true,
    // The one refresh that rings: a notice a working night closed, and the
    // check is down again.
    ringOnRefresh: (_existing, meta) => meta?.autoCleared === true,
    // Rings unless the owner turned the System category off (admin bell policy).
    bellDefault: true,
    ...(standing ? {} : { dedupeVersion: `run:${nowDate.toISOString()}` }),
    detail: `The 4:10 AM auto-dispatch run asks an AI model before each move. Tonight every check failed: ${causeText(cause)} (${cause}). `
      + `The tool never moves a visit it could not check, so ${plural(broke, 'planned move')} stayed put, double-booking fixes included. `
      + 'Check the AI provider account (spend limit, API key) and the key in Railway → Variables. '
      + 'The run asks again every night; this notice closes itself the first night a check answers.',
    metadata: { autoCleared: false, cause, broke },
  });
}

/**
 * Run end, every run. `state` is the run's check tally (nightly.newRunState),
 * null when the check is off. Resolves to what it did, for the run's log
 * line; never throws.
 */
async function noteRun(state, { enabled = true, nowDate = new Date(), deps = {} } = {}) {
  try {
    const db = deps.db || require('../../models/db');
    const episodes = deps.episodes || require('../admin-alert-episodes');
    if (!gateEnvValue(GATE)) {
      await closeNotice(episodes, db, nowDate, 'gate_off', 'The move-check-down notice is turned off');
      return { action: 'off' };
    }
    if (!enabled || !state) {
      await closeNotice(episodes, db, nowDate, 'check_off', 'The move check is turned off');
      return { action: 'check_off' };
    }
    if ((Number(state.answered) || 0) > 0) {
      const closed = await closeNotice(episodes, db, nowDate, 'check_answers', 'The move check answered again');
      return { action: closed ? 'closed' : 'up' };
    }
    if (!(Number(state.broke) > 0)) return { action: 'none' };
    const raiseAdminAlert = deps.raiseAdminAlert || require('../admin-alert-compose').raiseAdminAlert;
    await raiseNotice(state, { db, episodes, raiseAdminAlert, nowDate });
    return { action: 'down' };
  } catch (err) {
    logger.error(`[auto-dispatch] move-check-down notice failed: ${err.code || err.name || 'error'}`);
    return { action: 'error' };
  }
}

module.exports = { noteRun, causeText, shortCause, GATE, KEY };
