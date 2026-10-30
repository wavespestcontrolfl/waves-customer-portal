'use strict';

// The last EPA label check that got an answer, kept for 7 days (owner 2026-10-30: "keep the last good label check for
// 7 days"). Production often fails to reach EPA: on 10-28 and 10-29, Antapex read "Current EPA label could not be
// verified" on 10 of its 11 visit-days, so the card showed none of its reviewed weather limits. A deploy clears the
// 60-second memory cache (epa-product-label.js), so the answer is kept in system_settings. Only a failed check
// ('unavailable': EPA did not answer) reads it back, and only for the same label file and checksum. An answer that
// the label changed or the registration is no longer active is kept like 'current', so an outage never revives an
// older 'current'. Every answer is ordered by the time EPA gave it (checkEpaSource: a cached answer keeps its time):
// the newest goes into memory before any write, a write never replaces a newer stored answer (another process's), and
// the newer of memory and the stored row wins. Approval never uses it: it checks fresh (product-label-review.js). A
// database error never fails the check.
const { createHash } = require('crypto');
const db = require('../models/db');
const { checkEpaSource } = require('./epa-product-label');

const KEEP_MS = 7 * 24 * 3600000;
const KEPT = ['current', 'superseded', 'inactive'];
// The same answer is written again at most once an hour, so the kept age stays within an hour of the last check.
const SAVE_EVERY_MS = 3600000;
// key -> { status, at, savedAt }: the newest answer this process got for a label (at: when EPA gave it), and when it
// was stored.
const seen = new Map();

// system_settings.key is varchar(100): a fixed-length hash of the label identity; the value names it.
const keyOf = (source) => `epa_label_check:${createHash('sha256').update(`${source.registration}:${source.filename}:${source.sha256}`).digest('hex').slice(0, 40)}`;

async function store(dbh, key, source, answer, now) {
  const checkedAt = new Date(answer.at).toISOString();
  const value = JSON.stringify({ registration: source.registration, filename: source.filename, sha256: source.sha256, status: answer.status, checkedAt });
  // Only over an older answer: a retried write must not replace what another process stored since (ISO times sort as text).
  await dbh('system_settings')
    .insert({ key, value, category: 'epa_label_check', description: 'Last EPA label check that got an answer (kept 7 days)' })
    .onConflict('key')
    .merge({ value, updated_at: new Date(now) })
    .whereRaw("(system_settings.value::jsonb ->> 'checkedAt') < ?", [checkedAt]);
  answer.savedAt = now;
}

// The newer of two answers (either may be missing).
const newer = (a, b) => (a && (!b || a.at > b.at) ? a : b);

// The stored answer for this label file and checksum, or null.
async function storedAnswer(dbh, key, source) {
  const row = await dbh('system_settings').where({ key }).first();
  const stored = row?.value ? JSON.parse(row.value) : null;
  const at = Date.parse(stored?.checkedAt);
  return stored?.sha256 === source.sha256 && stored?.filename === source.filename && Number.isFinite(at) ? { status: stored.status, at } : null;
}

async function keptEpaSourceStatus(source, { dbh = db } = {}) {
  const { status, checkedAt } = await checkEpaSource(source);
  if (!source?.sha256) return status;
  const key = keyOf(source);
  const now = Date.now();
  const answered = status !== 'unavailable';
  let mine = seen.get(key);
  // Only a newer answer moves memory; a cached answer read again changes nothing.
  if (answered && mine?.status === status) mine.at = Math.max(mine.at, checkedAt);
  else if (answered && !(mine?.at > checkedAt)) seen.set(key, (mine = { status, at: checkedAt, savedAt: null }));
  // Stored at most once an hour while unchanged; a write that failed is tried again on the next call.
  if (mine && (mine.savedAt == null || (answered && now - mine.savedAt >= SAVE_EVERY_MS))) await store(dbh, key, source, mine, now).catch(() => {});
  if (answered) return status;
  // EPA did not answer: the newer of this process's answer and the stored one, up to 7 days old.
  const stored = await storedAnswer(dbh, key, source).catch(() => null);
  const kept = newer(stored, mine);
  return kept && now - kept.at < KEEP_MS && KEPT.includes(kept.status) ? kept.status : status;
}

module.exports = { keptEpaSourceStatus, _test: { KEEP_MS, seen, keyOf } };
