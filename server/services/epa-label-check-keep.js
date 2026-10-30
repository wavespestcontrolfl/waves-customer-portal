'use strict';

// The last EPA label check that got an answer, kept for 7 days (owner 2026-10-30: "keep the last good label check for
// 7 days"). Production often fails to reach EPA: on 10-28 and 10-29, Antapex read "Current EPA label could not be
// verified" on 10 of its 11 visit-days, so the card showed none of its reviewed weather limits. A deploy clears the
// 60-second memory cache (epa-product-label.js), so the answer is kept in system_settings. Only a failed check
// ('unavailable': EPA did not answer) reads it back, and only for the same label file and checksum. An answer that
// the label changed or the registration is no longer active is kept like 'current', so an outage never revives an
// older 'current'. Approval never uses it: it checks fresh (product-label-review.js). A database error never fails
// the check; the fresh answer stands.
const { createHash } = require('crypto');
const db = require('../models/db');
const { currentEpaSourceStatus } = require('./epa-product-label');

const KEEP_MS = 7 * 24 * 3600000;
// The same answer is written again at most once an hour, so the kept age stays within an hour of the last check.
const SAVE_EVERY_MS = 3600000;
const saved = new Map();

// system_settings.key is varchar(100): a fixed-length hash of the label identity; the value names it.
const keyOf = (source) => `epa_label_check:${createHash('sha256').update(`${source.registration}:${source.filename}:${source.sha256}`).digest('hex').slice(0, 40)}`;

async function keptEpaSourceStatus(source) {
  const status = await currentEpaSourceStatus(source);
  if (!source?.sha256) return status;
  const key = keyOf(source);
  try {
    const now = Date.now();
    if (status !== 'unavailable') {
      const last = saved.get(key);
      if (last?.status === status && now - last.at < SAVE_EVERY_MS) return status;
      const value = JSON.stringify({ registration: source.registration, filename: source.filename, sha256: source.sha256, status, checkedAt: new Date(now).toISOString() });
      await db('system_settings')
        .insert({ key, value, category: 'epa_label_check', description: 'Last EPA label check that got an answer (kept 7 days)' })
        .onConflict('key')
        .merge({ value, updated_at: new Date(now) });
      saved.set(key, { status, at: now });
      return status;
    }
    const row = await db('system_settings').where({ key }).first();
    const kept = row?.value ? JSON.parse(row.value) : null;
    const fresh = kept && kept.sha256 === source.sha256 && kept.filename === source.filename && now - Date.parse(kept.checkedAt) < KEEP_MS;
    return fresh && ['current', 'superseded', 'inactive'].includes(kept.status) ? kept.status : status;
  } catch {
    return status;
  }
}

module.exports = { keptEpaSourceStatus, _test: { KEEP_MS, saved } };
