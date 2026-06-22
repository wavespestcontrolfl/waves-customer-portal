/**
 * Statement-level dunning engine (Phase 2 — P4).
 *
 * The statement mirror of invoice-followups.js: when an unpaid NET-terms
 * statement passes its `due_date`, fire a terms-aware reminder chain
 * (due+0 / +15 / +30) to the payer's AP inbox — NEVER the homeowner. Email-only
 * (the statement bills AP; there is no homeowner contact in this lane).
 *
 * Eligibility is driven off the STATEMENT, not the followup row: a statement is
 * dunnable while `status IN (sent, viewed)` (delivered + owed, not yet paid and
 * not a payment-in-flight `processing`). `paid`/`void`/`processing` are excluded
 * by the status filter, so settling a statement stops its dunning even without an
 * explicit stop. `payer_statement_followups` is the per-step ledger + admin
 * pause/stop control; `runPending` self-heals (creates the row on first dun) so a
 * send that never armed a row can't silently skip dunning.
 *
 * `viewed` does NOT stop dunning — AP opening the pay link without paying is
 * exactly when we keep nudging (mirrors the invoice followups). Only paid / void /
 * processing pause it.
 *
 * Gated behind GATE_PAYER_STATEMENTS — `runPending` no-ops when off.
 * Config: server/config/payer-statement-followups.js. Design:
 * docs/design/payer-net-statements-plan.md (Dunning).
 */

const db = require('../models/db');
const logger = require('./logger');
const config = require('../config/payer-statement-followups');
const { isEnabled } = require('../config/feature-gates');
const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const { resolveApRecipient } = require('./payer-statement-email');
const { publicPortalUrl } = require('../utils/portal-url');
const { etParts, etDateString } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');

// Delivered + owed + not a payment-in-flight: a reminder may be sent. `finalized`
// (closed, not yet delivered to AP) is intentionally excluded — dun only what AP
// has actually received. `processing`/`paid`/`void` stop dunning.
const DUNNABLE_STATEMENT_STATUSES = ['sent', 'viewed'];
const TERM_LABEL = { net15: 'Net 15', net30: 'Net 30', due_on_receipt: 'Due on receipt' };

function currency(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Days between two 'YYYY-MM-DD' strings via UTC-midnight math (no DST drift).
function daysBetweenYmd(fromYmd, toYmd) {
  const [fy, fm, fd] = String(fromYmd).split('-').map(Number);
  const [ty, tm, td] = String(toYmd).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * The Date representing {hour}:00 America/New_York on the calendar day that is
 * {daysAfter} days past the 'YYYY-MM-DD' due date (measured in NY local time).
 * DST-safe — probes EDT/EST on the target day (mirrors invoice-followups).
 */
function anchorToHourET(ymd, daysAfter, hour) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + daysAfter);
  const yy = base.getUTCFullYear(), mm = base.getUTCMonth(), dd = base.getUTCDate();
  const probe = new Date(Date.UTC(yy, mm, dd, 12));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(probe).slice(-3); // "EDT" or "EST"
  const offsetHours = tzName === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(yy, mm, dd, hour + offsetHours));
}

function nextTouchAtFor(dueDate, stepIndex) {
  const step = config.steps[stepIndex];
  if (!step) return null;
  return anchorToHourET(dateOnlyString(dueDate), step.daysAfterDue, config.sendWindow.hour);
}

/**
 * Get (or create) the one sequence row for a statement. Idempotent — the
 * UNIQUE(statement_id) index resolves a concurrent-create race.
 */
async function getOrCreateSequence(statementId, payerId = null, { database = db } = {}) {
  const existing = await database('payer_statement_followups').where({ statement_id: statementId }).first();
  if (existing) return existing;
  try {
    const [row] = await database('payer_statement_followups')
      .insert({ statement_id: statementId, payer_id: payerId || null, status: 'active', step_index: 0 })
      .returning('*');
    return row;
  } catch (err) {
    const raced = await database('payer_statement_followups').where({ statement_id: statementId }).first();
    if (raced) return raced;
    throw err;
  }
}

async function markCompleted(seqId) {
  await db('payer_statement_followups').where({ id: seqId })
    .update({ status: 'completed', next_touch_at: null, updated_at: db.fn.now() });
}

/**
 * Render + send ONE dunning touch for a statement. Idempotency is per
 * (statement, step) so a step never double-mails even across overlapping ticks.
 */
async function sendFollowupEmail(stmt, step) {
  const { apEmail, company } = await resolveApRecipient(stmt, db);
  if (!apEmail) return { ok: false, reason: 'no_ap_email' };
  if (!sendgrid.isConfigured()) return { ok: false, reason: 'email_not_configured' };

  const statementNumber = `S-${stmt.id}`;
  const amount = currency(stmt.total);
  const dueYmd = dateOnlyString(stmt.due_date);
  const daysPastDue = Math.max(0, daysBetweenYmd(dueYmd, etDateString()));
  const payUrl = `${publicPortalUrl()}/pay/statement/${stmt.token}`;
  const reminderLine = String(step.reminderLine || '')
    .replace(/\{\{statement_number\}\}/g, statementNumber)
    .replace(/\{\{amount_due\}\}/g, amount)
    .replace(/\{\{days_past_due\}\}/g, String(daysPastDue));

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'payer.statement.followup',
      to: apEmail,
      payload: {
        company_name: company || 'Accounts Payable',
        statement_number: statementNumber,
        amount_due: amount,
        due_date: formatDateOnly(stmt.due_date, { fallback: '' }),
        days_past_due: String(daysPastDue),
        reminder_line: reminderLine,
        pay_url: payUrl,
        terms: TERM_LABEL[stmt.terms_snapshot] || stmt.terms_snapshot || '',
      },
      recipientType: 'payer',
      recipientId: stmt.payer_id || null,
      triggerEventId: `payer_statement_followup:${stmt.id}:${step.id}`,
      idempotencyKey: `payer_statement_followup:${stmt.id}:${step.id}`,
      categories: ['payer_statement_followup', step.id],
      suppressionGroupKey: 'transactional_required',
    });
    if (result?.deduped) return { ok: !!result.sent, deduped: true, blocked: !!result.blocked };
    if (result?.sent === false) return { ok: false, blocked: !!result.blocked, reason: result.reason || 'suppressed' };
    return { ok: true };
  } catch (err) {
    // Lost the idempotency race to a concurrent tick — another run is delivering
    // this exact step. Not a failure; advance without double-counting.
    if (err.code === 'EMAIL_SEND_IN_PROGRESS') return { ok: true, deduped: true };
    logger.error(`[payer-statement-followups] step ${step.id} email failed for S-${stmt.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Fire the `stepIndex` touch for one statement, authoritatively re-reading state
 * (TOCTOU vs a settle/void between the sweep and now). Advances the sequence on
 * success; pauses it on a hard delivery failure so the cron doesn't spin.
 */
async function fireStep(statementId, stepIndex) {
  const stmt = await db('payer_statements').where({ id: statementId }).first();
  if (!stmt || !DUNNABLE_STATEMENT_STATUSES.includes(stmt.status)) {
    // Settled / voided / went `processing` since the sweep — don't dun.
    return { fired: false, reason: 'not_dunnable' };
  }
  const seq = await getOrCreateSequence(stmt.id, stmt.payer_id);
  if (['paused', 'stopped', 'completed'].includes(seq.status)) return { fired: false, reason: seq.status };
  // A concurrent run already advanced past this step — don't re-fire it.
  if (seq.step_index !== stepIndex) return { fired: false, reason: 'step_advanced' };

  const step = config.steps[stepIndex];
  if (!step) { await markCompleted(seq.id); return { fired: false, reason: 'chain_exhausted' }; }

  const result = await sendFollowupEmail(stmt, step);
  if (!result.ok && !result.deduped) {
    await db('payer_statement_followups').where({ id: seq.id }).update({
      status: 'paused',
      paused_reason: result.reason || result.error || 'delivery_failed',
      next_touch_at: null,
      updated_at: db.fn.now(),
    });
    logger.warn(`[payer-statement-followups] paused S-${stmt.id} dunning — ${result.reason || result.error || 'delivery_failed'}`);
    return { fired: false, reason: result.reason || result.error || 'delivery_failed' };
  }

  const nextIndex = stepIndex + 1;
  const nextAt = nextTouchAtFor(stmt.due_date, nextIndex);
  await db('payer_statement_followups').where({ id: seq.id }).update({
    step_index: nextIndex,
    touches_sent: seq.touches_sent + (result.deduped ? 0 : 1),
    last_touch_at: db.fn.now(),
    next_touch_at: nextAt,
    status: nextAt ? 'active' : 'completed',
    updated_at: db.fn.now(),
  });
  logger.info(`[payer-statement-followups] S-${stmt.id} ${step.id} ${result.deduped ? 'deduped' : 'sent'} → step ${nextIndex}${nextAt ? '' : ' (chain complete)'}`);
  return { fired: !result.deduped, step: step.id };
}

/**
 * Cron entry point — fire every due touch. Driven off statements (self-healing):
 * any sent/viewed unpaid statement past its due date is considered, the sequence
 * row created on demand. One touch per statement per run (next tick fires the
 * next step), mirroring the invoice followups.
 */
async function runPending({ now = new Date() } = {}) {
  if (!isEnabled('payerStatements')) return { sent: 0, skipped: 0, skippedGate: true };

  // Double-guard the send window in ET (the cron schedule already enforces it).
  const dow = etParts(now).dayOfWeek;
  if (!config.sendWindow.daysOfWeek.includes(dow)) {
    logger.info('[payer-statement-followups] outside send window (day); skipping');
    return { sent: 0, skipped: 0 };
  }

  const today = etDateString(now);
  const rows = await db('payer_statements as s')
    .leftJoin('payer_statement_followups as f', 'f.statement_id', 's.id')
    .whereIn('s.status', DUNNABLE_STATEMENT_STATUSES)
    .whereNotNull('s.due_date')
    .where('s.due_date', '<=', today) // past due+0 (step 0 anchor)
    .select('s.id', 's.due_date', 'f.status as f_status', 'f.step_index as f_step_index');

  let sent = 0, skipped = 0;
  for (const row of rows) {
    // Admin override on an existing row halts the chain.
    if (['paused', 'stopped', 'completed'].includes(row.f_status)) { skipped++; continue; }
    const stepIndex = row.f_status ? row.f_step_index : 0;
    const step = config.steps[stepIndex];
    if (!step) { skipped++; continue; } // chain exhausted; fireStep would mark completed, but nothing to send

    // Is this step due yet? (query gives due+0; later steps gate on their offset.)
    const touchAt = anchorToHourET(dateOnlyString(row.due_date), step.daysAfterDue, config.sendWindow.hour);
    if (touchAt > now) { skipped++; continue; }

    try {
      const r = await fireStep(row.id, stepIndex);
      if (r.fired) sent++; else skipped++;
    } catch (err) {
      logger.error(`[payer-statement-followups] step fire failed for S-${row.id}: ${err.message}`);
      skipped++;
    }
  }
  logger.info(`[payer-statement-followups] runPending: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

/**
 * Called when a statement settles (paid) or is voided. The runPending status
 * filter already prevents firing once a statement leaves sent/viewed; this just
 * tidies the row so it isn't left `active`. Best-effort — never let a dunning
 * side-effect break settlement. Tolerates a missing table (pre-deploy / mocks).
 */
async function stopOnStatementSettled(statementId, { database = db } = {}) {
  try {
    await database('payer_statement_followups')
      .where({ statement_id: statementId })
      .whereIn('status', ['active', 'paused'])
      .update({ status: 'completed', next_touch_at: null, updated_at: database.fn.now() });
  } catch (err) {
    logger.warn(`[payer-statement-followups] stopOnStatementSettled failed for S-${statementId}: ${err.message}`);
  }
}

// --- Admin controls (mirror invoice-followups) ------------------------------

async function getSequenceForStatement(statementId) {
  const seq = await db('payer_statement_followups').where({ statement_id: statementId }).first();
  if (!seq) return null;
  const nextStep = config.steps[seq.step_index] || null;
  return { ...seq, next_step_id: nextStep?.id || null, next_step_label: nextStep?.label || null, total_steps: config.steps.length };
}

async function pauseSequence(statementId, { reason, until, adminId } = {}) {
  const stmt = await db('payer_statements').where({ id: statementId }).first();
  const seq = await getOrCreateSequence(statementId, stmt?.payer_id);
  await db('payer_statement_followups').where({ id: seq.id }).update({
    status: 'paused',
    paused_reason: reason || null,
    paused_until: until || null,
    paused_by_admin_id: adminId || null,
    next_touch_at: null,
    updated_at: db.fn.now(),
  });
}

async function resumeSequence(statementId) {
  const seq = await db('payer_statement_followups').where({ statement_id: statementId }).first();
  if (!seq) return;
  const stmt = await db('payer_statements').where({ id: statementId }).first();
  if (!stmt || !DUNNABLE_STATEMENT_STATUSES.includes(stmt.status)) return;
  await db('payer_statement_followups').where({ id: seq.id }).update({
    status: 'active',
    paused_reason: null,
    paused_until: null,
    paused_by_admin_id: null,
    next_touch_at: nextTouchAtFor(stmt.due_date, seq.step_index),
    updated_at: db.fn.now(),
  });
}

async function stopSequence(statementId, { reason, adminId } = {}) {
  const stmt = await db('payer_statements').where({ id: statementId }).first();
  const seq = await getOrCreateSequence(statementId, stmt?.payer_id);
  await db('payer_statement_followups').where({ id: seq.id }).update({
    status: 'stopped',
    stopped_reason: reason || null,
    stopped_by_admin_id: adminId || null,
    next_touch_at: null,
    updated_at: db.fn.now(),
  });
}

/**
 * Fire the current step right now, even before it's due — the operator override
 * ("push them today"). Re-activates a paused sequence first.
 */
async function sendNextStepNow(statementId) {
  if (!isEnabled('payerStatements')) return { ok: false, error: 'gate_off' };
  const stmt = await db('payer_statements').where({ id: statementId }).first();
  if (!stmt) return { ok: false, error: 'statement_not_found' };
  if (!DUNNABLE_STATEMENT_STATUSES.includes(stmt.status)) return { ok: false, error: `Statement not dunnable from '${stmt.status}'` };

  const seq = await getOrCreateSequence(stmt.id, stmt.payer_id);
  if (['stopped', 'completed'].includes(seq.status)) return { ok: false, error: `Sequence is ${seq.status}` };
  if (!config.steps[seq.step_index]) return { ok: false, error: 'No further reminders to send' };

  if (seq.status !== 'active') {
    await db('payer_statement_followups').where({ id: seq.id }).update({ status: 'active', updated_at: db.fn.now() });
  }
  const r = await fireStep(stmt.id, seq.step_index);
  if (r.fired || r.reason === undefined) return { ok: true, step: r.step };
  return { ok: false, error: r.reason };
}

module.exports = {
  runPending,
  fireStep,
  stopOnStatementSettled,
  getSequenceForStatement,
  getOrCreateSequence,
  pauseSequence,
  resumeSequence,
  stopSequence,
  sendNextStepNow,
  nextTouchAtFor,
  DUNNABLE_STATEMENT_STATUSES,
};
