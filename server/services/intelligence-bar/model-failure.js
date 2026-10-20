'use strict';

/**
 * Intelligence Bar model failure notice (GATE_IB_MODEL_FAILURE_NOTICE).
 *
 * When the AI model call itself fails (a provider 4xx/5xx, a timeout, an
 * overload such as the Anthropic monthly spend limit on 2026-10-19), the bar
 * used to end with a thrown error: the palette showed "Error: <message>", no
 * gap row and no alert. This module gives the route what it needs to answer
 * plainly instead:
 *
 *  - tag / recognise an error thrown by the model call (and only that call:
 *    a tool error or a validation error never carries the tag);
 *  - read what the task already did from its saved receipts, so the reply
 *    never says "nothing was changed" after a write committed;
 *  - record one gap row (source `ib-model`, no gap bell) and ring one admin
 *    bell at most once an hour.
 *
 * Nothing here sends a customer message. Every write is best-effort and never
 * throws: the caller is already in an error path.
 */

const logger = require('../logger');
const PendingActions = require('./pending-actions');

const GAP_SOURCE = 'ib-model';
const BELL_CATEGORY = 'agents';
const BELL_LINK = '/admin/agents';
const BELL_DEDUPE_KEY = 'ib:model-failure';
const BELL_WINDOW_MS = 60 * 60 * 1000;
const MAX_SUMMARIES = 3;
const MAX_SUMMARY_CHARS = 120;
const CODE_RE = /^[a-z][a-z0-9_]{1,47}$/;

// Receipt outcomes (pending-actions.js actionReceipt): a change that landed,
// and one that may have.
const SAVED_OUTCOMES = new Set(['completed', 'provider_accepted', 'partially_completed']);
const UNKNOWN_OUTCOME = 'outcome_unknown';
const WAITING_OUTCOME = 'awaiting_approval';

const tagged = new WeakSet();

/** Marks an error thrown by the model call. Returns the same value. */
function tagModelCallError(err) {
  if (err && typeof err === 'object') tagged.add(err);
  return err;
}

function isModelCallError(err) {
  return Boolean(err) && typeof err === 'object' && tagged.has(err);
}

/**
 * The code the ledger records for this failure (`anthropic_400`,
 * `anthropic_529`, `anthropic_timeout`), or `anthropic_error` when the error
 * carries no status (a dropped connection).
 */
function modelFailureCode(err) {
  try {
    const reason = require('../llm/call').providerErrorReason('anthropic', err);
    if (CODE_RE.test(reason) && reason.startsWith('anthropic_')) return reason;
  } catch { /* fall through to the generic code */ }
  return 'anthropic_error';
}

function failureSentence(code) {
  if (code === 'anthropic_timeout') return 'The AI model took too long to answer';
  if (code === 'anthropic_429' || code === 'anthropic_529' || code === 'anthropic_503') return 'The AI model is too busy to answer right now';
  return 'The AI model did not answer this request';
}

function clip(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line;
}

function listSummaries(receipts) {
  const names = receipts.map((r) => clip(r.summary) || r.tool).filter(Boolean);
  const shown = names.slice(0, MAX_SUMMARIES).join('; ');
  return names.length > MAX_SUMMARIES ? `${shown}; and ${names.length - MAX_SUMMARIES} more` : shown;
}

/**
 * What the task has already done, from its saved receipts. `receipts: null`
 * means the receipts could not be read, which is not the same as none.
 * Pure: the route passes the receipts in.
 */
function classifyReceipts(receipts) {
  if (!Array.isArray(receipts)) return { known: false, saved: [], unknown: [], waiting: [] };
  return {
    known: true,
    saved: receipts.filter((r) => SAVED_OUTCOMES.has(r.outcome)),
    unknown: receipts.filter((r) => r.outcome === UNKNOWN_OUTCOME),
    waiting: receipts.filter((r) => r.outcome === WAITING_OUTCOME),
  };
}

/** The task state that stays true after the failure. */
function taskStateFor(status) {
  if (!status.known) return 'outcome_unknown';
  if (status.waiting.length) return 'awaiting_approval';
  if (status.saved.length || status.unknown.length) return 'outcome_unknown';
  return 'failed';
}

/** The plain answer for the operator. */
function buildAnswer({ code, status }) {
  const parts = [`${failureSentence(code)} (error ${code}).`];
  if (!status.known) {
    parts.push('I could not check whether any change was saved. Look at the customer record or recent activity before you repeat the request.');
  } else if (status.saved.length || status.unknown.length) {
    if (status.saved.length) parts.push(`Before the error, this was already saved: ${listSummaries(status.saved)}.`);
    if (status.unknown.length) parts.push(`I cannot confirm whether this ran: ${listSummaries(status.unknown)}. Check it before you repeat it.`);
    parts.push('Do not repeat what was saved.');
  } else if (status.waiting.length) {
    parts.push('Nothing was changed. A confirmation card is still waiting for you, and nothing runs until you confirm it.');
  } else {
    // No saved receipt of any kind. Without a saved task (platform off) a write
    // only ever waits on a card, so this stays true there too.
    parts.push('Nothing was changed.');
  }
  parts.push('Try again in a few minutes.');
  return parts.join(' ');
}

/** Receipts for a saved task, or null when they cannot be read. */
async function readReceipts(taskId, actorId) {
  try {
    const rows = await PendingActions.forTask(taskId, actorId);
    return rows.map((row) => PendingActions.actionReceipt(row));
  } catch (err) {
    logger.warn(`[intelligence-bar] model failure receipts unreadable (code=${err?.code || 'unknown'})`);
    return null;
  }
}

/** One quiet gap row per error code. Returns { id, occurrences } or null. */
async function recordFailureGap(code) {
  try {
    const { writeGapRows } = require('../agent-gap-reports');
    const [saved] = await writeGapRows([{
      source: GAP_SOURCE,
      kind: 'blocked',
      code,
      summary: `The Intelligence Bar could not get an answer from the AI model (${code})`,
      attempted: 'The model call failed, so the operator got a plain notice. No request text is kept',
    }], undefined, { quiet: true });
    return saved ? { id: saved.id, occurrences: saved.occurrences } : null;
  } catch (err) {
    logger.warn(`[intelligence-bar] model failure gap not recorded (code=${err?.code || err?.name || 'error'})`);
    return null;
  }
}

/**
 * One admin bell, at most once an hour: a stable key with a rolling one-hour
 * window, so a second failure inside the hour finds the standing row and adds
 * nothing. Raised through raiseAdminAlert (docs/admin-notifications.md); the
 * error code is machine text, so it rides in `detail`, not the headline or why.
 * Admin-only; never a customer message.
 */
async function ringFailureBell({ code, gap }) {
  try {
    const { raiseAdminAlert } = require('../admin-alert-compose');
    const failures = gap?.occurrences
      ? `Questions fail until the AI model answers again; ${gap.occurrences} failure${gap.occurrences === 1 ? '' : 's'} recorded for this error.`
      : 'Questions fail until the AI model answers again.';
    const result = await raiseAdminAlert(BELL_CATEGORY, {
      area: 'System',
      action: 'check why the AI model is not answering',
      why: failures,
      severity: 'needs-you',
      link: BELL_LINK,
      subject: { type: 'check', id: 'ib-model-failure' },
      doneWhen: 'model_answers',
      who: 'person',
    }, {
      detail: `The Intelligence Bar model call failed with error ${code}. A spending limit, an expired key or a provider outage can cause this. `
        + `${gap?.id ? `Gap row ${gap.id} counts every failure with this code. ` : ''}This alert rings at most once an hour.`,
      bell: true,
      dedupeKey: BELL_DEDUPE_KEY,
      dedupeWindowMs: BELL_WINDOW_MS,
      metadata: { source: 'ib-model-failure', code, ...(gap?.id ? { gapId: gap.id } : {}) },
    });
    return Boolean(result) && !result.suppressed;
  } catch (err) {
    logger.warn(`[intelligence-bar] model failure bell not written (code=${err?.code || err?.name || 'error'})`);
    return false;
  }
}

/**
 * Everything the route needs after a model call failed. Never throws.
 * Returns { answer, taskState, code } (taskState null without a saved task).
 */
async function handleModelFailure({ err, activeTask, actorId }) {
  const code = modelFailureCode(err);
  const receipts = activeTask ? await readReceipts(activeTask.id, actorId) : [];
  const status = classifyReceipts(receipts);
  const gap = await recordFailureGap(code);
  await ringFailureBell({ code, gap });
  bellMayBeOpen = true;
  return {
    code,
    answer: buildAnswer({ code, status }),
    taskState: activeTask ? taskStateFor(status) : null,
    receiptsKnown: status.known,
  };
}

// The standing bell says "done when the model answers". The first successful
// model call after a failure (or after a restart, when this process cannot know)
// marks any open ib:model-failure row done. One query per failure, not per call.
let bellMayBeOpen = true;
async function closeFailureBellOnRecovery() {
  if (!bellMayBeOpen) return 0;
  bellMayBeOpen = false;
  try {
    const db = require('../../models/db');
    const rows = await db('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
      .whereRaw("metadata->>'dedupeKey' = ?", [BELL_DEDUPE_KEY]).select('id');
    if (!rows.length) return 0;
    const NotificationService = require('../notification-service');
    return await NotificationService.markAdminDone(rows.map((r) => r.id), {
      by: 'ib-model-recovered',
      resolution: 'The AI model answered again.',
    });
  } catch (err) {
    bellMayBeOpen = true;
    logger.warn(`[intelligence-bar] model failure bell not closed (code=${err?.code || err?.name || 'error'})`);
    return 0;
  }
}

module.exports = {
  tagModelCallError,
  isModelCallError,
  modelFailureCode,
  classifyReceipts,
  taskStateFor,
  buildAnswer,
  handleModelFailure,
  closeFailureBellOnRecovery,
  GAP_SOURCE,
  BELL_DEDUPE_KEY,
};
