'use strict';

// The last EPA label check that got an answer, kept for 7 days (owner 2026-10-30: "keep the last good label check for
// 7 days"). Production often fails to reach EPA: on 10-28 and 10-29, Antapex read "Current EPA label could not be
// verified" on 10 of its 11 visit-days, so the card showed none of its reviewed weather limits. A deploy clears the
// 60-second memory cache (epa-product-label.js), so the answer is kept in system_settings. Only a failed check
// ('unavailable': EPA did not answer) reads it back, and only for the same label file and checksum. An answer that
// the label changed or the registration is no longer active is kept like 'current', so an outage never revives an
// older 'current'. Every answer is ordered by the time EPA gave it (checkEpaSource: a cached answer keeps its time):
// the newest goes into memory before any write, a write never replaces a newer stored answer (another process's), and
// the newer of memory and the stored row wins. This module is the only reader of checkEpaSource, so every answer is
// kept, approval's too; approval itself never uses a kept answer. A database error never fails the check.
const { createHash } = require('crypto');
const db = require('../models/db');
const { checkEpaSource } = require('./epa-product-label');

const KEEP_MS = 7 * 24 * 3600000;
const KEPT = ['current', 'superseded', 'inactive'];
// A newer 'current' is written again at most once an hour, so the kept age stays within an hour of the last check.
const SAVE_EVERY_MS = 3600000;
// key -> { status, at, savedFor, savedAt }: the newest answer this process got for a label (at: when EPA gave it), the
// newest `at` written to the row, and when.
const seen = new Map();

// system_settings.key is varchar(100): a fixed-length hash of the label identity; the value names it.
const keyOf = (source) => `epa_label_check:${createHash('sha256').update(`${source.registration}:${source.filename}:${source.sha256}`).digest('hex').slice(0, 40)}`;

async function store(dbh, key, source, answer, now) {
  const { at } = answer;
  const checkedAt = new Date(at).toISOString();
  const value = JSON.stringify({ registration: source.registration, filename: source.filename, sha256: source.sha256, status: answer.status, checkedAt });
  // Only over an older answer: a retried write must not replace what another process stored since (ISO times sort as text).
  await dbh('system_settings')
    .insert({ key, value, category: 'epa_label_check', description: 'Last EPA label check that got an answer (kept 7 days)' })
    .onConflict('key')
    .merge({ value, updated_at: new Date(now) })
    .whereRaw("(system_settings.value::jsonb ->> 'checkedAt') < ?", [checkedAt]);
  answer.savedFor = Math.max(answer.savedFor ?? -Infinity, at);
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

// Keeps an EPA answer: memory first (only a newer answer moves it), then the row. A new answer, or one whose write
// failed, is written on the call; a newer 'superseded' or 'inactive' at once; a newer 'current' at most once an hour
// (meanwhile the row may hold an older answer: the safe side, it expires sooner). Returns this process's newest answer.
async function remember(dbh, source, { status, checkedAt }, now) {
  const key = keyOf(source);
  const answered = status !== 'unavailable';
  let mine = seen.get(key);
  if (answered && mine?.status === status) mine.at = Math.max(mine.at, checkedAt);
  else if (answered && !(mine?.at > checkedAt)) seen.set(key, (mine = { status, at: checkedAt, savedFor: null, savedAt: null }));
  const due = mine && (mine.savedFor == null || (mine.at > mine.savedFor && (mine.status !== 'current' || now - mine.savedAt >= SAVE_EVERY_MS)));
  if (due) await store(dbh, key, source, mine, now).catch(() => {});
  return mine;
}

// The job card's and Inventory's check: EPA's answer, or when EPA did not answer, the newer of this process's
// answer and the stored one, up to 7 days old.
async function keptEpaSourceStatus(source, { dbh = db } = {}) {
  const answer = await checkEpaSource(source);
  if (!source?.sha256) return answer.status;
  const now = Date.now();
  const mine = await remember(dbh, source, answer, now);
  if (answer.status !== 'unavailable') return answer.status;
  const kept = newer(await storedAnswer(dbh, keyOf(source), source).catch(() => null), mine);
  return kept && now - kept.at < KEEP_MS && KEPT.includes(kept.status) ? kept.status : answer.status;
}

// Approval's check: always fresh and never the kept answer; its answer is kept for the reads that follow, so a
// cancellation found at approval is not lost (pre-push audit P1).
async function freshEpaSourceStatus(source, { dbh = db } = {}) {
  const answer = await checkEpaSource(source, { refresh: true });
  if (source?.sha256) await remember(dbh, source, answer, Date.now());
  return answer.status;
}

module.exports = { keptEpaSourceStatus, freshEpaSourceStatus, _test: { KEEP_MS, seen, keyOf } };
