'use strict';

/**
 * Call check on change (GATE_CALL_REPLAY_EVAL_ON_CHANGE, dark).
 *
 * The weekly call extraction replay (call-extraction-replay.js) runs 27
 * reviewed calls through the LIVE extractor every Monday, whether or not the
 * extractor changed. Owner ruling 2026-10-08: run it when the extractor
 * changed, started from the terminal, and say so with an admin item.
 *
 * With the gate on:
 *   - the weekly cron does not run the replay;
 *   - a daily check compares the extractor's fingerprint (its base prompt
 *     version, its primary and fallback models, the reviewed-call fixture)
 *     with the fingerprint the replay last ran against. Different, or never
 *     run: ONE admin item asks for the check. Same: nothing, and an open item
 *     is closed;
 *   - server/scripts/run-call-extraction-replay-eval.js records the
 *     fingerprint when a run reaches a verdict (pass or fail), which is what
 *     ends the item.
 *
 * The check makes no model call. The replay itself is unchanged.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');

const SETTING_KEY = 'eval.call_replay.checked_fingerprint';
const ALERT_KEY_PREFIX = 'call-replay-due:';
const DEFAULT_FIXTURE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'call-extraction-eval', 'reviewed-calls.json');

function callReplayOnChangeLive() {
  return process.env.GATE_CALL_REPLAY_EVAL_ON_CHANGE === 'true';
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * What decides the answers the REPLAY can see, as one short id: only inputs
 * the replay exercises, so a recorded fingerprint never claims a check that
 * did not happen. Left out on purpose:
 *   - the agent-proposed-slot prompt variant: the replay calls the extractor
 *     without it, so a change there is neither asked for nor marked checked;
 *   - the catalog of bookable service names: it is data, it changes without
 *     a deploy, and the replay reads it live on every run.
 */
function extractorFingerprint({ fixturePath = DEFAULT_FIXTURE_PATH, deps = {} } = {}) {
  const { extractionPromptVersion } = deps.prompts || require('../prompts/call-extraction-v1');
  // The route is resolved once at module load in call-recording-processor,
  // which exposes it with its other internals.
  const route = deps.route || require('../call-recording-processor')._test.CALL_EXTRACTION_ROUTE;
  const leg = (l) => `${l?.provider}/${l?.model}`;
  const parts = {
    prompt: extractionPromptVersion([]),
    primary: leg(route.primary),
    fallback: leg(route.fallback),
    fixture: sha(fs.readFileSync(fixturePath)).slice(0, 12),
  };
  return { fingerprint: sha(JSON.stringify(parts)).slice(0, 16), parts };
}

async function checkedFingerprint(conn = db) {
  const row = await conn('system_settings').where({ key: SETTING_KEY }).first('value');
  return row?.value || null;
}

/** Record that the replay reached a verdict against this fingerprint. */
async function markChecked(fingerprint, { conn = db, now = new Date() } = {}) {
  await conn('system_settings')
    .insert({ key: SETTING_KEY, value: fingerprint, category: 'eval', description: 'Extractor fingerprint the call extraction replay last ran against', created_at: now, updated_at: now })
    .onConflict('key')
    .merge({ value: fingerprint, updated_at: now });
}

/**
 * The daily check. Raises one item per extractor change (keyed by the new
 * fingerprint) and closes items for any other fingerprint, including the
 * current one once the replay has run against it.
 */
async function checkCallReplayDue({ now = new Date(), deps = {} } = {}) {
  const conn = deps.db || db;
  const episodes = deps.episodes || require('../admin-alert-episodes');
  const { fingerprint, parts } = deps.fingerprint || extractorFingerprint();
  const checked = await checkedFingerprint(conn);
  const due = checked !== fingerprint;
  const key = `${ALERT_KEY_PREFIX}${fingerprint}`;
  const stale = (await episodes.openAdminAlertKeys(conn, ALERT_KEY_PREFIX)).filter((k) => !due || k !== key);
  await episodes.closeAdminAlertKeys(conn, stale, 'call_check_run', { now, resolution: 'Cleared: the call check ran on this version of the extractor' });
  if (!due) return { due: false, fingerprint };

  const composed = require('../admin-alert-compose').composeAdminAlert({
    area: 'System',
    action: 'run the call check in the terminal',
    why: checked
      ? 'The call extractor changed and the reviewed-call check has not run on the new version.'
      : 'The reviewed-call check has not run on this version of the call extractor.',
    severity: 'needs-you',
    link: '/admin/agents',
    subject: { type: 'check', id: 'call-extraction-replay' },
    doneWhen: 'call_check_run',
    who: 'either',
  });
  await episodes.raiseAdminAlertWithReopen('system', composed.headline, composed.why, {
    link: composed.link,
    metadata: composed.metadata,
    dedupeKey: key,
    detail: [
      'Run this from the repo, with the production environment: npm run eval:call-replay',
      'It replays the reviewed calls through the live extractor (about 27 model calls) and ends this item when it reaches a verdict.',
      '',
      `Prompt version: ${parts.prompt}`,
      `Models: ${parts.primary}, then ${parts.fallback}`,
    ].join('\n'),
  });
  logger.info(`[call-replay-on-change] call check due for extractor ${fingerprint}`);
  return { due: true, fingerprint };
}

module.exports = { callReplayOnChangeLive, extractorFingerprint, checkedFingerprint, markChecked, checkCallReplayDue, SETTING_KEY, ALERT_KEY_PREFIX };
